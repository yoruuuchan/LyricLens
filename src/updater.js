(function initLyricLensUpdater(root) {
  "use strict";

  // Update channel — points at the Cloudflare Worker that fronts
  // GitHub Releases for this plugin (see cloudflare-worker/worker.js).
  // The Worker caches /latest.json for 10 min and serves a stable
  // /download 302 to the GitHub asset.
  const UPDATE_BASE = "https://lyriclens.yoru-and-akari.dev";
  const LATEST_URL = `${UPDATE_BASE}/latest.json`;
  const DOWNLOAD_URL = `${UPDATE_BASE}/download`;
  const CHANGELOG_URL = `${UPDATE_BASE}/changelog`;

  // BetterNCM 1.3.4 exposes fs.writeFile (PluginMarket pattern) but the
  // rename op only exists on betterncm_native.fs. Verified in Probe A,
  // see docs/roadmap/probe-a-updater.md.
  const PLUGIN_DIR = "./plugins/";
  const ASSET_NAME = "LyricLens.plugin";
  const TMP_ASSET_NAME = "LyricLens.plugin.download";

  const CHECK_TIMEOUT_MS = 10000;
  const DOWNLOAD_TIMEOUT_MS = 60000;

  // Compare two semver-ish strings like "0.1.0" / "0.2.10".
  // Returns -1 if a<b, 0 if equal, +1 if a>b. Treats missing
  // components as 0 and non-numeric as 0 too.
  function compareVersions(a, b) {
    const partsA = parseVersion(a);
    const partsB = parseVersion(b);
    const len = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < len; i += 1) {
      const av = partsA[i] || 0;
      const bv = partsB[i] || 0;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  }

  function parseVersion(value) {
    if (!value) return [];
    return String(value)
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((part) => {
        const n = Number(part);
        return Number.isFinite(n) ? n : 0;
      });
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    if (typeof AbortController === "undefined") {
      return root.fetch(url, options);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return root.fetch(url, { ...(options || {}), signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  // Hit the Cloudflare worker for { version, tag, changelog, ... }.
  // Returns { ok, payload, error } — never throws on network failure.
  async function fetchLatestMetadata() {
    try {
      const resp = await fetchWithTimeout(LATEST_URL, {
        headers: { "Accept": "application/json" },
        // Don't piggy-back on a cached negative response from the
        // browser, but allow the CF edge cache to do its job.
        cache: "default"
      }, CHECK_TIMEOUT_MS);
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}` };
      }
      const payload = await resp.json();
      if (!payload || typeof payload.version !== "string") {
        return { ok: false, error: "malformed payload" };
      }
      return { ok: true, payload };
    } catch (err) {
      const msg = err?.name === "AbortError" ? "timeout" : (err?.message || String(err));
      return { ok: false, error: msg };
    }
  }

  // High-level "is there a new version" check. Reads currentVersion
  // from manifest if not passed. Returns one of:
  //   { state: "current", current, latest }
  //   { state: "update-available", current, latest, payload }
  //   { state: "ahead", current, latest }     // user is on a beta/dev
  //   { state: "error", error }
  async function checkForUpdate(currentVersion) {
    const current = currentVersion || readPluginVersion();
    const result = await fetchLatestMetadata();
    if (!result.ok) return { state: "error", error: result.error };
    const latest = result.payload.version;
    const cmp = compareVersions(current, latest);
    if (cmp < 0) return { state: "update-available", current, latest, payload: result.payload };
    if (cmp > 0) return { state: "ahead", current, latest, payload: result.payload };
    return { state: "current", current, latest, payload: result.payload };
  }

  function readPluginVersion() {
    try {
      // BetterNCM injects `plugin` as a free variable, see main.js for
      // the typeof-guarded read pattern.
      if (typeof plugin !== "undefined" && plugin?.manifest?.version) {
        return String(plugin.manifest.version);
      }
    } catch (_) {}
    return "0.0.0";
  }

  // Download → checksum → atomic-replace flow. Each step reports
  // progress through onProgress(stage, info) so the UI can show
  // "下载中…" / "校验中…" / "替换中…". Returns { ok, error?, sizeBytes? }.
  async function downloadAndInstall(payload, callbacks = {}) {
    const onProgress = typeof callbacks.onProgress === "function" ? callbacks.onProgress : () => {};
    const fs = root.betterncm?.fs;
    const nativeFs = root.betterncm_native?.fs;
    if (!fs?.writeFile) {
      return { ok: false, error: "betterncm.fs.writeFile 不可用" };
    }

    onProgress("download-start", { url: DOWNLOAD_URL });
    let blob;
    let downloadedBytes = 0;
    try {
      const resp = await fetchWithTimeout(DOWNLOAD_URL, {
        // BetterNCM fetch defaults to follow; explicit for clarity since
        // the URL chain is /download → github.com → objects.githubusercontent
        redirect: "follow"
      }, DOWNLOAD_TIMEOUT_MS);
      if (!resp.ok) {
        return { ok: false, error: `下载失败 HTTP ${resp.status}` };
      }
      blob = await resp.blob();
      downloadedBytes = blob.size;
    } catch (err) {
      const msg = err?.name === "AbortError" ? "下载超时" : (err?.message || String(err));
      return { ok: false, error: msg };
    }

    onProgress("download-done", { bytes: downloadedBytes });

    // Sanity-check size against the manifest. .plugin files are tiny
    // (sub-MB), so anything <10 KB or >50 MB is almost certainly a
    // captive-portal HTML page or a bad upload.
    if (downloadedBytes < 10 * 1024) {
      return { ok: false, error: `下载内容过小（${downloadedBytes} bytes），可能是错误页` };
    }
    if (downloadedBytes > 50 * 1024 * 1024) {
      return { ok: false, error: `下载内容过大（${downloadedBytes} bytes），已中止` };
    }
    // Cross-check with the size in latest.json when available, with
    // ±5% tolerance for compression / asset differences.
    const expectedSize = Number(payload?.asset_size);
    if (Number.isFinite(expectedSize) && expectedSize > 0) {
      const drift = Math.abs(downloadedBytes - expectedSize) / expectedSize;
      if (drift > 0.05) {
        return {
          ok: false,
          error: `大小校验失败（下载 ${downloadedBytes} / 预期 ${expectedSize}）`
        };
      }
    }

    onProgress("verify-done", { bytes: downloadedBytes });

    // Atomic-ish replace: write to .plugin.download → remove old →
    // rename. If rename is missing (Probe A confirmed it's NOT on
    // betterncm.fs, only on betterncm_native.fs), we degrade to
    // writeFile-over-existing (also confirmed to work on BetterNCM 1.3.4).
    const tmpPath = PLUGIN_DIR + TMP_ASSET_NAME;
    const finalPath = PLUGIN_DIR + ASSET_NAME;

    onProgress("write-start", { path: tmpPath });
    try {
      await callMaybeAsync(fs.writeFile, fs, [tmpPath, blob]);
    } catch (err) {
      return { ok: false, error: `写入临时文件失败: ${err?.message || err}` };
    }

    if (typeof nativeFs?.rename === "function" && typeof nativeFs?.remove === "function") {
      // Best path: remove existing → rename tmp → final.
      try {
        const exists = await callMaybeAsync(fs.exists, fs, [finalPath]);
        if (exists) await callMaybeAsync(nativeFs.remove, nativeFs, [finalPath]);
      } catch (err) {
        // Removing a file Windows has open will fail. Fall through to
        // the writeFile-overwrite path below by leaving the tmp file
        // in place and reporting the error.
        try { await callMaybeAsync(fs.remove, fs, [tmpPath]); } catch (_) {}
        return {
          ok: false,
          error: `无法替换当前插件文件（可能被网易云占用，请重启后再试）: ${err?.message || err}`
        };
      }
      try {
        await callMaybeAsync(nativeFs.rename, nativeFs, [tmpPath, finalPath]);
      } catch (err) {
        return { ok: false, error: `重命名失败: ${err?.message || err}` };
      }
    } else {
      // Fallback: overwrite directly. Verified working in Probe A but
      // riskier on platforms with strict file locking.
      try {
        await callMaybeAsync(fs.writeFile, fs, [finalPath, blob]);
        try { await callMaybeAsync(fs.remove, fs, [tmpPath]); } catch (_) {}
      } catch (err) {
        return { ok: false, error: `覆盖写入失败: ${err?.message || err}` };
      }
    }

    onProgress("write-done", { path: finalPath, bytes: downloadedBytes });
    return { ok: true, sizeBytes: downloadedBytes };
  }

  // Triggered after install — asks BetterNCM to restart NCM. We don't
  // gate this; the UI presents it as a button the user must click
  // because a silent restart from a settings save would be hostile.
  function requestRestart() {
    const nativeApp = root.betterncm_native?.app;
    if (typeof nativeApp?.restart === "function") {
      try {
        nativeApp.restart();
        return { ok: true, method: "native.app.restart" };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
    return { ok: false, error: "restart API 不可用" };
  }

  async function callMaybeAsync(fn, ctx, args) {
    const result = fn.apply(ctx, args || []);
    if (result && typeof result.then === "function") return await result;
    return result;
  }

  // Minimal markdown → HTML for GitHub release bodies. Handles the
  // subset that actually appears in our changelogs: headings, lists,
  // inline code, bold/italic, links, paragraphs, horizontal rules.
  // Returns escaped-safe HTML — every user-controlled token passes
  // through escapeHtml before any tag goes in around it. We DO NOT
  // pull in a real markdown lib (extra weight + would be the only
  // dependency in the plugin).
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInline(line) {
    // Inline code first so its contents aren't re-formatted by other rules.
    let out = "";
    let i = 0;
    while (i < line.length) {
      const tickAt = line.indexOf("`", i);
      if (tickAt < 0) { out += renderInlineNonCode(line.slice(i)); break; }
      out += renderInlineNonCode(line.slice(i, tickAt));
      const close = line.indexOf("`", tickAt + 1);
      if (close < 0) { out += escapeHtml(line.slice(tickAt)); break; }
      out += `<code>${escapeHtml(line.slice(tickAt + 1, close))}</code>`;
      i = close + 1;
    }
    return out;
  }

  function renderInlineNonCode(text) {
    let s = escapeHtml(text);
    // Links — [label](url). url is rel="noopener noreferrer" target="_blank".
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
    );
    // Bold **text**, then italic *text*. Both non-greedy.
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
    return s;
  }

  function renderMarkdown(md) {
    if (!md) return "";
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let listType = null;       // "ul" | "ol" | null
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
        paragraph = [];
      }
    };
    const flushList = () => {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    };
    const openList = (type) => {
      if (listType !== type) { flushList(); out.push(`<${type}>`); listType = type; }
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (!line) { flushParagraph(); flushList(); continue; }

      // Headings — # / ## / ### only.
      const h = /^(#{1,3})\s+(.+)$/.exec(line);
      if (h) {
        flushParagraph(); flushList();
        out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`);
        continue;
      }

      // Horizontal rule — --- or ***
      if (/^(-{3,}|\*{3,})$/.test(line)) {
        flushParagraph(); flushList();
        out.push("<hr>");
        continue;
      }

      // Unordered list — - or *
      const ul = /^[-*]\s+(.+)$/.exec(line);
      if (ul) {
        flushParagraph();
        openList("ul");
        out.push(`<li>${renderInline(ul[1])}</li>`);
        continue;
      }

      // Ordered list — 1.
      const ol = /^\d+\.\s+(.+)$/.exec(line);
      if (ol) {
        flushParagraph();
        openList("ol");
        out.push(`<li>${renderInline(ol[1])}</li>`);
        continue;
      }

      flushList();
      paragraph.push(line);
    }
    flushParagraph(); flushList();
    return out.join("\n");
  }

  const api = {
    UPDATE_BASE,
    LATEST_URL,
    DOWNLOAD_URL,
    CHANGELOG_URL,
    compareVersions,
    parseVersion,
    fetchLatestMetadata,
    checkForUpdate,
    readPluginVersion,
    downloadAndInstall,
    requestRestart,
    renderMarkdown
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Updater = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

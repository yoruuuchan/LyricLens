(function initLyricLensDicts(root) {
  "use strict";

  /*
   * Reference-dictionary stores for the vocabulary badges (JLPT / 英语
   * 考试标签 / CEFR-J), mirroring the desktop host's dict_store.rs +
   * jlpt.rs / enexam.rs / cefrj.rs in plain browser JS.
   *
   * Data channel: manifest.json → sources[latest].gzip {url, sha256,
   * bytes} → fetch raw .json.gz bytes → sha256 verify (crypto.subtle,
   * skipped with a warning when unavailable) → DecompressionStream
   * ("gzip") → JSON.parse → in-memory Map.
   *
   * Why gzip and not the canonical .br blob: NCM's embedded Chromium 91
   * has no brotli decoder (DecompressionStream supports gzip/deflate
   * only), and the CDN serves blobs as raw bytes — no transparent
   * transport decompression. The desktop host keeps consuming .br.
   *
   * Failure semantics: any error (offline, missing gzip variant, sha
   * mismatch, decompress unavailable) leaves that family's store empty
   * — lookups return misses, no badge renders, the plugin otherwise
   * works. No persistent cache in the MVP: NCM is a long-lived process
   * and the three blobs total ~130 KB compressed per launch.
   */

  const FAMILIES = {
    jlpt: { manifestUrl: "https://dicts.yoru-and-akari.dev/jlpt/manifest.json" },
    enexam: { manifestUrl: "https://dicts.yoru-and-akari.dev/enexam/manifest.json" },
    cefrj: { manifestUrl: "https://dicts.yoru-and-akari.dev/cefrj/manifest.json" }
  };
  const FETCH_TIMEOUT_MS = 10000;
  // Structural sanity floor. Real payloads are 6.7k-8.1k entries; the
  // floor only guards against a truncated-but-parseable or empty
  // envelope being accepted as a working store.
  const MIN_ENTRIES = 100;

  const EXAM_TAG_LABELS = {
    gaokao: "高考",
    cet4: "CET-4",
    cet6: "CET-6",
    kaoyan: "考研"
  };
  const TARGET_EXAMS = ["off", "gaokao", "cet4", "cet6", "kaoyan"];

  const JLPT_BADGE_TITLE = "JLPT 参考等级 · 数据来自 Bluskyo / Tanos community list";
  const JLPT_BADGE_TITLE_AMBIGUOUS =
    "JLPT 参考等级 · surface 匹配 · reading 未确认 · 数据来自 Bluskyo / Tanos community list";
  const EXAM_BADGE_TITLE = "考试参考标签 · 社区词表交叉整理 · 非官方授权";
  const CEFRJ_BADGE_TITLE = "CEFR-J 参考等级 · 数据 © Tono Lab (TUFS)";

  // family → Map(entries) once bootstrapped; null while idle/failed.
  const stores = { jlpt: null, enexam: null, cefrj: null };
  // family → "idle" | "loading" | "ready" | "failed:<reason>"
  const status = { jlpt: "idle", enexam: "idle", cefrj: "idle" };

  function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
    if (typeof AbortController === "undefined") {
      return fetchImpl(url, options);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetchImpl(url, { ...(options || {}), signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async function sha256Hex(buffer) {
    const subtle = root.crypto?.subtle || (typeof crypto !== "undefined" ? crypto.subtle : null);
    if (!subtle?.digest) return null;
    const hash = await subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function decompressionStreamCtor() {
    if (typeof root.DecompressionStream === "function") return root.DecompressionStream;
    if (typeof DecompressionStream === "function") return DecompressionStream;
    return null;
  }

  async function gunzipToText(bytes) {
    const DS = decompressionStreamCtor();
    if (!DS) throw new Error("DecompressionStream 不可用（无法解压 gzip 词库）");
    const Res = root.Response || (typeof Response !== "undefined" ? Response : null);
    if (!Res) throw new Error("Response 不可用（无法解压 gzip 词库）");
    const stream = new Res(bytes).body.pipeThrough(new DS("gzip"));
    return new Res(stream).text();
  }

  async function bootstrapFamily(family, fetchImpl) {
    const { manifestUrl } = FAMILIES[family];
    const manifestResp = await fetchWithTimeout(
      fetchImpl,
      manifestUrl,
      { headers: { Accept: "application/json" } },
      FETCH_TIMEOUT_MS
    );
    if (!manifestResp.ok) throw new Error(`manifest ${manifestResp.status}`);
    const manifest = await manifestResp.json();
    const latest = manifest?.latest;
    const source = manifest?.sources?.[latest];
    if (!source) throw new Error("manifest 缺 latest source");
    const gz = source.gzip;
    if (!gz?.url) throw new Error("manifest 无 gzip 变体（KV 还没发布 .gz？）");

    const blobResp = await fetchWithTimeout(fetchImpl, gz.url, {}, FETCH_TIMEOUT_MS);
    if (!blobResp.ok) throw new Error(`blob ${blobResp.status}`);
    const compressed = await blobResp.arrayBuffer();
    if (Number.isFinite(Number(gz.bytes)) && compressed.byteLength !== Number(gz.bytes)) {
      throw new Error(`blob 长度不符：期望 ${gz.bytes}，实际 ${compressed.byteLength}`);
    }
    const observed = await sha256Hex(compressed);
    if (observed === null) {
      console.warn("[LyricLens:dicts]", family, "crypto.subtle 不可用，跳过 sha256 校验");
    } else if (typeof gz.sha256 === "string" && observed !== gz.sha256) {
      throw new Error(`blob sha256 不符：manifest=${gz.sha256} observed=${observed}`);
    }

    const text = await gunzipToText(compressed);
    const envelope = JSON.parse(text);
    if (envelope?.schema !== 1) throw new Error(`envelope schema=${envelope?.schema}，期望 1`);
    const entries = envelope.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error("envelope.entries 不是 object");
    }
    const map = new Map(Object.entries(entries));
    if (map.size < MIN_ENTRIES) throw new Error(`entries 只有 ${map.size} 条，疑似截断`);
    return map;
  }

  // Bootstrap all three families concurrently. Resolves when every
  // family has settled (each independently ready or failed) — callers
  // re-render badges in .then(). Never rejects.
  async function bootstrapAll(options = {}) {
    const fetchImpl = options.fetchImpl || ((...args) => root.fetch(...args));
    const families = Object.keys(FAMILIES);
    await Promise.all(families.map(async (family) => {
      if (status[family] === "loading" || status[family] === "ready") return;
      status[family] = "loading";
      try {
        stores[family] = await bootstrapFamily(family, fetchImpl);
        status[family] = "ready";
        console.log("[LyricLens:dicts]", family, `ready (${stores[family].size} entries)`);
      } catch (err) {
        stores[family] = null;
        status[family] = `failed:${err?.message || err}`;
        console.warn("[LyricLens:dicts]", family, "bootstrap 失败（badge 不渲染，其余功能不受影响）", err?.message || err);
      }
    }));
    return getDiagnostics();
  }

  // ── Lookups (synchronous, in-memory) ────────────────────────────
  //
  // A not-yet-ready store answers like a miss — the caller can't and
  // shouldn't distinguish "no data yet" from "word unknown".

  // Two-tier semantics ported from desktop jlpt.rs::lookup:
  //   surface+reading exact  → matching entries as stored ("source")
  //   surface only / reading misses → all candidates, confidence
  //     rewritten to "source-surface" when a reading was requested
  //   miss → []
  // JLPT keys are Japanese surfaces — no lowercase folding.
  function jlptLookup(surface, reading) {
    const store = stores.jlpt;
    const key = String(surface ?? "").trim();
    if (!store || !key) return [];
    const candidates = store.get(key);
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const r = String(reading ?? "").trim();
    if (r) {
      const matching = candidates.filter((e) => e && e.reading === r);
      if (matching.length > 0) return matching.map((e) => ({ ...e }));
      return candidates.map((e) => ({ ...e, confidence: "source-surface" }));
    }
    return candidates.map((e) => ({ ...e }));
  }

  function enexamLookup(word) {
    const store = stores.enexam;
    const key = String(word ?? "").trim().toLowerCase();
    if (!store || !key) return [];
    const tags = store.get(key);
    return Array.isArray(tags) ? tags.slice() : [];
  }

  function cefrjLookup(word) {
    const store = stores.cefrj;
    const key = String(word ?? "").trim().toLowerCase();
    if (!store || !key) return null;
    const level = store.get(key);
    return typeof level === "string" ? level : null;
  }

  // ── Badge label helpers (ported from desktop src/jlpt.ts) ───────

  // 一 level → "JLPT N5"; 多 level → "JLPT N3 / N4" (ascending); 零 → null.
  function formatJlptBadgeLabel(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const levels = Array.from(new Set(entries.map((e) => e.level)));
    levels.sort((a, b) => Number(String(a).slice(1)) - Number(String(b).slice(1)));
    return `JLPT ${levels.join(" / ")}`;
  }

  // "*" when any entry came back reading-unconfirmed; null otherwise.
  function jlptAmbiguityMarker(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    return entries.some((e) => e.confidence === "source-surface") ? "*" : null;
  }

  function getDiagnostics() {
    return {
      status: { ...status },
      sizes: {
        jlpt: stores.jlpt ? stores.jlpt.size : 0,
        enexam: stores.enexam ? stores.enexam.size : 0,
        cefrj: stores.cefrj ? stores.cefrj.size : 0
      }
    };
  }

  // Test hook: install prebuilt stores without the network path.
  function _setStoreForTest(family, entriesMap) {
    stores[family] = entriesMap;
    status[family] = entriesMap ? "ready" : "idle";
  }

  const api = {
    FAMILIES,
    EXAM_TAG_LABELS,
    TARGET_EXAMS,
    JLPT_BADGE_TITLE,
    JLPT_BADGE_TITLE_AMBIGUOUS,
    EXAM_BADGE_TITLE,
    CEFRJ_BADGE_TITLE,
    bootstrapAll,
    jlptLookup,
    enexamLookup,
    cefrjLookup,
    formatJlptBadgeLabel,
    jlptAmbiguityMarker,
    getDiagnostics,
    _setStoreForTest
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Dicts = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

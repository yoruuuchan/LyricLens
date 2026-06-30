/*
 * LyricLens distribution Worker
 *
 * Hosts the lyriclens.yoru-and-akari.dev surface:
 *
 *   GET /                 → landing page (links to GitHub, download)
 *   GET /download         → 302 to GitHub Release latest LyricLens.plugin
 *   GET /latest.json      → cached release metadata for in-plugin update check
 *   GET /changelog        → cached release body as plain text (optional)
 *   POST /feedback        → plugin feedback form relay via Resend
 *   GET /healthz          → 200 OK
 *
 * Cache strategy: latest.json is cached by Cloudflare edge for 10 min.
 * /download intentionally skips the API roundtrip — it relies on the
 * stable `LyricLens.plugin` asset name (we changed build-plugin.ps1
 * to drop the version from the filename for exactly this reason).
 *
 * Feedback relay needs Worker secrets/vars:
 * RESEND_API_KEY, FEEDBACK_TO, RESEND_FROM.
 * The plugin never receives FEEDBACK_TO.
 */

const REPO = "yoruuuchan/LyricLens";
const ASSET_NAME = "LyricLens.plugin";
const CACHE_TTL_SECONDS = 600;
const USER_AGENT = "LyricLens-Worker/0.1 (+https://lyriclens.yoru-and-akari.dev)";
const STATUS_BOARD_FEEDBACK_URL = "https://is-ai-down.yoru-and-akari.dev/api/feedback";

// Soft per-IP cap on /feedback so an open CORS endpoint can't be spammed to
// exhaust Resend / status-board forwarding quotas. The Dashboard-level Rate
// Limiting rule (5/min per IP) is the first line; this is a daily backstop.
// Requires KV namespace bound as FEEDBACK_RL — if absent, we degrade open and
// emit a console.warn so a missing binding shows up in `wrangler tail`.
const FEEDBACK_RL_DAILY_LIMIT = 20;
const FEEDBACK_RL_WINDOW_SECONDS = 86400;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/":
          return await landingResponse(ctx);
        case "/download":
        case "/download/":
          return await downloadResponse(env, ctx);
        case "/latest.json":
          return await latestJsonResponse(ctx);
        case "/changelog":
          return await changelogResponse(ctx);
        case "/feedback":
          if (request.method === "OPTIONS") return feedbackOptionsResponse();
          if (request.method === "POST") return await feedbackResponse(request, env);
          return new Response("Method not allowed", { status: 405, headers: textHeaders(0) });
        case "/healthz":
          return new Response("ok", { status: 200, headers: textHeaders() });
        case "/favicon.svg":
        case "/favicon.ico":
          return faviconResponse();
        case "/robots.txt":
          return new Response("User-agent: *\nDisallow:\n", { status: 200, headers: textHeaders() });
        default:
          if (url.pathname.startsWith("/assets/fonts/")) {
            return await fontProxyResponse(url.pathname.slice("/assets/fonts/".length), env, ctx);
          }
          return notFound();
      }
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "worker_failure", message: String(err?.message || err) }),
        { status: 500, headers: jsonHeaders(0) }
      );
    }
  },
};

function downloadRedirect() {
  // GitHub serves the latest release's asset by name at this URL — no API
  // call needed as long as we keep the asset name stable across releases.
  // Used as a fallback when the R2 proxy path can't resolve (no version
  // known, R2 binding missing, or upstream blob fetch fails).
  const target = `https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}`;
  return Response.redirect(target, 302);
}

// Primary /download handler — serves the .plugin through our edge so users
// in regions where GitHub Releases is slow/unreachable get a stable path.
// First request after a release hydrates R2; subsequent requests are pure
// R2 reads. Any breakage (no version, R2 down, upstream 5xx) silently
// falls back to the legacy 302, so users always get *some* download.
async function downloadResponse(env, ctx) {
  const latest = await fetchLatestPayloadSafe();
  if (!latest?.github_asset_url || !latest?.version) {
    return downloadRedirect();
  }
  try {
    return await assetProxy({
      env,
      ctx,
      r2Key: `releases/${latest.version}/${ASSET_NAME}`,
      upstreamUrl: latest.github_asset_url,
      contentType: "application/octet-stream",
      immutable: true,
      disposition: `attachment; filename="${ASSET_NAME}"`,
    });
  } catch (err) {
    try { console.warn("[LyricLens] /download R2 proxy failed, falling back to 302:", err?.message || err); } catch (_) {}
    return downloadRedirect();
  }
}

// Bump CACHE_REV after a release to invalidate edge cache without waiting
// out CACHE_TTL_SECONDS. cache.default keys on the full Request URL.
const CACHE_REV = "v8";

async function latestJsonResponse(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.lyriclens/latest.json?rev=${CACHE_REV}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const payload = await fetchLatestPayload();
  const status = payload.ok ? 200 : 502;
  const resp = new Response(JSON.stringify(payload.body, null, 2), {
    status,
    headers: jsonHeaders(payload.ok ? CACHE_TTL_SECONDS : 30),
  });
  // Only cache successful responses to avoid pinning a 502 for 10 min.
  if (payload.ok) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

async function changelogResponse(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.lyriclens/changelog?rev=${CACHE_REV}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const payload = await fetchLatestPayload();
  if (!payload.ok) {
    return new Response("upstream lookup failed", { status: 502, headers: textHeaders(30) });
  }
  const body = payload.body.changelog || "(no changelog)";
  const resp = new Response(body, { status: 200, headers: textHeaders(CACHE_TTL_SECONDS) });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

async function fetchLatestPayload() {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
  const upstream = await fetch(apiUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/vnd.github+json",
    },
    // Cloudflare will already cache by default; we also use our own cache layer
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  });

  if (!upstream.ok) {
    let detail = null;
    try { detail = (await upstream.text()).slice(0, 200); } catch (_) {}
    return {
      ok: false,
      body: { error: "github_api_failed", status: upstream.status, detail },
    };
  }

  const rel = await upstream.json();
  const asset = (rel.assets || []).find((a) => a.name === ASSET_NAME)
    || (rel.assets || []).find((a) => /\.plugin$/i.test(a.name));

  // Plain `version` strips the leading "v" so plugin code can do plain
  // semver compare (e.g. "0.2.0" > "0.1.0") without dealing with prefix.
  const tag = rel.tag_name || "";
  const version = tag.replace(/^v/i, "");

  return {
    ok: true,
    body: {
      version,
      tag,
      name: rel.name || tag,
      changelog: rel.body || "",
      published_at: rel.published_at,
      html_url: rel.html_url,
      // Always advertise the stable subdomain URL so old plugins that
      // hardcode this field will keep working even if we change the
      // GitHub fallback later.
      download_url: "https://lyriclens.yoru-and-akari.dev/download",
      github_asset_url: asset?.browser_download_url || null,
      asset_name: asset?.name || null,
      asset_size: asset?.size ?? null,
      asset_digest: asset?.digest || null,
    },
  };
}

async function landingResponse(ctx) {
  // Fan-out: README + latest release in parallel. Both have their own
  // edge-cache layers so most requests skip the upstream hop entirely.
  const [readme, latest] = await Promise.all([
    fetchReadmeParts(ctx),
    fetchLatestPayloadSafe(),
  ]);

  const versionTag = latest?.version ? `v${latest.version}` : "";
  const versionMeta = latest?.published_at
    ? `${versionTag} · ${formatPubDate(latest.published_at)} 发布`
    : "";

  const body = LANDING_HTML
    .replace("<!--HERO_SCREENS-->", readme.screenshotHtml || "")
    .replace("<!--README_HTML-->", readme.html || "")
    .replace("<!--VERSION_TAG-->", escapeHtml(versionTag))
    .replace("<!--VERSION_META-->", escapeHtml(versionMeta));

  return new Response(body, { status: 200, headers: htmlHeaders(60) });
}

// Wraps fetchLatestPayload so a failed GitHub call doesn't blow up the
// landing render — we just skip the version chip in that case.
async function fetchLatestPayloadSafe() {
  try {
    const payload = await fetchLatestPayload();
    return payload.ok ? payload.body : null;
  } catch (_) {
    return null;
  }
}

function formatPubDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch (_) {
    return "";
  }
}

async function fetchReadmeParts(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.lyriclens/readme-parts?rev=${CACHE_REV}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    try { return await cached.json(); } catch (_) {}
  }

  const upstream = await fetch(`https://api.github.com/repos/${REPO}/readme`, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/vnd.github.html",
    },
  });
  if (!upstream.ok) return { html: "", screenshotHtml: "" };
  let html = await upstream.text();

  // Rewrite relative URLs (screenshots, links) to absolute GitHub URLs so
  // they resolve when the README is served from our domain. Do this BEFORE
  // extracting the screenshot block — otherwise the extracted HTML would
  // still carry the relative paths.
  html = html.replace(
    /(src|href)="(?!https?:|#|\/\/|mailto:)([^"]+)"/g,
    `$1="https://raw.githubusercontent.com/${REPO}/main/$2"`
  );

  // Drop the language-switcher line at the very top — landing already
  // shows brand context elsewhere. GitHub's renderer wraps each heading
  // in <div class="markdown-heading"> and links in <a>; match the
  // rendered shape, not the raw markdown.
  html = html.replace(
    /<p[^>]*>(?:\s|<[^>]+>)*<a[^>]*>中文<\/a>[\s\S]*?<a[^>]*>English<\/a>[\s\S]*?<\/p>/,
    ""
  );
  html = html.replace(
    /<div class="markdown-heading"[^>]*>\s*<h1[^>]*>[\s\S]*?LyricLens[\s\S]*?<\/h1>[\s\S]*?<\/div>/i,
    ""
  );

  // Trim from "配置" section onward — API endpoint / API key / model name
  // is configuration the user can't act on before installing; let GitHub
  // README own those details so landing stays install-focused. Falls back
  // to "调试日志" in case "配置" gets renamed in a future README edit.
  for (const marker of ["配置", "调试日志"]) {
    const idx = html.indexOf(marker);
    if (idx <= 0) continue;
    const h2Start = html.lastIndexOf("<h2", idx);
    if (h2Start > 0) {
      const wrapperStart = html.lastIndexOf("<div class=\"markdown-heading\"", h2Start);
      const cut = wrapperStart > 0 ? wrapperStart : h2Start;
      html = html.slice(0, cut);
      break;
    }
  }

  // Extract the first <p align="center"> block (the screenshot strip) so
  // landing can render it inside the hero. The block is removed from the
  // README body to avoid showing it twice.
  let screenshotHtml = "";
  const screenshotMatch = html.match(/<p[^>]*align=["']center["'][^>]*>[\s\S]*?<\/p>/i);
  if (screenshotMatch) {
    screenshotHtml = screenshotMatch[0];
    html = html.replace(screenshotMatch[0], "");
  }

  const parts = { html, screenshotHtml };
  const resp = new Response(JSON.stringify(parts), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return parts;
}

async function feedbackResponse(request, env) {
  let payload = null;
  try {
    const json = await request.json();
    payload = json && typeof json === "object" ? json : null;
  } catch (_) {
    payload = null;
  }
  if (!payload) return feedbackJson({ error: "invalid_json" }, 400);
  if (normalizeText(payload._trap)) return feedbackJson({ ok: true }, 200);

  const message = normalizeText(payload.message);
  if (message.length < 5 || message.length > 10000) {
    return feedbackJson({ error: "invalid_message" }, 400);
  }

  const email = normalizeText(payload.email).toLowerCase();
  if (!isValidEmail(email)) {
    return feedbackJson({ error: "invalid_email" }, 400);
  }

  const feedbackTo = env.FEEDBACK_TO || env.FEEDBACK_TO_EMAIL;
  const resendFrom = env.RESEND_FROM || env.FEEDBACK_FROM_EMAIL;

  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  const ip = (request.headers.get("CF-Connecting-IP") || "").slice(0, 64);
  const userAgent = (request.headers.get("user-agent") || "").slice(0, 500);

  const rl = await checkFeedbackRateLimit(env, ip);
  if (!rl.ok) {
    return feedbackJson(
      { error: "rate_limited", message: `每个 IP 每天最多 ${rl.limit} 条反馈，已达上限` },
      429,
      { "retry-after": String(rl.retryAfter) }
    );
  }

  const html = renderFeedbackEmailHtml({ email, message, meta, ip, userAgent });

  if (!env.RESEND_API_KEY || !feedbackTo || !resendFrom) {
    return await forwardFeedbackToStatusBoard({ email, message, meta });
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resendFrom,
      to: feedbackTo,
      reply_to: email || undefined,
      subject: `[LyricLens 反馈] ${email || "anonymous"}`,
      html,
    }),
  });

  if (!resp.ok) return feedbackJson({ error: "email_failed" }, 502);
  return feedbackJson({ ok: true }, 200);
}

async function forwardFeedbackToStatusBoard({ email, message, meta }) {
  const forwardedMessage = [
    "[LyricLens feedback]",
    "",
    message,
    "",
    "---",
    `LyricLens: ${meta.version || "unknown"}`,
    `NCM: ${meta.ncmVersion || "unknown"}`,
    `BetterNCM: ${meta.betterNcmVersion || "unknown"}`,
    `Theme: ${meta.theme || "unknown"}`,
    `Font size: ${meta.fontSize || "unknown"}`,
  ].join("\n");
  const resp = await fetch(STATUS_BOARD_FEEDBACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      message: forwardedMessage,
      _trap: "",
    }),
  });
  if (!resp.ok) return feedbackJson({ error: "email_failed" }, 502);
  return feedbackJson({ ok: true }, 200);
}

function feedbackJson(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      ...(extraHeaders || {}),
    },
  });
}

// Per-day UTC bucket. KV is eventually consistent so a small burst can squeak
// past on the boundary — that's acceptable for a soft cap. Failures (KV
// unavailable, parse error) degrade open so a misconfigured binding never
// breaks the form for real users.
async function checkFeedbackRateLimit(env, ip) {
  const kv = env?.FEEDBACK_RL;
  if (!kv) {
    try { console.warn("[LyricLens] FEEDBACK_RL KV namespace not bound; /feedback is unrate-limited"); } catch (_) {}
    return { ok: true, skipped: true };
  }
  if (!ip) return { ok: true, skipped: true };

  const today = new Date().toISOString().slice(0, 10);
  const key = `feedback_rl:${ip}:${today}`;
  let current = 0;
  try {
    const raw = await kv.get(key);
    if (raw) current = Number.parseInt(raw, 10) || 0;
  } catch (err) {
    try { console.warn("[LyricLens] feedback rate-limit read failed:", err?.message || err); } catch (_) {}
    return { ok: true, skipped: true };
  }

  if (current >= FEEDBACK_RL_DAILY_LIMIT) {
    const nowSec = Math.floor(Date.now() / 1000);
    const tomorrowUtc = new Date();
    tomorrowUtc.setUTCHours(24, 0, 0, 0);
    const retryAfter = Math.max(60, Math.floor(tomorrowUtc.getTime() / 1000) - nowSec);
    return { ok: false, limit: FEEDBACK_RL_DAILY_LIMIT, count: current, retryAfter };
  }

  try {
    await kv.put(key, String(current + 1), { expirationTtl: FEEDBACK_RL_WINDOW_SECONDS });
  } catch (err) {
    try { console.warn("[LyricLens] feedback rate-limit write failed:", err?.message || err); } catch (_) {}
  }
  return { ok: true, limit: FEEDBACK_RL_DAILY_LIMIT, count: current + 1 };
}

function feedbackOptionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function renderFeedbackEmailHtml({ email, message, meta, ip, userAgent }) {
  const rows = [
    ["Contact", email || "(not provided)"],
    ["LyricLens", meta.version],
    ["NCM", meta.ncmVersion],
    ["BetterNCM", meta.betterNcmVersion],
    ["Theme", meta.theme],
    ["Font size", meta.fontSize],
    ["IP", ip],
    ["User-Agent", userAgent],
  ];
  const metaRows = rows
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value || "unknown")}</td></tr>`)
    .join("");
  return `<!doctype html>
<meta charset="utf-8">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#111827">
  <h2 style="margin:0 0 12px">LyricLens feedback</h2>
  <pre style="white-space:pre-wrap;background:#f3f4f6;border-radius:8px;padding:12px">${escapeHtml(message)}</pre>
  <table style="border-collapse:collapse;margin-top:16px;font-size:13px">${metaRows}</table>
</div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function notFound() {
  return new Response("Not found", { status: 404, headers: textHeaders() });
}

// Brand mark — lamp (akari, ember) overlapping night (yoru, primary).
// SVG so it stays crisp at any tab/bookmark size. Served from /favicon.svg
// and also /favicon.ico so browsers that probe the legacy path still hit it.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <radialGradient id="ll-lamp" cx="35%" cy="30%" r="75%">
      <stop offset="18%" stop-color="#FFD4B0"/>
      <stop offset="55%" stop-color="#FF9456"/>
      <stop offset="100%" stop-color="#F06A20"/>
    </radialGradient>
    <radialGradient id="ll-night" cx="32%" cy="30%" r="80%">
      <stop offset="0%" stop-color="#3D58D4"/>
      <stop offset="100%" stop-color="#2E44B0"/>
    </radialGradient>
  </defs>
  <circle cx="21" cy="16" r="10" fill="url(#ll-night)"/>
  <circle cx="22.5" cy="11" r="1.4" fill="#92A8FB" opacity="0.85"/>
  <circle cx="11" cy="16" r="10" fill="url(#ll-lamp)"/>
</svg>`;

function faviconResponse() {
  return new Response(FAVICON_SVG, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400, s-maxage=86400",
    },
  });
}

// Self-host the three webfonts the landing page uses. Key by a short
// filename so the public URL stays clean (/assets/fonts/geist-sans.woff2)
// and the upstream jsdelivr path is an implementation detail we can swap.
const FONT_UPSTREAM = {
  "geist-sans.woff2": "https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-sans/Geist-Variable.woff2",
  "geist-mono.woff2": "https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  "zen-kaku.woff2": "https://cdn.jsdelivr.net/npm/@fontsource/zen-kaku-gothic-new@5.0.13/files/zen-kaku-gothic-new-japanese-400-normal.woff2",
};

async function fontProxyResponse(filename, env, ctx) {
  const upstream = FONT_UPSTREAM[filename];
  if (!upstream) return notFound();
  try {
    return await assetProxy({
      env,
      ctx,
      r2Key: `fonts/${filename}`,
      upstreamUrl: upstream,
      contentType: "font/woff2",
      immutable: true,
    });
  } catch (err) {
    try { console.warn(`[LyricLens] font proxy failed for ${filename}:`, err?.message || err); } catch (_) {}
    return new Response(`font upstream unavailable`, { status: 502, headers: textHeaders(30) });
  }
}

// Generic R2-backed asset proxy: serve from R2 on hit, lazy-fetch from
// upstream + write-through to R2 on miss. Throws on upstream failure so
// the caller can decide how to fall back. R2 misuse (binding missing,
// get/put errors) degrades to a one-shot upstream fetch instead of
// failing the whole request — the landing page still loads.
async function assetProxy({ env, ctx, r2Key, upstreamUrl, contentType, immutable, disposition }) {
  const bucket = env?.R2_ASSETS;
  if (bucket) {
    try {
      const cached = await bucket.get(r2Key);
      if (cached) {
        return new Response(cached.body, {
          status: 200,
          headers: assetHeaders(contentType, immutable, disposition),
        });
      }
    } catch (err) {
      try { console.warn(`[LyricLens] R2 get failed for ${r2Key}:`, err?.message || err); } catch (_) {}
    }
  } else {
    try { console.warn(`[LyricLens] R2_ASSETS not bound; serving ${r2Key} direct from upstream`); } catch (_) {}
  }

  const upstream = await fetch(upstreamUrl, {
    headers: { "User-Agent": USER_AGENT, "Accept": "*/*" },
    cf: { cacheTtl: 3600, cacheEverything: true },
    redirect: "follow",
  });
  if (!upstream.ok) {
    throw new Error(`upstream ${upstream.status} for ${upstreamUrl}`);
  }
  const buf = await upstream.arrayBuffer();
  if (bucket) {
    ctx.waitUntil(
      bucket.put(r2Key, buf, { httpMetadata: { contentType } })
        .catch((err) => {
          try { console.warn(`[LyricLens] R2 put failed for ${r2Key}:`, err?.message || err); } catch (_) {}
        })
    );
  }
  return new Response(buf, {
    status: 200,
    headers: assetHeaders(contentType, immutable, disposition),
  });
}

function assetHeaders(contentType, immutable, disposition) {
  const headers = {
    "content-type": contentType,
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=86400",
    // Fonts and other cross-origin sub-resources need this when the consumer
    // sets crossorigin on the <link> / @font-face request.
    "access-control-allow-origin": "*",
  };
  if (disposition) headers["content-disposition"] = disposition;
  return headers;
}

function jsonHeaders(maxAge) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": `public, max-age=${Math.max(0, maxAge | 0)}, s-maxage=${Math.max(0, maxAge | 0)}`,
    "access-control-allow-origin": "*",
  };
}

function textHeaders(maxAge = 60) {
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    "access-control-allow-origin": "*",
  };
}

function htmlHeaders(maxAge = 60) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
  };
}

// Landing page styled with the yoru-and-akari Console Design System.
// Tokens, type, neumorphism + glass and lowercase voice all mirror
// the spec at D:\DESIGN\yoru-and-akari Console Design System.
// Themes: akari (light) by default, yoru (dark) via prefers-color-scheme.
const LANDING_HTML = `<!doctype html>
<html lang="zh-CN" data-theme="akari">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#E8ECF3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0B1020" media="(prefers-color-scheme: dark)">
<title>lyriclens · 灯と夜</title>
<meta name="description" content="把网易云每一句正在播放的歌词，变成一张外语学习卡片。词汇、语法、文化注释，跟着旋律一起停留。BetterNCM AI 歌词学习插件。">
<meta name="author" content="@yoruuuchan">
<link rel="canonical" href="https://lyriclens.yoru-and-akari.dev/">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="LyricLens">
<meta property="og:title" content="LyricLens · 灯と夜">
<meta property="og:description" content="把网易云每一句正在播放的歌词，变成一张外语学习卡片。词汇、语法、文化注释，跟着旋律一起停留。">
<meta property="og:url" content="https://lyriclens.yoru-and-akari.dev/">
<meta property="og:image" content="https://cdn.jsdelivr.net/gh/yoruuuchan/LyricLens@main/screenshots/lyric-ncm.png">
<meta property="og:image:alt" content="LyricLens 在网易云客户端中跟随歌词显示学习卡片的截图">
<meta property="og:locale" content="zh_CN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="LyricLens · 灯と夜">
<meta name="twitter:description" content="把网易云每一句正在播放的歌词，变成一张外语学习卡片。">
<meta name="twitter:image" content="https://cdn.jsdelivr.net/gh/yoruuuchan/LyricLens@main/screenshots/lyric-ncm.png">
<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/fonts/geist-sans.woff2">
<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/fonts/geist-mono.woff2">
<style>
  /* Fonts served from our R2 via the Worker's /assets/fonts/* proxy.
     First request after a deploy lazy-fetches from jsdelivr and writes
     through to R2; later requests are pure R2 reads. font-display: swap
     keeps the page readable while the woff2 arrives.

     Note: plain format("woff2") — the older format("woff2-variations")
     keyword is deprecated and some Chromium builds reject the whole src
     when they see it, leaving the @font-face silently dead. Variable
     glyphs still work fine inside a plain woff2 declaration. */
  @font-face {
    font-family: "Geist";
    src: url("/assets/fonts/geist-sans.woff2") format("woff2");
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "Geist Mono";
    src: url("/assets/fonts/geist-mono.woff2") format("woff2");
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "Zen Kaku Gothic New";
    src: url("/assets/fonts/zen-kaku.woff2") format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
</style>
<style>
  :root {
    --font-ui: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    /* CJK fallback appended so mono runs (release-meta, code, .ep paths)
       don't drop CJK glyphs into Windows' generic 'monospace' slot,
       which resolves to SimSun/宋体 and clashes with the YaHei used by
       sans runs. Cost: CJK in mono blocks loses tabular alignment, but
       it never had it to begin with (Geist Mono has no CJK). */
    --font-mono: "Geist Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace;
    --font-jp: "Zen Kaku Gothic New", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", system-ui, sans-serif;

    --radius-sm: 9px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-xl: 22px;
    --radius-pill: 999px;

    --dur-fast: 140ms;
    --dur-base: 220ms;
    --ease-out: cubic-bezier(0.22, 1, 0.36, 1);

    /* akari (light) — default */
    --bg-base: #E8ECF3;
    --bg-surface: #EFF2F8;
    --bg-elevated: #F6F8FC;
    --bg-sunken: #DEE3EC;
    --bg-tint: #F1F4FB;

    --ink-1: #0E1525;
    --ink-2: #394560;
    --ink-3: #6B7793;
    --ink-4: #A1ABBF;

    --line-1: rgba(14, 21, 37, 0.06);
    --line-2: rgba(14, 21, 37, 0.10);

    --primary-100: #DCE3FE;
    --primary-300: #92A8FB;
    --primary-500: #4F6CE8;
    --primary-600: #3D58D4;
    --primary-700: #2E44B0;

    --ember-300: #FF9456;
    --ember-500: #F06A20;

    --frost-300: #68C8C2;
    --frost-500: #1EA8A0;

    --neo-hi: rgba(255, 255, 255, 0.95);
    --neo-lo: rgba(143, 158, 191, 0.45);
    --neo-lo-soft: rgba(143, 158, 191, 0.28);

    --shadow-raised: -4px -4px 12px var(--neo-hi), 4px 4px 14px var(--neo-lo-soft);
    --shadow-lifted: -6px -6px 18px var(--neo-hi), 8px 8px 22px var(--neo-lo);
    --shadow-inset: inset 3px 3px 6px var(--neo-lo-soft), inset -3px -3px 6px var(--neo-hi);
    --shadow-pop: 0 10px 30px -8px rgba(20, 28, 51, 0.22), 0 2px 6px rgba(20,28,51,0.06);
    --shadow-focus: 0 0 0 3px rgba(79, 108, 232, 0.28);

    --glass-bg: hsla(220, 30%, 98%, 0.62);
    --glass-border: hsla(225, 30%, 55%, 0.18);

    --page-wash:
      radial-gradient(120% 80% at 80% -10%, rgba(79, 108, 232, 0.07), transparent 60%),
      radial-gradient(90% 70% at 0% 100%, rgba(240, 106, 32, 0.05), transparent 55%),
      var(--bg-base);
  }

  [data-theme="yoru"] {
      --bg-base: #0B1020;
      --bg-surface: #131A2E;
      --bg-elevated: #1B2340;
      --bg-sunken: #080D1B;
      --bg-tint: #182146;

      --ink-1: #E6EAF6;
      --ink-2: #A8B2CC;
      --ink-3: #6B7691;
      --ink-4: #434D67;

      --line-1: rgba(255, 255, 255, 0.06);
      --line-2: rgba(255, 255, 255, 0.10);

      --primary-100: #1F2A55;
      --primary-300: #3D52AE;
      --primary-500: #7A95FA;
      --primary-600: #93A9FB;
      --primary-700: #B4C3FC;

      --ember-300: #804418;
      --ember-500: #F07830;

      --frost-300: #186060;
      --frost-500: #38C8C0;

      --neo-hi: rgba(255, 255, 255, 0.05);
      --neo-lo: rgba(0, 0, 0, 0.55);
      --neo-lo-soft: rgba(0, 0, 0, 0.35);

      --shadow-raised: -3px -3px 10px var(--neo-hi), 5px 5px 16px var(--neo-lo-soft);
      --shadow-lifted: -4px -4px 14px var(--neo-hi), 8px 8px 24px var(--neo-lo);
      --shadow-inset: inset 3px 3px 7px var(--neo-lo-soft), inset -2px -2px 5px var(--neo-hi);
      --shadow-pop: 0 14px 36px -10px rgba(0,0,0,0.6), 0 2px 6px rgba(0,0,0,0.4);
      --shadow-focus: 0 0 0 3px rgba(122, 149, 250, 0.35);

      --glass-bg: hsla(225, 35%, 14%, 0.62);
      --glass-border: hsla(220, 40%, 70%, 0.10);

      --page-wash:
        radial-gradient(120% 80% at 80% -10%, rgba(122, 149, 250, 0.10), transparent 60%),
        radial-gradient(90% 70% at 0% 100%, rgba(240, 120, 48, 0.06), transparent 55%),
        var(--bg-base);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-ui);
    font-size: 16px;
    line-height: 1.6;
    color: var(--ink-2);
    background: var(--page-wash);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }

  /* Theme transition. Targeted properties so existing transitions on
     .btn / .arrow / .theme-toggle keep their own timings. Disabled
     under prefers-reduced-motion. */
  @media (prefers-reduced-motion: no-preference) {
    html, body, .group, .ep, .status-pill,
    .endpoints-section, footer, .readme-content,
    .readme-content blockquote, .readme-content pre, .readme-content code,
    .preqs, .release-meta {
      transition-property: background-color, color, border-color, box-shadow;
      transition-duration: var(--dur-base);
      transition-timing-function: var(--ease-out);
    }
  }

  body::before {
    content: "";
    position: fixed; inset: 0;
    pointer-events: none;
    background: var(--page-wash);
    z-index: -1;
  }

  ::selection { background: var(--primary-100); color: var(--primary-700); }

  a { color: inherit; text-decoration: none; }
  a:focus-visible { outline: none; box-shadow: var(--shadow-focus); border-radius: 6px; }

  main {
    max-width: 1080px;
    margin: 0 auto;
    padding: 88px 40px 96px;
  }

  /* Brand row */
  .brand {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 56px;
  }
  .mark {
    position: relative;
    width: 44px; height: 24px;
    flex-shrink: 0;
  }
  .mark .lamp,
  .mark .night {
    position: absolute; top: 0;
    width: 24px; height: 24px;
    border-radius: 50%;
  }
  .mark .lamp {
    left: 0; z-index: 2;
    background: radial-gradient(circle at 35% 30%, #FFD4B0 0 18%, #FF9456 50%, var(--ember-500) 100%);
    box-shadow: 0 0 18px rgba(240, 106, 32, 0.45),
                inset -2px -3px 5px rgba(192, 80, 21, 0.30);
  }
  .mark .night {
    right: 0; z-index: 1;
    background: radial-gradient(circle at 70% 28%, var(--primary-300) 0 8%, transparent 14%),
                radial-gradient(circle at 32% 30%, var(--primary-700) 0 55%, var(--primary-700) 90%);
    box-shadow: inset -3px -3px 6px rgba(0, 0, 0, 0.28),
                inset 2px 2px 5px rgba(122, 149, 250, 0.25);
  }
  .wm {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.012em;
    color: var(--ink-1);
    display: flex; align-items: baseline; gap: 4px;
  }
  .wm .sep { opacity: 0.35; font-weight: 400; transform: translateY(-1px); }
  .wm .a { color: var(--ember-500); }
  .wm .b { color: var(--primary-500); }

  /* Hero */
  .hero { margin-bottom: 72px; max-width: 760px; }
  .hero .eyebrow {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--ink-3);
    margin-bottom: 22px;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .hero .eyebrow .dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--frost-500);
    box-shadow: 0 0 8px rgba(30, 168, 160, 0.6);
  }
  .hero h1 {
    font-size: 72px;
    line-height: 1.05;
    letter-spacing: -0.020em;
    font-weight: 600;
    color: var(--ink-1);
    margin: 0 0 22px;
  }
  .hero h1 .jp {
    font-family: var(--font-jp);
    font-weight: 500;
    font-size: 0.55em;
    color: var(--ink-3);
    margin-left: 18px;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .hero p {
    font-size: 21px;
    line-height: 1.6;
    color: var(--ink-2);
    margin: 0 0 36px;
    max-width: 620px;
    /* Let the browser pick a more balanced break point so lines don't
       end up wildly uneven (e.g. first line ~29 CJK chars, second ~12).
       Chrome 117+ / Safari 17.4+. Older browsers fall back to default
       greedy wrapping — no breakage. */
    text-wrap: pretty;
  }

  /* Actions */
  .actions {
    display: flex; gap: 10px; flex-wrap: wrap;
  }
  .btn {
    height: 48px; padding: 0 22px;
    border: none; border-radius: var(--radius-md);
    font-family: var(--font-ui); font-size: 15px; font-weight: 500;
    display: inline-flex; align-items: center; gap: 8px;
    cursor: pointer;
    transition: transform var(--dur-fast) var(--ease-out),
                box-shadow var(--dur-fast) var(--ease-out),
                background var(--dur-fast) var(--ease-out);
  }
  .btn:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
  .btn.primary {
    background: var(--primary-500); color: #fff;
    box-shadow: 0 4px 12px rgba(79, 108, 232, 0.30),
                inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }
  [data-theme="yoru"] .btn.primary { color: var(--bg-base); box-shadow: 0 4px 14px rgba(122, 149, 250, 0.35); }
  .btn.primary:hover { transform: translateY(-1px); }
  .btn.primary:active { transform: scale(0.985); box-shadow: var(--shadow-inset); }

  .btn.secondary {
    background: var(--bg-surface); color: var(--ink-1);
    box-shadow: var(--shadow-raised);
  }
  .btn.secondary:hover { box-shadow: var(--shadow-lifted); }
  .btn.secondary:active { box-shadow: var(--shadow-inset); transform: scale(0.985); }

  .btn .arrow {
    width: 14px; height: 14px; opacity: 0.85;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .btn:hover .arrow { transform: translateX(2px); }

  /* Sections */
  section { margin-top: 36px; }
  .group {
    background: var(--bg-surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-raised);
    overflow: hidden;
  }
  .grp-h {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--ink-3);
    padding: 18px 22px 10px;
    display: flex; align-items: center; gap: 8px;
  }
  .grp-h .jp {
    font-family: var(--font-jp);
    font-size: 11px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink-4);
  }

  .row {
    display: flex; align-items: flex-start; gap: 14px;
    padding: 12px 18px;
    min-height: 48px;
  }
  .row + .row { border-top: 1px solid var(--line-1); }
  .row .num {
    width: 22px; height: 22px;
    border-radius: var(--radius-sm);
    background: var(--primary-100);
    color: var(--primary-700);
    font-family: var(--font-mono);
    font-size: 11px; font-weight: 600;
    display: grid; place-items: center;
    flex-shrink: 0; margin-top: 1px;
  }
  .row .body { flex: 1; min-width: 0; }
  .row .body .t {
    font-size: 14.5px; font-weight: 500;
    color: var(--ink-1);
    margin-bottom: 3px;
  }
  .row .body .s {
    font-size: 13.5px;
    color: var(--ink-3);
    line-height: 1.55;
  }
  .row .body .s a {
    color: var(--primary-500);
    border-bottom: 1px solid var(--primary-300);
    padding-bottom: 1px;
  }
  .row .body .s a:hover { color: var(--primary-600); }

  code, .mono {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-sunken);
    color: var(--ink-2);
    padding: 2px 7px;
    border-radius: 6px;
    box-shadow: var(--shadow-inset);
  }

  /* Version chip inside the download button — small, mono, slightly
     dimmed against the primary fill so the verb stays the focal point. */
  .btn-version {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 500;
    opacity: 0.85;
    margin-left: 4px;
  }
  .btn-version:empty { display: none; }

  /* Release timestamp under the action row, paired with version chip. */
  .release-meta {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-3);
    letter-spacing: 0.04em;
    margin: 14px 0 0;
    min-height: 1.2em;
  }
  .release-meta:empty { display: none; }

  /* "前置：需要先装 BetterNCM" hint under the action row. */
  .preqs {
    font-size: 13px;
    color: var(--ink-3);
    margin: 10px 0 0;
  }
  .preqs a {
    color: var(--primary-500);
    border-bottom: 1px solid var(--primary-300);
    padding-bottom: 1px;
  }
  .preqs a:hover { color: var(--primary-600); }

  /* Hero screenshots — lifted out of the README so the first scroll
     shows the product, not the install steps. Grid + flex via the
     same <p align="center"> CSS that the README content uses. */
  .hero-screens {
    margin-top: 48px;
    margin-bottom: 24px;
  }
  .hero-screens p[align="center"] {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: flex-start;
    margin: 0;
  }
  .hero-screens p[align="center"] > * {
    flex: 1 1 320px;
    min-width: 0;
    line-height: 0;
  }
  .hero-screens img {
    max-width: 100%;
    height: auto;
    width: 100%;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    display: block;
  }
  .hero-screens:empty { display: none; }

  /* Endpoints — developer-facing, collapsed by default via <details>. */
  .endpoints-section { margin-top: 96px; }
  .endpoints-section > summary {
    cursor: pointer;
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
  }
  .endpoints-section > summary::-webkit-details-marker { display: none; }
  .endpoints-section > summary::after {
    content: "";
    width: 10px;
    height: 10px;
    border-right: 2px solid var(--ink-3);
    border-bottom: 2px solid var(--ink-3);
    transform: rotate(-45deg);
    transition: transform var(--dur-base) var(--ease-out);
  }
  .endpoints-section[open] > summary::after { transform: rotate(45deg); }
  .endpoints-section > .endpoints { margin-top: 24px; }
  .section-title {
    font-size: 40px;
    font-weight: 600;
    color: var(--ink-1);
    line-height: 1.2;
    letter-spacing: -0.022em;
    margin: 0;
  }
  .section-title .jp {
    font-family: var(--font-jp);
    font-weight: 500;
    font-size: 0.5em;
    color: var(--ink-3);
    margin-left: 14px;
    letter-spacing: 0;
  }
  .endpoints {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
  }
  .ep {
    display: flex; flex-direction: column; gap: 6px;
    padding: 14px 14px 14px 14px;
    background: var(--bg-elevated);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-inset);
    font-family: var(--font-mono);
    font-size: 13px;
    min-height: 86px;
  }
  .ep .verb {
    font-size: 10px; font-weight: 600;
    color: var(--frost-500);
    letter-spacing: 0.10em;
    text-transform: uppercase;
  }
  .ep .path { color: var(--ink-1); font-weight: 500; font-size: 14px; overflow-wrap: anywhere; }
  .ep .note { color: var(--ink-3); font-family: var(--font-ui); font-size: 12px; margin-top: auto; }

  /* Status pill */
  .status-pill {
    margin-top: 28px;
    display: inline-flex; align-items: center; gap: 10px;
    padding: 9px 16px;
    background: var(--glass-bg);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-pill);
    font-size: 13px;
    color: var(--ink-2);
  }
  .status-pill .dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--frost-500);
    box-shadow: 0 0 6px var(--frost-500);
    animation: breathe 2.6s var(--ease-out) infinite;
  }
  @keyframes breathe {
    0%, 100% { opacity: 0.55; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.15); }
  }
  .status-pill .mono { background: transparent; box-shadow: none; padding: 0; }

  /* Footer */
  footer {
    margin-top: 56px;
    padding-top: 24px;
    border-top: 1px solid var(--line-1);
    display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
    font-size: 12.5px;
    color: var(--ink-3);
  }
  footer .sep { color: var(--ink-4); }
  footer a:hover { color: var(--ink-2); }
  footer .jp {
    font-family: var(--font-jp);
    color: var(--ink-4);
    letter-spacing: 0;
  }

  /* Floating theme toggle — fixed top-right, neumorphic pill */
  .theme-toggle {
    position: fixed;
    top: 24px;
    right: 24px;
    width: 42px;
    height: 42px;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--bg-surface);
    color: var(--ink-1);
    box-shadow: var(--shadow-raised);
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
    z-index: 100;
  }
  .theme-toggle:hover { box-shadow: var(--shadow-lifted); transform: translateY(-1px); }
  .theme-toggle:active { transform: scale(0.94); box-shadow: var(--shadow-inset); }
  .theme-toggle:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
  .theme-toggle svg { width: 18px; height: 18px; }
  .theme-toggle .icon-sun { display: none; }
  .theme-toggle .icon-moon { display: block; }
  [data-theme="yoru"] .theme-toggle .icon-sun { display: block; }
  [data-theme="yoru"] .theme-toggle .icon-moon { display: none; }

  /* GitHub README content rendered through the worker — no card chrome.
     Treat each ## heading as a product-page section separated by space.
     Live mirror — changes on README.md flow through in ~10 min. */
  .readme { margin-top: 96px; }
  .readme-content {
    color: var(--ink-2);
    font-size: 17px;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }
  .readme-content > *:first-child { margin-top: 0; }
  .readme-content > *:last-child { margin-bottom: 0; }
  .readme-content h1,
  .readme-content h2,
  .readme-content h3 {
    color: var(--ink-1);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.015em;
  }
  .readme-content h1 { display: none; }
  .readme-content h2 {
    font-size: 40px;
    margin: 112px 0 24px;
    letter-spacing: -0.022em;
  }
  .readme-content > .markdown-heading:first-of-type h2,
  .readme-content > h2:first-of-type { margin-top: 0; }
  .readme-content h3 {
    font-size: 22px;
    margin: 40px 0 14px;
    color: var(--ink-1);
  }
  .readme-content p {
    margin: 0 0 16px;
  }
  .readme-content > p:first-of-type {
    font-size: 19px;
    line-height: 1.65;
    color: var(--ink-2);
  }
  .readme-content p { margin: 0 0 12px; }
  .readme-content a {
    color: var(--primary-500);
    border-bottom: 1px solid var(--primary-300);
    padding-bottom: 1px;
    transition: color var(--dur-fast) var(--ease-out);
  }
  .readme-content a:hover { color: var(--primary-600); }
  .readme-content ul,
  .readme-content ol { margin: 0 0 14px; padding-left: 22px; }
  .readme-content li { margin-bottom: 4px; }
  .readme-content code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--bg-sunken);
    color: var(--ink-1);
    padding: 2px 6px;
    border-radius: 5px;
    box-shadow: var(--shadow-inset);
  }
  .readme-content pre {
    background: var(--bg-sunken);
    border-radius: var(--radius-md);
    padding: 14px 16px;
    overflow-x: auto;
    box-shadow: var(--shadow-inset);
    margin: 0 0 14px;
  }
  .readme-content pre code {
    background: transparent;
    padding: 0;
    box-shadow: none;
    font-size: 13.5px;
    color: var(--ink-1);
  }
  .readme-content blockquote {
    margin: 0 0 14px;
    padding: 8px 14px;
    border-left: 3px solid var(--primary-300);
    background: var(--bg-tint);
    color: var(--ink-3);
    border-radius: 0 8px 8px 0;
  }
  .readme-content blockquote p:last-child { margin-bottom: 0; }
  .readme-content img {
    max-width: 100%;
    height: auto;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    display: block;
  }
  /* Screenshot row — README uses <p align="center"> with multiple <img>.
     GitHub wraps each <img> in an <a target="_blank">, so the flex
     items are the <a>s, not the <img>s. */
  .readme-content p[align="center"] {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: flex-start;
    margin: 20px 0 32px;
  }
  .readme-content p[align="center"] > * {
    flex: 1 1 280px;
    min-width: 0;
    margin: 0;
    border-bottom: 0;
    padding: 0;
  }
  .readme-content p[align="center"] img {
    width: 100%;
    display: block;
    margin: 0;
  }
  .readme-content p[align="center"] a {
    line-height: 0;
  }
  .readme-content ol li,
  .readme-content ul li { margin-bottom: 8px; }
  .readme-content hr {
    border: 0;
    border-top: 1px solid var(--line-1);
    margin: 24px 0;
  }
  .readme-content table {
    border-collapse: collapse;
    margin: 0 0 14px;
    font-size: 14px;
  }
  .readme-content th,
  .readme-content td {
    padding: 8px 12px;
    border: 1px solid var(--line-2);
    text-align: left;
  }
  .readme-content th { background: var(--bg-sunken); color: var(--ink-1); }
  .readme-content .anchor,
  .readme-content .octicon { display: none; }

  /* Responsive — design-system mobile-first sizing */
  @media (max-width: 900px) {
    main { padding: 56px 24px 72px; }
    .hero h1 { font-size: 56px; }
    .hero h1 .jp { font-size: 0.5em; margin-left: 12px; }
    .hero p { font-size: 18px; }
    .readme { margin-top: 72px; }
    .readme-content { font-size: 16px; }
    .readme-content h2 { font-size: 32px; margin: 80px 0 18px; }
    .readme-content h3 { font-size: 20px; margin: 32px 0 12px; }
    .readme-content > p:first-of-type { font-size: 18px; }
  }
  @media (max-width: 540px) {
    main { padding: 40px 18px 64px; }
    .hero h1 { font-size: 42px; }
    .hero h1 .jp { display: block; margin-left: 0; margin-top: 8px; font-size: 18px; }
    .hero p { font-size: 16px; }
    .btn { height: 44px; font-size: 14px; }
    .row { padding: 14px 16px; }
    .theme-toggle { top: 16px; right: 16px; width: 38px; height: 38px; }
    .readme { margin-top: 56px; }
    .readme-content { font-size: 15px; }
    .readme-content h2 { font-size: 26px; margin: 64px 0 16px; }
    .readme-content h3 { font-size: 18px; margin: 28px 0 10px; }
    .readme-content > p:first-of-type { font-size: 16px; }
  }
</style>
<script>
  // Resolve theme before paint to avoid FOUC. Reads localStorage first,
  // falls back to OS preference. JS is invoked from the head before body
  // parses; if blocked, the default akari in <html data-theme="akari"> wins.
  (function() {
    try {
      var k = "lyriclens-theme";
      var saved = localStorage.getItem(k);
      var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = saved || (dark ? "yoru" : "akari");
    } catch (_) {}
  })();
</script>
</head>
<body>
<button type="button" class="theme-toggle" aria-label="切换主题">
  <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4"></circle>
    <line x1="12" y1="2" x2="12" y2="5"></line>
    <line x1="12" y1="19" x2="12" y2="22"></line>
    <line x1="2" y1="12" x2="5" y2="12"></line>
    <line x1="19" y1="12" x2="22" y2="12"></line>
    <line x1="4.93" y1="4.93" x2="7.05" y2="7.05"></line>
    <line x1="16.95" y1="16.95" x2="19.07" y2="19.07"></line>
    <line x1="4.93" y1="19.07" x2="7.05" y2="16.95"></line>
    <line x1="16.95" y1="7.05" x2="19.07" y2="4.93"></line>
  </svg>
  <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
  </svg>
</button>

<main>
  <section class="hero">
    <div class="eyebrow"><span class="dot"></span>plugin · betterncm</div>
    <h1>lyriclens<span class="jp" lang="ja">歌詞のレンズ</span></h1>
    <p>把网易云每一句正在播放的歌词，变成一张外语学习卡片。词汇、语法、文化注释，跟着旋律一起停留。</p>

    <div class="actions">
      <a class="btn primary" href="/download">
        <span>下载最新版 <span class="btn-version"><!--VERSION_TAG--></span></span>
        <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      </a>
      <a class="btn secondary" href="https://github.com/yoruuuchan/LyricLens" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>
        </svg>
        <span>github</span>
      </a>
    </div>

    <p class="release-meta"><!--VERSION_META--></p>

    <p class="preqs">前置：需要先装 <a href="https://github.com/MicroCBer/BetterNCM" target="_blank" rel="noopener">BetterNCM</a>，再装本插件。</p>

    <div class="status-pill" role="status" aria-label="服务运行中">
      <span class="dot" aria-hidden="true"></span>
      <span aria-hidden="true">service</span>
      <span class="mono" aria-hidden="true">lyriclens.yoru-and-akari.dev</span>
    </div>
  </section>

  <section class="hero-screens" aria-label="插件截图"><!--HERO_SCREENS--></section>

  <section class="readme">
    <article class="readme-content"><!--README_HTML--></article>
  </section>

  <details class="endpoints-section">
    <summary class="section-title">endpoints <span class="jp" lang="ja">· 開発者向け</span></summary>
    <div class="endpoints">
      <div class="ep"><span class="verb">get</span><span class="path">/download</span><span class="note">302 → github release</span></div>
      <div class="ep"><span class="verb">get</span><span class="path">/latest.json</span><span class="note">version · changelog · size · digest</span></div>
      <div class="ep"><span class="verb">get</span><span class="path">/changelog</span><span class="note">text · markdown</span></div>
      <div class="ep"><span class="verb">get</span><span class="path">/healthz</span><span class="note">ok</span></div>
    </div>
  </details>

  <footer>
    <span>maintained by <a href="https://github.com/yoruuuchan" target="_blank" rel="noopener">@yoruuuchan</a></span>
    <span class="sep">·</span>
    <a href="https://github.com/yoruuuchan/LyricLens/issues" target="_blank" rel="noopener">反馈 / issues</a>
    <span class="sep">·</span>
    <a href="https://github.com/yoruuuchan/LyricLens/blob/main/README.md" target="_blank" rel="noopener">完整 readme</a>
  </footer>
</main>
<script>
  // Click handler — toggles data-theme between akari and yoru, persists
  // the choice, and keeps the toggle button's aria-label in sync with
  // what action it will perform next.
  (function() {
    var btn = document.querySelector(".theme-toggle");
    if (!btn) return;
    function syncLabel() {
      var current = document.documentElement.dataset.theme;
      btn.setAttribute("aria-label", current === "yoru" ? "切换到浅色主题" : "切换到深色主题");
    }
    syncLabel();
    btn.addEventListener("click", function() {
      var root = document.documentElement;
      var next = root.dataset.theme === "akari" ? "yoru" : "akari";
      root.dataset.theme = next;
      try { localStorage.setItem("lyriclens-theme", next); } catch (_) {}
      syncLabel();
    });
  })();
</script>
</body>
</html>`;

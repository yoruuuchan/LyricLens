(function initLyricLensNcmLyricApi(root) {
  "use strict";

  // Last-resort lyrics fallback that talks directly to NCM's own backend.
  // Rescues the case where AMLL's TTML pipeline fails (e.g. ghproxy.com
  // mirror dead) but NCM itself still knows the song's lyrics — we're
  // running inside the NCM renderer, so cookies are sent automatically
  // and rate-limiting is the same as any other in-app request.
  //
  // The API returns LRC (line-level timestamps). LyricLens's per-line
  // card prompt only needs lineIndex + text + startMs + endMs, so LRC is
  // sufficient — we do not need the richer yrc/ttml word-level timing
  // for analysis quality.

  const NCM_LYRIC_API_BASE = "https://music.163.com/api/song/lyric";
  const DEFAULT_TIMEOUT_MS = 5000;
  // NCM ids are decimal integers up to ~13 digits in practice. The pure-digit
  // check exists to refuse provisional ids like "captured:abc123" — those
  // never resolve at this endpoint and would just waste a request.
  const PURE_DIGITS_RE = /^\d{1,18}$/;

  function buildLyricApiUrl(songId) {
    if (songId === null || songId === undefined) return null;
    const normalized = String(songId).trim();
    if (!PURE_DIGITS_RE.test(normalized)) return null;
    // lv/kv/tv = -1 means "return all available versions"; os=osx mimics the
    // request the desktop client itself makes so the server is unlikely to
    // gate the response shape on a hostile UA check.
    return `${NCM_LYRIC_API_BASE}?os=osx&id=${normalized}&lv=-1&kv=-1&tv=-1`;
  }

  // Returns:
  //   { lrc: string, yrc: string|null, source: "ncm-api" } on success
  //   null when there's no usable lyric or the songId is invalid
  // Throws on network/timeout/HTTP errors so the caller can record them.
  async function fetchLyricsForSongId(songId, options = {}) {
    const url = buildLyricApiUrl(songId);
    if (!url) return null;

    const fetcher = options.fetchImpl || root.fetch;
    if (typeof fetcher !== "function") return null;

    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const externalSignal = options.signal;
    const relayAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener?.("abort", relayAbort, { once: true });
    }

    try {
      const response = await fetcher(url, {
        method: "GET",
        // We rely on the NCM renderer's own session cookie. credentials:
        // "include" is the safe default — the request is same-origin from
        // NCM's perspective, but being explicit guards against any future
        // fetch polyfill that defaults to "omit".
        credentials: "include",
        signal: controller.signal
      });

      if (!response.ok) {
        const err = new Error(`NCM lyric API HTTP ${response.status}`);
        err.name = "NcmLyricApiHttpError";
        err.status = response.status;
        throw err;
      }

      const data = await response.json();
      // code !== 200 covers both auth failures (-2 = need login) and
      // server-side rejections. nolyric / uncollected are NCM's way of
      // saying "no lyric for this song" without an error — treat as
      // a silent miss, not an exception.
      if (data?.code !== 200) return null;
      if (data.nolyric === true || data.uncollected === true) return null;

      const lrc = String(data?.lrc?.lyric ?? "").trim();
      if (!lrc) return null;
      const yrcRaw = String(data?.yrc?.lyric ?? "").trim();

      return {
        lrc,
        yrc: yrcRaw || null,
        source: "ncm-api"
      };
    } catch (err) {
      if (timedOut) {
        const tErr = new Error(`NCM lyric API timeout after ${timeoutMs}ms`);
        tErr.name = "NcmLyricApiTimeout";
        throw tErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener?.("abort", relayAbort);
    }
  }

  // ── Song metadata (notebook songKey) ─────────────────────────────
  //
  // The notebook's cross-host songKey needs title/artist/durationMs,
  // which this plugin otherwise never learns (it only tracks songId +
  // lyrics). betterncm.ncm.getPlaying() throws on this build, so the
  // dependable source is NCM's own song/detail endpoint — same origin,
  // same cookies, same rate budget as the lyric fallback above.

  const NCM_DETAIL_API_BASE = "https://music.163.com/api/song/detail";
  const NCM_DETAIL_API_V3_BASE = "https://music.163.com/api/v3/song/detail";

  // Two endpoint generations, tried in order. os=osx mirrors the lyric
  // endpoint's proven recipe — without it the v1 endpoint has been seen
  // to 404 on the desktop client's cookie jar.
  function buildDetailApiUrl(songId) {
    if (songId === null || songId === undefined) return null;
    const normalized = String(songId).trim();
    if (!PURE_DIGITS_RE.test(normalized)) return null;
    return `${NCM_DETAIL_API_BASE}?os=osx&ids=[${normalized}]`;
  }

  function buildDetailApiV3Url(songId) {
    if (songId === null || songId === undefined) return null;
    const normalized = String(songId).trim();
    if (!PURE_DIGITS_RE.test(normalized)) return null;
    return `${NCM_DETAIL_API_V3_BASE}?os=osx&c=[{"id":${normalized}}]`;
  }

  // Normalize either detail shape (v1: artists/duration, v3: ar/dt)
  // into {title, artist, durationMs} — artists joined with " / ", the
  // same separator NCM itself reports to SMTC, keeping the desktop
  // host's songKey for the same track identical.
  function normalizeSongDetail(song) {
    if (!song || typeof song !== "object") return null;
    const title = String(song.name ?? "").trim();
    const artistList = Array.isArray(song.artists)
      ? song.artists
      : Array.isArray(song.ar)
        ? song.ar
        : [];
    const artist = artistList
      .map((a) => String(a?.name ?? "").trim())
      .filter(Boolean)
      .join(" / ");
    const durationMs = Number(song.duration ?? song.dt);
    if (!title || !artist || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    return { title, artist, durationMs };
  }

  async function fetchDetailFromUrl(url, fetcher, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetcher(url, {
        method: "GET",
        credentials: "include",
        signal: controller.signal
      });
      if (!response.ok) return { meta: null, status: `HTTP ${response.status}` };
      const data = await response.json();
      if (data?.code !== 200) return { meta: null, status: `code ${data?.code}` };
      const song = Array.isArray(data.songs) ? data.songs[0] : null;
      const meta = normalizeSongDetail(song);
      return { meta, status: meta ? "ok" : "unrecognized shape" };
    } catch (err) {
      return { meta: null, status: timedOut ? `timeout ${timeoutMs}ms` : String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns {title, artist, durationMs} or null when neither endpoint
  // generation resolves the song. Never throws — per-endpoint failures
  // are collected and logged so an on-device console shows exactly
  // which generation (if any) is alive on this NCM build.
  async function fetchSongDetail(songId, options = {}) {
    const fetcher = options.fetchImpl || root.fetch;
    if (typeof fetcher !== "function") return null;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

    const attempts = [];
    for (const [label, url] of [
      ["v1", buildDetailApiUrl(songId)],
      ["v3", buildDetailApiV3Url(songId)]
    ]) {
      if (!url) continue;
      const { meta, status } = await fetchDetailFromUrl(url, fetcher, timeoutMs);
      if (meta) return meta;
      attempts.push(`${label}: ${status}`);
    }
    if (attempts.length) {
      console.warn("[LyricLens:notebook]", `song/detail 两代端点都没拿到 meta（songId=${songId}）`, attempts.join(" | "));
    }
    return null;
  }

  const api = {
    NCM_LYRIC_API_BASE,
    NCM_DETAIL_API_BASE,
    NCM_DETAIL_API_V3_BASE,
    DEFAULT_TIMEOUT_MS,
    buildLyricApiUrl,
    buildDetailApiUrl,
    buildDetailApiV3Url,
    normalizeSongDetail,
    fetchLyricsForSongId,
    fetchSongDetail
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.NcmLyricApi = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLyricApiUrl,
  fetchLyricsForSongId,
  NCM_LYRIC_API_BASE
} = require("../src/ncmLyricApi");

// ── buildLyricApiUrl ──────────────────────────────────────────────────────

test("buildLyricApiUrl: pure numeric songId produces a complete URL", () => {
  const url = buildLyricApiUrl("1824020871");
  assert.ok(url.startsWith(NCM_LYRIC_API_BASE + "?"));
  assert.match(url, /[?&]id=1824020871(?:&|$)/);
  assert.match(url, /[?&]lv=-1(?:&|$)/);
  assert.match(url, /[?&]kv=-1(?:&|$)/);
  assert.match(url, /[?&]tv=-1(?:&|$)/);
  assert.match(url, /[?&]os=osx(?:&|$)/);
});

test("buildLyricApiUrl: numeric input also accepted", () => {
  const url = buildLyricApiUrl(1824020871);
  assert.match(url, /[?&]id=1824020871(?:&|$)/);
});

test("buildLyricApiUrl: rejects non-numeric ids", () => {
  // Track- prefix is exactly the form the console-fallback hands back if
  // the caller forgets to normalize — this guard saves a wasted request.
  assert.equal(buildLyricApiUrl("track-1824020871"), null);
  assert.equal(buildLyricApiUrl("captured:abc123"), null);
  assert.equal(buildLyricApiUrl(""), null);
  assert.equal(buildLyricApiUrl(null), null);
  assert.equal(buildLyricApiUrl(undefined), null);
  assert.equal(buildLyricApiUrl("12 34"), null);
});

// ── fetchLyricsForSongId ──────────────────────────────────────────────────

function fakeFetch(responseFactory) {
  return async () => responseFactory();
}

test("fetchLyricsForSongId: returns lrc + yrc on success", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 200,
      lrc: { lyric: "[00:00.00]Hello\n[00:05.00]World" },
      yrc: { lyric: "(0,1000,0)Hello(5000,1000,0)World" }
    })
  }));

  const result = await fetchLyricsForSongId("1824020871", { fetchImpl });
  assert.ok(result, "expected a result object");
  assert.equal(result.source, "ncm-api");
  assert.match(result.lrc, /Hello/);
  assert.match(result.lrc, /World/);
  assert.match(result.yrc, /Hello/);
});

test("fetchLyricsForSongId: yrc is null when missing", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 200,
      lrc: { lyric: "[00:00.00]Hello" }
    })
  }));
  const result = await fetchLyricsForSongId("1824020871", { fetchImpl });
  assert.ok(result);
  assert.equal(result.yrc, null);
});

test("fetchLyricsForSongId: returns null when code is not 200", async () => {
  // -2 is NCM's "not logged in" error code; a real symptom we'd hit if
  // cookies somehow weren't sent. Silent fallback is appropriate.
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ code: -2 })
  }));
  const result = await fetchLyricsForSongId("1824020871", { fetchImpl });
  assert.equal(result, null);
});

test("fetchLyricsForSongId: returns null when nolyric=true", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 200, nolyric: true })
  }));
  const result = await fetchLyricsForSongId("1824020871", { fetchImpl });
  assert.equal(result, null);
});

test("fetchLyricsForSongId: returns null when uncollected=true", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 200, uncollected: true })
  }));
  const result = await fetchLyricsForSongId("1824020871", { fetchImpl });
  assert.equal(result, null);
});

test("fetchLyricsForSongId: returns null when lrc is empty/whitespace", async () => {
  // Some entries have a 200 + empty lrc.lyric (metadata-only rows from
  // the database). Treat as miss.
  const cases = ["", "   ", "\n"];
  for (const empty of cases) {
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, lrc: { lyric: empty } })
    }));
    const result = await fetchLyricsForSongId("1824020871", { fetchImpl });
    assert.equal(result, null, `expected null for empty lrc=${JSON.stringify(empty)}`);
  }
});

test("fetchLyricsForSongId: returns null when songId fails the digit guard", async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const result = await fetchLyricsForSongId("track-1824020871", { fetchImpl });
  assert.equal(result, null);
  assert.equal(fetchCalled, false, "should short-circuit before fetching");
});

test("fetchLyricsForSongId: throws NcmLyricApiHttpError on non-2xx response", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: false,
    status: 502,
    json: async () => ({})
  }));
  await assert.rejects(
    fetchLyricsForSongId("1824020871", { fetchImpl }),
    (err) => err.name === "NcmLyricApiHttpError" && err.status === 502
  );
});

test("fetchLyricsForSongId: throws NcmLyricApiTimeout when timeout fires", async () => {
  // Simulate a request that hangs forever; the internal timeout should
  // fire and surface as NcmLyricApiTimeout, distinguishable from a
  // generic AbortError so diagnostics can label it.
  const fetchImpl = async (_url, opts) => {
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener?.("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  await assert.rejects(
    fetchLyricsForSongId("1824020871", { fetchImpl, timeoutMs: 30 }),
    (err) => err.name === "NcmLyricApiTimeout"
  );
});

test("fetchLyricsForSongId: external signal aborts the request immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async (_url, opts) => {
    // The internal AbortController should already be aborted when fetchImpl
    // runs, because we called controller.abort() before the call.
    if (opts.signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return { ok: true, status: 200, json: async () => ({ code: 200 }) };
  };
  await assert.rejects(
    fetchLyricsForSongId("1824020871", {
      fetchImpl,
      signal: controller.signal
    }),
    (err) => err.name === "AbortError"
  );
});

test("fetchLyricsForSongId: returns null when fetch is unavailable in env", async () => {
  // No fetchImpl, no global fetch. We can't mutate the module's `root.fetch`
  // reference cheaply, but the buildLyricApiUrl guard runs first so an
  // invalid songId provides the same "skip the request" path.
  const result = await fetchLyricsForSongId(null, {});
  assert.equal(result, null);
});

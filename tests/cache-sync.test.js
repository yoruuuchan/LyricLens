const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCacheKey, createMemoryCache, hashString } = require("../src/cache");
const {
  extractSongId,
  extractSongIdOnly,
  extractSongIdFromArgs,
  findCurrentLineIndex,
  getCurrentPlaybackMs,
  normalizeProgressMs,
  selectCardByPlaybackTime,
  startSongMonitor
} = require("../src/sync");

test("builds cache key with endpoint hash and prompt version", () => {
  const keyA = buildCacheKey({
    songId: 123,
    lyricsHash: "abc",
    apiEndpoint: "https://example.com/v1/chat/completions",
    modelName: "model-a",
    promptVersion: "v1"
  });
  const keyB = buildCacheKey({
    songId: 123,
    lyricsHash: "abc",
    apiEndpoint: "https://another.example/v1/chat/completions",
    modelName: "model-a",
    promptVersion: "v1"
  });

  assert.notEqual(keyA, keyB);
  assert.match(keyA, /^123:abc:[a-z0-9]+:model-a:v1$/);
  assert.equal(hashString("same"), hashString("same"));
});

test("memory cache stores and reuses values by key", () => {
  const cache = createMemoryCache();
  cache.set("a", [1]);
  assert.deepEqual(cache.get("a"), [1]);
  cache.clear();
  assert.equal(cache.get("a"), undefined);
});

test("finds current lyric line by ms time range", () => {
  const lines = [
    { index: 10, text: "A", startTime: 1000, endTime: 2500 },
    { index: 15, text: "B", startTime: 2500, endTime: 4000 }
  ];

  assert.equal(findCurrentLineIndex(lines, 1000), 10);
  assert.equal(findCurrentLineIndex(lines, 3000), 15);
  assert.equal(findCurrentLineIndex(lines, 900), null);
});

test("selectCardByPlaybackTime returns first card before the first start time", () => {
  const cards = [
    { index: 1, startMs: 1000, endMs: 2000 },
    { index: 2, startMs: 2000, endMs: 3000 }
  ];

  assert.equal(selectCardByPlaybackTime(0, cards), 0);
});

test("selectCardByPlaybackTime returns card whose start/end contains current time", () => {
  const cards = [
    { index: 1, startMs: 1000, endMs: 2000 },
    { index: 2, startMs: 2000, endMs: 3000 },
    { index: 3, startMs: 3000, endMs: 4000 }
  ];

  assert.equal(selectCardByPlaybackTime(2500, cards), 1);
});

test("selectCardByPlaybackTime returns last card after final line", () => {
  const cards = [
    { index: 1, startMs: 1000, endMs: 2000 },
    { index: 2, startMs: 2000, endMs: 3000 }
  ];

  assert.equal(selectCardByPlaybackTime(9999, cards), 1);
});

test("selectCardByPlaybackTime uses next start as boundary when endMs is missing", () => {
  const cards = [
    { index: 1, startMs: 1000 },
    { index: 2, startMs: 3000 },
    { index: 3, startMs: 5000 }
  ];

  assert.equal(selectCardByPlaybackTime(2500, cards), 0);
  assert.equal(selectCardByPlaybackTime(3500, cards), 1);
});

test("selectCardByPlaybackTime keeps last card active when last endMs is missing", () => {
  const cards = [
    { lineIndex: 0, startMs: 0, endMs: 1000 },
    { lineIndex: 1, startMs: 1000 }
  ];

  assert.equal(selectCardByPlaybackTime(60 * 60 * 1000, cards), 1);
});

test("normalizes PlayProgress seconds to milliseconds", () => {
  assert.equal(normalizeProgressMs(["ignored", 12.5]), 12500);
  assert.equal(normalizeProgressMs([42000]), 42000);
});

test("normalizes PlayProgress second argument already in milliseconds", () => {
  assert.equal(normalizeProgressMs(["ignored", 42000]), 42000);
  assert.equal(normalizeProgressMs(["ignored", 9950]), 9950);
});

test("normalizes PlayProgress object payloads", () => {
  assert.equal(normalizeProgressMs([{ timeMs: 12345 }]), 12345);
  assert.equal(normalizeProgressMs([{ data: { currentTime: 12.5 } }]), 12500);
  assert.equal(normalizeProgressMs(["ignored", { payload: { progressMs: 9950 } }]), 9950);
});

test("normalizes PlayProgress array and JSON payloads", () => {
  assert.equal(normalizeProgressMs([[{ currentMs: 3210 }]]), 3210);
  assert.equal(normalizeProgressMs(['{"data":{"progress":12.5}}']), 12500);
  assert.equal(normalizeProgressMs(["progress:12.5"]), null);
});

test("getCurrentPlaybackMs reads DOM audio currentTime as milliseconds", () => {
  const root = {
    document: {
      querySelector(selector) {
        return selector === "audio" ? { currentTime: 12.345 } : null;
      }
    }
  };

  assert.equal(getCurrentPlaybackMs(root), 12345);
});

test("getCurrentPlaybackMs returns null when no DOM audio time exists", () => {
  const root = { document: { querySelector: () => null } };

  assert.equal(getCurrentPlaybackMs(root), null);
});

test("extracts songId from PlayState string args without getPlaying", () => {
  assert.equal(extractSongIdOnly("2083872223_TMKOVI"), "2083872223");
  assert.equal(extractSongIdOnly("2083872223|pause|NPWP9B"), "2083872223");
  assert.equal(extractSongIdFromArgs(["2083872223_TMKOVI", "2083872223|pause|NPWP9B", 2]), "2083872223");
});

test("PlayState callback writes songId and args to diagnostics without getPlaying", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    legacyNativeCmder: globalThis.legacyNativeCmder
  };
  let callback = null;
  const state = {};
  const diagnostics = {
    recordPlayStateArgs(args, parsed) {
      state.lastPlayStateArgs = Array.from(args);
      state.playStateStatus = parsed.playStateStatus;
      state.playbackStatus = parsed.playbackStatus;
      state.songId = parsed.songId;
    },
    log() {}
  };
  globalThis.LyricLens = {
    Diagnostics: {
      safeAppendRegisterCall(_root, eventName, targetName, cb) {
        assert.equal(eventName, "PlayState");
        assert.equal(targetName, "audioplayer");
        callback = cb;
        return { ok: true };
      },
      safeGetPlaying() {
        return { ok: false, error: "not available" };
      },
      safeGetPlayingSong() {
        return { ok: true, value: null };
      }
    }
  };

  try {
    let observedSongId = null;
    const stop = startSongMonitor((songId) => {
      observedSongId = songId;
    }, null, diagnostics);
    callback("2083872223_TMKOVI", "2083872223|pause|NPWP9B", 2);
    stop();

    assert.equal(observedSongId, "2083872223");
    assert.equal(state.songId, "2083872223");
    assert.equal(state.playbackStatus, "pause");
    assert.deepEqual(state.lastPlayStateArgs, ["2083872223_TMKOVI", "2083872223|pause|NPWP9B", 2]);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.legacyNativeCmder = previous.legacyNativeCmder;
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDiagnostics,
  safeSample,
  sampleLyricsPayload,
  safeInvoke,
  safeGetPlaying,
  safeGetPlayingSong
} = require("../src/diagnostics");

test("safeSample truncates long strings and object fields", () => {
  const sample = safeSample({
    lyric: "a".repeat(300),
    nested: { text: "b".repeat(300) }
  }, { maxString: 24, maxDepth: 2 });

  assert.equal(sample.lyric.length <= 40, true);
  assert.match(sample.lyric, /…/);
  assert.match(sample.nested.text, /…/);
});

test("safeInvoke returns a unified error result without throwing", () => {
  const result = safeInvoke("boom", () => {
    throw new Error("broken");
  });

  assert.equal(result.exists, true);
  assert.equal(result.type, "error");
  assert.equal(result.error, "broken");
  assert.equal(result.value, undefined);
});

test("createDiagnostics probes runtime paths with safe samples", () => {
  const root = {
    betterncm: {
      ncm: {
        getPlaying: () => ({ id: 123, name: "Song" })
      },
      app: {
        readConfig: () => "{}"
      }
    },
    legacyNativeCmder: {},
    currentLyrics: { lrc: { lyric: "[00:00.00]Hello\n[00:01.00]World" } }
  };
  const diagnostics = createDiagnostics(root, { debug: false });
  const report = diagnostics.probeRuntime();

  assert.equal(report["window.betterncm"].exists, true);
  assert.equal(report["betterncm.ncm.getPlaying"].type, "function");
  assert.equal(report["betterncm.ncm.getPlaying"].sample.id, 123);
  assert.equal(report["betterncm.app.writeConfig"].exists, false);
});

test("sampleLyricsPayload reports keys and first two truncated lines", () => {
  const sample = sampleLyricsPayload({
    lrc: { lyric: "[00:00.00]I really want to stay at your house\n[00:01.00]And let yourself go\n[00:02.00]Extra" },
    tlyric: { lyric: "[00:00.00]中文翻译" },
    romalrc: null
  });

  assert.deepEqual(sample.keys, ["lrc", "tlyric", "romalrc"]);
  assert.equal(sample.has.lrc, true);
  assert.equal(sample.has.yrc, false);
  assert.equal(sample.lyricLength > 0, true);
  assert.equal(sample.firstLines.length, 2);
  assert.match(sample.firstLines[0], /\[00:00\.00\]/);
});

test("safe playback probes record getPlaying errors and null getPlayingSong results", () => {
  const root = {
    LyricLens: {},
    betterncm: {
      ncm: {
        getPlaying: () => {
          throw new TypeError("Cannot read property 'data' of null");
        },
        getPlayingSong: () => null
      }
    }
  };
  const diagnostics = createDiagnostics(root, { debug: true });
  root.LyricLens.diagnostics = diagnostics;

  const playing = safeGetPlaying(root);
  const song = safeGetPlayingSong(root);
  const state = diagnostics.getState();

  assert.equal(playing.ok, false);
  assert.match(playing.error, /Cannot read property 'data' of null/);
  assert.equal(song.ok, true);
  assert.equal(song.value, null);
  assert.match(state.getPlayingStatus, /error/);
  assert.equal(state.getPlayingSongStatus, "null");
});

test("known getPlaying compatibility errors do not occupy lastError", () => {
  const root = {
    LyricLens: {},
    betterncm: {
      ncm: {
        getPlaying: () => {
          throw new TypeError("Cannot read property 'data' of null");
        }
      }
    }
  };
  const diagnostics = createDiagnostics(root, { debug: true });
  root.LyricLens.diagnostics = diagnostics;

  safeGetPlaying(root);
  const state = diagnostics.getState();

  assert.match(state.getPlayingStatus, /Cannot read property 'data' of null/);
  assert.equal(state.lastError, null);
});

test("diagnostics include stable key, trusted time source, and cache usage fields", () => {
  const diagnostics = createDiagnostics(globalThis, { debug: false });
  const state = diagnostics.getState();

  assert.equal(state.rawAnalyzeKey, null);
  assert.equal(state.canonicalAnalyzeKey, null);
  assert.equal(state.keyAliasReason, null);
  assert.equal(state.promotionReason, null);
  assert.deepEqual(state.timeSourceCandidates, []);
  assert.equal(state.timeSourceFailureReason, null);
  assert.equal(state.cacheHit, false);
  assert.equal(state.cacheKey, null);
  assert.equal(state.cacheUseStatus, "not-checked");
});

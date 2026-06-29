const test = require("node:test");
const assert = require("node:assert/strict");

// Load all modules in order (simulating BetterNCM injects)
delete require.cache[require.resolve("../src/utils")];
delete require.cache[require.resolve("../src/diagnostics")];
delete require.cache[require.resolve("../src/cache")];
delete require.cache[require.resolve("../src/detect")];
delete require.cache[require.resolve("../src/lyrics")];
delete require.cache[require.resolve("../src/api")];
delete require.cache[require.resolve("../src/card")];
delete require.cache[require.resolve("../src/settings")];
delete require.cache[require.resolve("../src/sync")];
delete require.cache[require.resolve("../src/panel")];
delete require.cache[require.resolve("../src/styles")];
delete require.cache[require.resolve("../src/capture")];

require("../src/utils");
require("../src/diagnostics");
require("../src/cache");
require("../src/detect");
require("../src/lyrics");
require("../src/api");
require("../src/card");
require("../src/settings");
require("../src/sync");
require("../src/panel");
require("../src/styles");
const {
  buildPayload,
  readAmllStateLyrics,
  createDomLyricsObserver,
  readConsoleCapturedLyrics,
  readCacheFallback,
  captureLyrics,
  waitForCapture,
  updateCaptureDiagnostics,
  SOURCE_ORDER
} = require("../src/capture");

function makeFakeDiagnostics() {
  const state = {
    songId: null,
    captureStatus: "initializing",
    captureSource: null,
    analyzeTriggerStatus: "blocked-no-lyrics",
    analyzeTriggerBlockedReason: null,
    diagnosticsSchemaVersion: "1.2",
    lastCapturedAt: null,
    lastCaptureSource: null,
    lyricLineCount: 0
  };
  return {
    getState: () => ({ ...state }),
    updateState: (partial) => Object.assign(state, partial)
  };
}

function makeTimedLyricsArray() {
  return [
    { startTime: 100, endTime: 500, words: [{ word: "Hello" }], lyric: "Hello", translatedLyric: "你好" },
    { startTime: 600, endTime: 1000, words: [{ word: "World" }], lyric: "World", translatedLyric: "世界" }
  ];
}

// ── buildPayload ──

test("buildPayload normalizes line fields into unified shape", () => {
  const payload = buildPayload({
    source: "amll-state",
    lines: [
      { lineIndex: 0, original: "Hello", startMs: 100, endMs: 500, translation: "你好" },
      { lineIndex: 3, original: "World", startMs: 600, endMs: 1000, translation: "世界", romanLyric: "warudo" }
    ],
    songId: "12345",
    confidence: "high"
  });

  assert.equal(payload.source, "amll-state");
  assert.equal(payload.songId, "12345");
  assert.equal(payload.confidence, "high");
  assert.equal(payload.lines.length, 2);
  assert.equal(payload.lines[0].lineIndex, 0);
  assert.equal(payload.lines[0].original, "Hello");
  assert.equal(payload.lines[0].startMs, 100);
  assert.equal(payload.lines[0].endMs, 500);
  assert.equal(payload.lines[0].translation, "你好");
  assert.equal(payload.lines[1].lineIndex, 3);
  assert.equal(payload.lines[1].romanLyric, "warudo");
  assert.ok(typeof payload.capturedAt === "number");
});

test("buildPayload default confidence is medium when lines present", () => {
  const payload = buildPayload({
    source: "dom-lyrics",
    lines: [{ original: "test" }]
  });
  assert.equal(payload.confidence, "medium");
});

test("buildPayload confidence is low when no lines", () => {
  const payload = buildPayload({ source: "cache", lines: [] });
  assert.equal(payload.confidence, "low");
});

// ── readAmllStateLyrics ──

test("readAmllStateLyrics returns payload when AMLL.currentLyrics has timed array", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    AMLL: globalThis.AMLL
  };
  const timedLyrics = makeTimedLyricsArray();
  globalThis.AMLL = { currentLyrics: timedLyrics };
  globalThis.LyricLens = {
    Lyrics: require("../src/lyrics"),
    diagnostics: makeFakeDiagnostics()
  };

  try {
    const result = readAmllStateLyrics(globalThis);
    assert.ok(result);
    assert.equal(result.source, "amll-state");
    assert.equal(result.confidence, "high");
    assert.ok(result.lines.length >= 1);
    assert.equal(result.lines[0].original, "Hello");
  } finally {
    globalThis.AMLL = previous.AMLL;
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("readAmllStateLyrics returns payload from AMLL React lyricPlayer ref", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    AMLL: globalThis.AMLL,
    currentLyrics: globalThis.currentLyrics,
    CPPLYRICS_INTERNALS: globalThis.CPPLYRICS_INTERNALS,
    document: globalThis.document
  };
  const timedLyrics = makeTimedLyricsArray();
  const player = { getLyricLines: () => timedLyrics };
  const functionFiber = {
    memoizedState: {
      memoizedState: { current: player },
      next: null
    }
  };
  const hostFiber = { return: functionFiber };
  const element = { "__reactFiber$lyriclens": hostFiber };

  globalThis.AMLL = undefined;
  globalThis.currentLyrics = undefined;
  globalThis.CPPLYRICS_INTERNALS = undefined;
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === ".amll-lyric-player-wrapper" ? [element] : [];
    }
  };
  globalThis.LyricLens = {
    Lyrics: require("../src/lyrics"),
    diagnostics: makeFakeDiagnostics()
  };

  try {
    const result = readAmllStateLyrics(globalThis);
    assert.ok(result);
    assert.equal(result.source, "amll-state");
    assert.equal(result.confidence, "high");
    assert.equal(result.lines[0].original, "Hello");
    assert.equal(result.lines[0].startMs, 100);
    assert.equal(result.lines[0].endMs, 500);
  } finally {
    globalThis.AMLL = previous.AMLL;
    globalThis.currentLyrics = previous.currentLyrics;
    globalThis.CPPLYRICS_INTERNALS = previous.CPPLYRICS_INTERNALS;
    globalThis.document = previous.document;
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("readAmllStateLyrics returns null when no AMLL state", () => {
  const previous = { LyricLens: globalThis.LyricLens, AMLL: globalThis.AMLL };
  globalThis.AMLL = undefined;
  globalThis.LyricLens = { Lyrics: require("../src/lyrics"), diagnostics: makeFakeDiagnostics() };

  try {
    assert.equal(readAmllStateLyrics(globalThis), null);
  } finally {
    globalThis.AMLL = previous.AMLL;
    globalThis.LyricLens = previous.LyricLens;
  }
});

// ── readConsoleCapturedLyrics ──

test("readConsoleCapturedLyrics returns payload from last captured lyrics", () => {
  const previous = { LyricLens: globalThis.LyricLens, __LL_CAPTURED_LYRICS: globalThis.__LL_CAPTURED_LYRICS };
  const Lyrics = require("../src/lyrics");
  Lyrics.clearCapturedLyrics();

  const fakeConsole = {
    log() {}, debug() {}, info() {}, warn() {}, dir() {}, table() {}
  };
  Lyrics.installRuntimeLyricsCapture(fakeConsole);

  globalThis.LyricLens = {
    Lyrics,
    diagnostics: makeFakeDiagnostics()
  };

  try {
    fakeConsole.log(makeTimedLyricsArray());
    const result = readConsoleCapturedLyrics(globalThis);
    assert.ok(result);
    assert.equal(result.source, "console");
    assert.equal(result.confidence, "high"); // has timing
    assert.ok(result.lines.length >= 1);
  } finally {
    Lyrics.clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
    if (previous.__LL_CAPTURED_LYRICS === undefined) delete globalThis.__LL_CAPTURED_LYRICS;
    else globalThis.__LL_CAPTURED_LYRICS = previous.__LL_CAPTURED_LYRICS;
  }
});

test("readConsoleCapturedLyrics returns null when nothing captured", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  const Lyrics = require("../src/lyrics");
  Lyrics.clearCapturedLyrics();
  globalThis.LyricLens = {
    Lyrics,
    diagnostics: makeFakeDiagnostics()
  };

  try {
    assert.equal(readConsoleCapturedLyrics(globalThis), null);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
  }
});

// ── readCacheFallback ──

test("readCacheFallback returns cached cards when songId+lyricsHash match", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  const Cache = require("../src/cache");
  const Settings = require("../src/settings");

  globalThis.LyricLens = {
    Cache,
    Settings,
    Api: { PROMPT_VERSION: "v2" },
    _activeSettings: { apiEndpoint: "https://api.test/v1", modelName: "test-model" }
  };

  const songId = "123456";
  const lyricsHash = "abc123";
  const key = Cache.buildCacheKey({
    songId,
    lyricsHash,
    apiEndpoint: "https://api.test/v1",
    modelName: "test-model",
    promptVersion: "v2",
    cardGenerationMode: "per-line"
  });

  const cards = [{ index: 0, original: "Hello", translation: "你好" }];
  Cache.defaultCache.set(key, cards);

  try {
    const result = readCacheFallback(globalThis, { songId, lyricsHash });
    assert.ok(result);
    assert.equal(result.source, "cache");
    assert.equal(result.confidence, "low");
    assert.equal(result.cards, cards);
    assert.equal(result.cacheKey, key);
  } finally {
    Cache.defaultCache.clear();
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("readCacheFallback returns null when no match", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  globalThis.LyricLens = {
    Cache: require("../src/cache"),
    Settings: require("../src/settings"),
    Api: { PROMPT_VERSION: "v2" },
    _activeSettings: { apiEndpoint: "https://api.test/v1", modelName: "test-model" }
  };

  try {
    const result = readCacheFallback(globalThis, { songId: "99999", lyricsHash: "no-match" });
    assert.equal(result, null);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("captureLyrics records cache hit diagnostics but does not return cache as active capture", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  const Cache = require("../src/cache");
  const Settings = require("../src/settings");
  const Diagnostics = require("../src/diagnostics");
  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });

  globalThis.LyricLens = {
    Lyrics: require("../src/lyrics"),
    Cache,
    Settings,
    Api: { PROMPT_VERSION: "v2" },
    _activeSettings: { apiEndpoint: "https://api.test/v1", modelName: "test-model" },
    diagnostics: diag
  };

  const songId = "123456";
  const lyricsHash = "abc123";
  const key = Cache.buildCacheKey({
    songId,
    lyricsHash,
    apiEndpoint: "https://api.test/v1",
    modelName: "test-model",
    promptVersion: "v2",
    cardGenerationMode: "per-line"
  });
  Cache.defaultCache.set(key, [{ index: 0, original: "Old cached line", translation: "旧缓存" }]);

  try {
    const result = captureLyrics(globalThis, { songId, lyricsHash });
    const state = diag.getState();
    assert.equal(result, null);
    assert.equal(state.cacheHit, true);
    assert.equal(state.cacheKey, key);
    assert.equal(state.cacheUseStatus, "diagnostic-only");
    assert.equal(state.captureSource, null);
    assert.equal(state.activeCaptureSource, null);
    assert.equal(state.analyzeTriggerBlockedReason, "cache-hit-not-used");
  } finally {
    Cache.defaultCache.clear();
    globalThis.LyricLens = previous.LyricLens;
  }
});

// ── captureLyrics priority ──

test("captureLyrics prefers amll-state over console when both available", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    AMLL: globalThis.AMLL,
    currentLyrics: globalThis.currentLyrics,
    CPPLYRICS_INTERNALS: globalThis.CPPLYRICS_INTERNALS,
    __LL_CAPTURED_LYRICS: globalThis.__LL_CAPTURED_LYRICS
  };

  // Clean up any lingering state
  delete globalThis.currentLyrics;
  delete globalThis.CPPLYRICS_INTERNALS;

  const amllPayload = [{
    startTime: 100, endTime: 500,
    words: [{ word: "AMLL" }],
    lyric: "From AMLL state"
  }];

  globalThis.AMLL = { currentLyrics: amllPayload };

  const Lyrics = require("../src/lyrics");
  const Diagnostics = require("../src/diagnostics");
  Lyrics.clearCapturedLyrics();

  const fakeConsole = { log() {}, debug() {}, info() {}, warn() {}, dir() {}, table() {} };
  Lyrics.installRuntimeLyricsCapture(fakeConsole);

  // Also capture via console
  fakeConsole.log(makeTimedLyricsArray());

  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  globalThis.LyricLens = {
    Lyrics,
    Diagnostics,
    Cache: require("../src/cache"),
    Settings: require("../src/settings"),
    Api: { PROMPT_VERSION: "v2" },
    diagnostics: diag
  };

  try {
    const result = captureLyrics(globalThis);
    assert.ok(result);
    assert.equal(result.source, "amll-state");
    // itemText joins words: [{word:"AMLL"}] → "AMLL"
    assert.equal(result.lines[0].original, "AMLL");
  } finally {
    Lyrics.clearCapturedLyrics();
    globalThis.AMLL = previous.AMLL;
    globalThis.currentLyrics = previous.currentLyrics;
    globalThis.CPPLYRICS_INTERNALS = previous.CPPLYRICS_INTERNALS;
    globalThis.LyricLens = previous.LyricLens;
    if (previous.__LL_CAPTURED_LYRICS === undefined) delete globalThis.__LL_CAPTURED_LYRICS;
    else globalThis.__LL_CAPTURED_LYRICS = previous.__LL_CAPTURED_LYRICS;
  }
});

test("captureLyrics falls back to console when amll-state unavailable", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    AMLL: globalThis.AMLL,
    currentLyrics: globalThis.currentLyrics,
    CPPLYRICS_INTERNALS: globalThis.CPPLYRICS_INTERNALS,
    __LL_CAPTURED_LYRICS: globalThis.__LL_CAPTURED_LYRICS
  };

  globalThis.AMLL = undefined;
  delete globalThis.currentLyrics;
  delete globalThis.CPPLYRICS_INTERNALS;

  const Lyrics = require("../src/lyrics");
  const Diagnostics = require("../src/diagnostics");
  Lyrics.clearCapturedLyrics();

  const fakeConsole = { log() {}, debug() {}, info() {}, warn() {}, dir() {}, table() {} };
  Lyrics.installRuntimeLyricsCapture(fakeConsole);
  fakeConsole.log(makeTimedLyricsArray());

  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  globalThis.LyricLens = {
    Lyrics,
    Diagnostics,
    Cache: require("../src/cache"),
    Settings: require("../src/settings"),
    Api: { PROMPT_VERSION: "v2" },
    diagnostics: diag
  };

  try {
    const result = captureLyrics(globalThis);
    assert.ok(result);
    assert.equal(result.source, "console");
  } finally {
    Lyrics.clearCapturedLyrics();
    globalThis.AMLL = previous.AMLL;
    globalThis.currentLyrics = previous.currentLyrics;
    globalThis.CPPLYRICS_INTERNALS = previous.CPPLYRICS_INTERNALS;
    globalThis.LyricLens = previous.LyricLens;
    if (previous.__LL_CAPTURED_LYRICS === undefined) delete globalThis.__LL_CAPTURED_LYRICS;
    else globalThis.__LL_CAPTURED_LYRICS = previous.__LL_CAPTURED_LYRICS;
  }
});

// ── updateCaptureDiagnostics ──

test("updateCaptureDiagnostics sets capture-failed status when no payload", () => {
  const diag = makeFakeDiagnostics();
  const ctx = { LyricLens: { diagnostics: diag } };

  updateCaptureDiagnostics(ctx, null, "capture-failed");

  const state = diag.getState();
  assert.equal(state.captureStatus, "capture-failed");
  assert.equal(state.captureSource, null);
  assert.equal(state.analyzeTriggerStatus, "blocked-no-lyrics");
  assert.equal(state.analyzeTriggerBlockedReason, "no-capture-source");
});

test("updateCaptureDiagnostics updates captureSource and status for valid payload", () => {
  const diag = makeFakeDiagnostics();
  const ctx = { LyricLens: { diagnostics: diag } };
  const payload = buildPayload({
    source: "amll-state",
    lines: [{ original: "test" }],
    confidence: "high"
  });

  updateCaptureDiagnostics(ctx, payload);

  const state = diag.getState();
  assert.equal(state.captureStatus, "captured-valid-lines");
  assert.equal(state.captureSource, "amll-state");
  assert.equal(state.lyricLineCount, 1);
});

// ── createDomLyricsObserver ──

test("createDomLyricsObserver returns start/cleanup/extractNow functions", () => {
  const ctx = {
    document: {
      body: { textContent: "" },
      querySelector: () => null
    },
    MutationObserver: null
  };

  const observer = createDomLyricsObserver(ctx, () => {}, { debounceMs: 100 });
  assert.equal(typeof observer.start, "function");
  assert.equal(typeof observer.cleanup, "function");
  assert.equal(typeof observer.extractNow, "function");
  observer.cleanup();
});

test("createDomLyricsObserver cleanup stops further callbacks", () => {
  const ctx = {
    document: {
      body: { textContent: "" },
      querySelector: () => null
    },
    MutationObserver: null
  };

  let callCount = 0;
  const observer = createDomLyricsObserver(ctx, () => { callCount += 1; }, { debounceMs: 50 });
  observer.cleanup();
  observer.start(); // restart
  observer.cleanup(); // cleanup again

  // After cleanup, no more callbacks (even if extractNow is called)
  observer.extractNow();
  assert.equal(callCount, 0);
});

// ── SOURCE_ORDER ──

test("SOURCE_ORDER lists capture sources in priority sequence", () => {
  assert.deepEqual(SOURCE_ORDER, ["amll-state", "console", "dom-lyrics", "cache"]);
});

// ── Diagnostics schema 1.2 ──

test("diagnosticsSchemaVersion is 1.2", () => {
  const Diagnostics = require("../src/diagnostics");
  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  const state = diag.getState();
  assert.equal(state.diagnosticsSchemaVersion, "1.2");
  assert.equal(state.captureStatus, "initializing");
  assert.equal(state.captureSource, null);
  assert.equal(state.analyzeTriggerStatus, "blocked-no-lyrics");
});

// ── waitForCapture ──

test("waitForCapture returns result when capture succeeds immediately", async () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    AMLL: globalThis.AMLL
  };

  const amllPayload = makeTimedLyricsArray();
  globalThis.AMLL = { currentLyrics: amllPayload };

  const Lyrics = require("../src/lyrics");
  const Diagnostics = require("../src/diagnostics");
  Lyrics.clearCapturedLyrics();

  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  globalThis.LyricLens = {
    Lyrics,
    Diagnostics,
    Cache: require("../src/cache"),
    Settings: require("../src/settings"),
    Api: { PROMPT_VERSION: "v2" },
    diagnostics: diag
  };

  try {
    const result = await waitForCapture(globalThis, { maxWaitMs: 1000, pollMs: 50 });
    assert.ok(result);
    assert.equal(result.source, "amll-state");
  } finally {
    globalThis.AMLL = previous.AMLL;
    globalThis.LyricLens = previous.LyricLens;
  }
});

// ── DOM metadata filtering ──

test("DOM metadata patterns are rejected", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    MutationObserver: globalThis.MutationObserver
  };

  const Diagnostics = require("../src/diagnostics");
  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  globalThis.LyricLens = { diagnostics: diag };
  globalThis.MutationObserver = null;

  const fakeDoc = {
    querySelector: () => ({
      textContent: "创作者：宇多田ヒカル\n歌手：Utada Hikaru\n作词：宇多田ヒカル\n作曲：宇多田ヒカル",
      querySelectorAll: () => []
    }),
    body: { textContent: "" }
  };

  const ctx = { document: fakeDoc, MutationObserver: null, LyricLens: globalThis.LyricLens };

  let fired = false;
  const observer = createDomLyricsObserver(ctx, () => { fired = true; }, { debounceMs: 50, minLines: 5 });
  observer.extractNow();

  assert.equal(fired, false, "metadata-only lines must not trigger analyze");
  const state = diag.getState();
  assert.equal(state.domLyricsFilteredLineCount, 0);
  assert.equal(state.analyzeTriggerBlockedReason, "dom-source-metadata-only");

  observer.cleanup();
  globalThis.LyricLens = previous.LyricLens;
  globalThis.MutationObserver = previous.MutationObserver;
});

test("DOM observer with 1-2 valid lines does not trigger analyze", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    MutationObserver: globalThis.MutationObserver
  };

  const Diagnostics = require("../src/diagnostics");
  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  globalThis.LyricLens = { diagnostics: diag };
  globalThis.MutationObserver = null;

  const fakeDoc = {
    querySelector: () => ({
      textContent: "Hello world\nGoodbye moon",
      querySelectorAll: () => []
    }),
    body: { textContent: "" }
  };

  const ctx = { document: fakeDoc, MutationObserver: null, LyricLens: globalThis.LyricLens };

  let fired = false;
  const observer = createDomLyricsObserver(ctx, () => { fired = true; }, { debounceMs: 50, minLines: 5 });
  observer.extractNow();

  assert.equal(fired, false, "1-2 lines must not trigger analyze");
  const state = diag.getState();
  assert.equal(state.domLyricsFilteredLineCount, 2);
  assert.equal(state.analyzeTriggerBlockedReason, "dom-source-too-few-lines");
  assert.equal(state.captureStatus, "captured-empty-lines");

  observer.cleanup();
  globalThis.LyricLens = previous.LyricLens;
  globalThis.MutationObserver = previous.MutationObserver;
});

test("DOM observer with 6+ valid untimed lines does not trigger analyze", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    MutationObserver: globalThis.MutationObserver
  };

  const Diagnostics = require("../src/diagnostics");
  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  globalThis.LyricLens = { diagnostics: diag };
  globalThis.MutationObserver = null;

  const fakeDoc = {
    querySelector: () => ({
      textContent: "Line one of song\nLine two goes here\nLine three continues\nLine four is here\nLine five almost done\nLine six finishes",
      querySelectorAll: () => []
    }),
    body: { textContent: "" }
  };

  const ctx = { document: fakeDoc, MutationObserver: null, LyricLens: globalThis.LyricLens };

  let captured = null;
  const observer = createDomLyricsObserver(ctx, (p) => { captured = p; }, { debounceMs: 50, minLines: 5 });
  observer.extractNow();

  assert.equal(captured, null, "untimed DOM text must not trigger onCapture");

  const state = diag.getState();
  assert.equal(state.domLyricsFilteredLineCount >= 5, true);
  assert.equal(state.domLyricsRejectedReason, "dom-source-missing-timing");
  assert.equal(state.captureStatus, "waiting-for-timed-lyrics");
  assert.equal(state.analyzeTriggerStatus, "blocked-no-timed-lyrics");
  assert.equal(state.analyzeTriggerBlockedReason, "dom-source-missing-timing");
  assert.ok(Array.isArray(state.lastRejectedCaptureSample));

  observer.cleanup();
  globalThis.LyricLens = previous.LyricLens;
  globalThis.MutationObserver = previous.MutationObserver;
});

test("console capture still fires independently of DOM quality", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    AMLL: globalThis.AMLL,
    currentLyrics: globalThis.currentLyrics,
    CPPLYRICS_INTERNALS: globalThis.CPPLYRICS_INTERNALS,
    __LL_CAPTURED_LYRICS: globalThis.__LL_CAPTURED_LYRICS
  };

  globalThis.AMLL = undefined;
  delete globalThis.currentLyrics;
  delete globalThis.CPPLYRICS_INTERNALS;

  const Lyrics = require("../src/lyrics");
  const Diagnostics = require("../src/diagnostics");
  Lyrics.clearCapturedLyrics();

  const fakeConsole = { log() {}, debug() {}, info() {}, warn() {}, dir() {}, table() {} };
  Lyrics.installRuntimeLyricsCapture(fakeConsole);
  fakeConsole.log(makeTimedLyricsArray());

  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  globalThis.LyricLens = {
    Lyrics,
    Diagnostics,
    Cache: require("../src/cache"),
    Settings: require("../src/settings"),
    Api: { PROMPT_VERSION: "v2" },
    diagnostics: diag
  };

  try {
    const result = captureLyrics(globalThis);
    assert.ok(result);
    assert.equal(result.source, "console");
    assert.equal(result.confidence, "high");
  } finally {
    Lyrics.clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
    globalThis.AMLL = previous.AMLL;
    globalThis.currentLyrics = previous.currentLyrics;
    globalThis.CPPLYRICS_INTERNALS = previous.CPPLYRICS_INTERNALS;
    if (previous.__LL_CAPTURED_LYRICS === undefined) delete globalThis.__LL_CAPTURED_LYRICS;
    else globalThis.__LL_CAPTURED_LYRICS = previous.__LL_CAPTURED_LYRICS;
  }
});

test("diagnostics schema 1.2 includes DOM quality fields", () => {
  const Diagnostics = require("../src/diagnostics");
  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  const state = diag.getState();

  assert.equal(state.diagnosticsSchemaVersion, "1.2");
  assert.equal(state.domLyricsRawLineCount, 0);
  assert.equal(state.domLyricsFilteredLineCount, 0);
  assert.equal(state.domLyricsRejectedReason, null);
  assert.equal(state.captureConfidence, null);
  assert.equal(state.lastCaptureSample, null);
  assert.equal(state.lastRejectedCaptureSample, null);
});

// ── Capture scoring & arbitration ──

test("computeCaptureScore ranks amll-state higher than dom-lyrics", () => {
  const { computeCaptureScore, buildPayload } = require("../src/capture");

  const amll = buildPayload({
    source: "amll-state",
    lines: Array.from({ length: 20 }, (_, i) => ({ original: `Line ${i}`, startMs: i * 1000 })),
    confidence: "high"
  });
  const dom = buildPayload({
    source: "dom-lyrics",
    lines: Array.from({ length: 20 }, (_, i) => ({ original: `Line ${i}` })),
    confidence: "medium"
  });

  const amllScore = computeCaptureScore(amll);
  const domScore = computeCaptureScore(dom);
  assert.ok(amllScore > domScore, `amll-state (${amllScore}) should outscore dom-lyrics (${domScore})`);
});

test("computeCaptureScore rewards timed lines", () => {
  const { computeCaptureScore, buildPayload } = require("../src/capture");

  const withTiming = buildPayload({
    source: "console",
    lines: Array.from({ length: 10 }, (_, i) => ({ original: `L${i}`, startMs: i * 500, endMs: i * 500 + 400 })),
    confidence: "high"
  });
  const withoutTiming = buildPayload({
    source: "console",
    lines: Array.from({ length: 10 }, (_, i) => ({ original: `L${i}` })),
    confidence: "high"
  });

  assert.ok(computeCaptureScore(withTiming) > computeCaptureScore(withoutTiming),
    "timed lines should increase score");
});

test("hasCompleteLineTiming rejects untimed and sentinel DOM lines", () => {
  const { hasCompleteLineTiming, buildPayload } = require("../src/capture");

  assert.equal(hasCompleteLineTiming(buildPayload({
    source: "dom-lyrics",
    lines: [
      { original: "A", startMs: null },
      { original: "B", startMs: null }
    ]
  })), false);

  assert.equal(hasCompleteLineTiming(buildPayload({
    source: "dom-lyrics",
    lines: [
      { original: "A", startMs: 0 },
      { original: "B", startMs: 999999999 }
    ]
  })), false);

  assert.equal(hasCompleteLineTiming(buildPayload({
    source: "console",
    lines: [
      { original: "A", startMs: 1000 },
      { original: "B", startMs: 2000 }
    ]
  })), true);
});

test("shouldReplaceActiveCapture requires meaningful improvement", () => {
  const { shouldReplaceActiveCapture, buildPayload } = require("../src/capture");

  const existing = buildPayload({
    source: "console",
    lines: Array.from({ length: 30 }, (_, i) => ({ original: `L${i}`, startMs: i * 1000 })),
    confidence: "high"
  });

  const activeState = {
    activeCaptureSource: "console",
    activeCaptureScore: 100
  };

  // Same source, fewer lines, lower score — should NOT replace
  const worse = buildPayload({
    source: "dom-lyrics",
    lines: Array.from({ length: 5 }, (_, i) => ({ original: `L${i}` })),
    confidence: "medium"
  });
  assert.equal(shouldReplaceActiveCapture(worse, activeState), false,
    "lower-score DOM should not replace active console");

  // Much better source with many more lines — should replace
  const better = buildPayload({
    source: "amll-state",
    lines: Array.from({ length: 80 }, (_, i) => ({ original: `L${i}`, startMs: i * 500 })),
    confidence: "high"
  });
  assert.equal(shouldReplaceActiveCapture(better, activeState), true,
    "much better amll-state should replace active console");
});

test("activeCaptureSource and skippedDuplicateAnalyzeCount default to zero", () => {
  const Diagnostics = require("../src/diagnostics");
  const diag = Diagnostics.createDiagnostics(globalThis, { debug: false });
  const state = diag.getState();

  assert.equal(state.activeCaptureSource, null);
  assert.equal(state.activeCaptureLineCount, 0);
  assert.equal(state.activeCaptureScore, 0);
  assert.equal(state.skippedCaptureReason, null);
  assert.equal(state.skippedDuplicateAnalyzeCount, 0);
  assert.equal(state.lastSkippedCaptureSample, null);
});

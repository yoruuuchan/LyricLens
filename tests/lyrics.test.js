const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getLastPayload,
  isParsedTimedLyricsArray,
  parseLrcText,
  preprocessLyricLines,
  preprocessLyricLinesWithReport,
  probeSources,
  summarizeTimedLyricsArray,
  stripWordTimestamps,
  formatLinesForPrompt,
  installRuntimeLyricsCapture,
  getLastCapturedLyrics,
  clearCapturedLyrics,
  scanArgsForLyricsArray,
  fingerprintCapturedLyrics,
  onRuntimeLyricsCaptured,
  RUNTIME_CAPTURE_EVENT
} = require("../src/lyrics");

function makeFakeConsole() {
  const calls = [];
  return {
    calls,
    log(...args) { calls.push({ method: "log", args, thisArg: this }); },
    debug(...args) { calls.push({ method: "debug", args, thisArg: this }); },
    info(...args) { calls.push({ method: "info", args, thisArg: this }); },
    warn(...args) { calls.push({ method: "warn", args, thisArg: this }); },
    dir(value) { calls.push({ method: "dir", args: [value], thisArg: this }); },
    table(value) { calls.push({ method: "table", args: [value], thisArg: this }); }
  };
}

function makeTimedLyricsPayload() {
  return [
    { startTime: 1000, endTime: 2000, words: [{ word: "Hello" }], translatedLyric: "你好" },
    { startTime: 2000, endTime: 3000, words: [{ word: "World" }], lyric: "World" }
  ];
}

test("removes word-level timestamps while preserving text", () => {
  assert.equal(stripWordTimestamps("(123,456,0)I (579,100,0)really"), "I really");
  assert.equal(stripWordTimestamps("(0:500)stay(500:900) here"), "stay here");
});

test("parses lrc text into lyric lines with original indexes and ms start times", () => {
  const lines = parseLrcText("[00:01.50]Hello\n[00:03.00]World");
  assert.deepEqual(lines, [
    { index: 0, text: "Hello", startTime: 1500, endTime: 3000 },
    { index: 1, text: "World", startTime: 3000, endTime: undefined }
  ]);
});

test("preprocess keeps original indexes and drops empty or punctuation-only lines", () => {
  const processed = preprocessLyricLines([
    { index: 0, text: "", startTime: 0 },
    { index: 1, text: "!!!", startTime: 1000 },
    { index: 2, text: "I really want to stay", startTime: 2000 },
    { index: 3, text: "　", startTime: 3000 },
    { index: 4, text: "At your house", startTime: 4000 }
  ]);

  assert.deepEqual(processed.map((line) => line.index), [2, 4]);
  assert.equal(formatLinesForPrompt(processed), "[2] I really want to stay\n[4] At your house");
});

test("normalizes line timing from word-level timing when line timing is absent", () => {
  const processed = preprocessLyricLines([
    {
      index: 0,
      words: [
        { word: "Good ", startTime: 1200, endTime: 1500 },
        { word: "morning", startTime: 1500, endTime: 2100 }
      ]
    },
    {
      index: 1,
      words: [
        { word: "Night ", startTime: 2100, endTime: 2500 },
        { word: "City", startTime: 2500, endTime: 3200 }
      ]
    }
  ]);

  assert.equal(processed[0].startTime, 1200);
  assert.equal(processed[0].endTime, 2100);
  assert.equal(processed[1].startTime, 2100);
  assert.equal(processed[1].endTime, 3200);
});

test("normalizes line timing from dynamicLyric word timing", () => {
  const processed = preprocessLyricLines([
    {
      index: 0,
      dynamicLyric: [
        { word: "初めて", startTime: 75840, endTime: 76400 },
        { word: "の", startTime: 76400, endTime: 76600 }
      ],
      translatedLyric: "第一次",
      romanLyric: "ha ji me te"
    },
    {
      index: 1,
      dynamicLyric: [
        { word: "ルーブル", start: 76600, duration: 900 },
        { word: "は", start: 77500, duration: 300 }
      ]
    }
  ]);

  assert.equal(processed[0].text, "初めての");
  assert.equal(processed[0].startTime, 75840);
  assert.equal(processed[0].endTime, 76600);
  assert.equal(processed[0].referenceTranslation, "第一次");
  assert.equal(processed[0].romanLyric, "ha ji me te");
  assert.equal(processed[1].startTime, 76600);
  assert.equal(processed[1].endTime, 77800);
});

test("normalizes line timing from start and end aliases", () => {
  const processed = preprocessLyricLines([
    { index: 0, text: "A", start: 1200, end: 2400 },
    { index: 1, text: "B", from: 2400, to: 3600 }
  ]);

  assert.equal(processed[0].startTime, 1200);
  assert.equal(processed[0].endTime, 2400);
  assert.equal(processed[1].startTime, 2400);
  assert.equal(processed[1].endTime, 3600);
});

test("normalizes second-based numeric lyric timing to milliseconds", () => {
  const processed = preprocessLyricLines([
    { index: 0, text: "Good morning", startTime: 12, endTime: 15 },
    { index: 1, text: "Night City", startTime: 15, endTime: 18 }
  ]);

  assert.equal(processed[0].startTime, 12000);
  assert.equal(processed[0].endTime, 15000);
  assert.equal(processed[1].startTime, 15000);
  assert.equal(processed[1].endTime, 18000);
});

test("preprocess honors explicit 80 line limit", () => {
  const input = Array.from({ length: 85 }, (_, index) => ({
    index,
    text: `Line ${index}`,
    startTime: index * 1000
  }));

  const processed = preprocessLyricLines(input, 80);
  assert.equal(processed.length, 80);
  assert.equal(processed.at(-1).index, 79);
});

test("preprocessLyricLinesWithReport reports raw, sent, and dropped counts", () => {
  const input = Array.from({ length: 100 }, (_, index) => ({
    index,
    text: `Line ${index}`,
    startTime: index * 1000
  }));

  const report = preprocessLyricLinesWithReport(input, 24);
  assert.equal(report.rawCount, 100);
  assert.equal(report.sentCount, 24);
  assert.equal(report.droppedCount, 76);
  assert.equal(report.lines.length, 24);
});

test("preprocess preserves translation and romanization references for prompt input", () => {
  const report = preprocessLyricLinesWithReport([
    {
      index: 4,
      text: "君の名は",
      startTime: 1200,
      endTime: 2400,
      referenceTranslation: "你的名字",
      romanLyric: "kimi no na wa"
    }
  ], 80);

  assert.equal(report.lines[0].referenceTranslation, "你的名字");
  assert.equal(report.lines[0].romanLyric, "kimi no na wa");
});

test("formatLinesForPrompt can include timing and reference fields per lyric line", () => {
  const formatted = formatLinesForPrompt([
    {
      index: 4,
      text: "君の名は",
      startTime: 1200,
      endTime: 2400,
      referenceTranslation: "你的名字",
      romanLyric: "kimi no na wa"
    }
  ], { detailed: true });

  assert.match(formatted, /^\[4\]/);
  assert.match(formatted, /startMs=1200/);
  assert.match(formatted, /endMs=2400/);
  assert.match(formatted, /referenceTranslation="你的名字"/);
  assert.match(formatted, /romanLyric="kimi no na wa"/);
});

test("recognizes parsed timed lyrics arrays and builds a summary", () => {
  const payload = [{
    words: [{ word: "Hello" }],
    startTime: 1000,
    endTime: 3820,
    translatedLyric: "你好",
    romanLyric: "hello"
  }];

  assert.equal(isParsedTimedLyricsArray(payload), true);
  assert.deepEqual(summarizeTimedLyricsArray(payload), {
    length: 1,
    firstStartTime: 1000,
    firstEndTime: 3820,
    hasWords: true,
    hasTranslatedLyric: true,
    hasRomanLyric: true,
    sampleText: "Hello"
  });
});

test("recognizes timed lyrics arrays when timing only exists on words", () => {
  const payload = [{
    words: [
      { word: "Good ", startTime: 1200, endTime: 1500 },
      { word: "morning", startTime: 1500, endTime: 2100 }
    ],
    translatedLyric: "早上好"
  }];

  assert.equal(isParsedTimedLyricsArray(payload), true);
  assert.deepEqual(summarizeTimedLyricsArray(payload), {
    length: 1,
    firstStartTime: 1200,
    firstEndTime: 2100,
    hasWords: true,
    hasTranslatedLyric: true,
    hasRomanLyric: false,
    sampleText: "Good morning"
  });
});

test("probeSources finds AMLL currentLyrics arrays and updates diagnostics", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    currentLyrics: globalThis.currentLyrics,
    AMLL: globalThis.AMLL,
    CPPLYRICS_INTERNALS: globalThis.CPPLYRICS_INTERNALS
  };
  const payload = [{
    words: [{ word: "僕" }, { word: "ら" }],
    startTime: 1000,
    endTime: 3820,
    translatedLyric: "我们",
    romanLyric: "bokura"
  }];
  const updates = [];
  globalThis.currentLyrics = undefined;
  globalThis.CPPLYRICS_INTERNALS = undefined;
  globalThis.AMLL = { currentLyrics: payload };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: (partial) => updates.push(partial)
    }
  };

  try {
    assert.equal(probeSources(), payload);
    assert.equal(getLastPayload(), payload);
    assert.equal(updates.at(-1).lyricsSource, "window.AMLL.currentLyrics");
    assert.equal(updates.at(-1).lyricLineCount, 1);
    assert.equal(updates.at(-1).lastLyricsSummary.sampleText, "僕ら");
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.currentLyrics = previous.currentLyrics;
    globalThis.AMLL = previous.AMLL;
    globalThis.CPPLYRICS_INTERNALS = previous.CPPLYRICS_INTERNALS;
  }
});

test("installRuntimeLyricsCapture captures payload from console.log and still calls original", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  const updates = [];
  globalThis.LyricLens = {
    diagnostics: {
      updateState: (partial) => updates.push(partial),
      getState: () => ({ apiStatus: "idle" })
    }
  };
  clearCapturedLyrics();
  const fakeConsole = makeFakeConsole();
  try {
    assert.equal(installRuntimeLyricsCapture(fakeConsole), true);
    const payload = makeTimedLyricsPayload();
    fakeConsole.log(payload);
    assert.equal(fakeConsole.calls.length, 1);
    assert.equal(fakeConsole.calls[0].method, "log");
    assert.equal(fakeConsole.calls[0].thisArg, fakeConsole);
    assert.equal(getLastCapturedLyrics(), payload);
    assert.equal(globalThis.__LL_CAPTURED_LYRICS, payload);
    const latest = updates.at(-1);
    assert.equal(latest.lyricsSource, "runtime.capture.console.log");
    assert.equal(latest.lyricLineCount, 2);
    assert.equal(latest.lastLyricsSummary.hasWords, true);
  } finally {
    clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("installRuntimeLyricsCapture captures from debug/info/warn/dir/table", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: () => {},
      getState: () => ({ apiStatus: "idle" })
    }
  };
  const methods = ["debug", "info", "warn", "dir", "table"];
  try {
    for (const method of methods) {
      clearCapturedLyrics();
      const fakeConsole = makeFakeConsole();
      installRuntimeLyricsCapture(fakeConsole);
      const payload = makeTimedLyricsPayload();
      fakeConsole[method](payload);
      assert.equal(fakeConsole.calls.length, 1, `original ${method} not called once`);
      assert.equal(getLastCapturedLyrics(), payload, `${method} did not capture payload`);
    }
  } finally {
    clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("installRuntimeLyricsCapture is idempotent on the same console", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: () => {},
      getState: () => ({ apiStatus: "idle" })
    }
  };
  clearCapturedLyrics();
  const fakeConsole = makeFakeConsole();
  try {
    assert.equal(installRuntimeLyricsCapture(fakeConsole), true);
    const firstLog = fakeConsole.log;
    assert.equal(installRuntimeLyricsCapture(fakeConsole), true);
    assert.equal(fakeConsole.log, firstLog, "console.log was re-wrapped on second install");
    const payload = makeTimedLyricsPayload();
    fakeConsole.log(payload);
    assert.equal(fakeConsole.calls.length, 1, "original called more than once - double-wrapped");
    assert.equal(getLastCapturedLyrics(), payload);
  } finally {
    clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("installRuntimeLyricsCapture prevents recursive console wrapper calls", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: () => {},
      getState: () => ({ apiStatus: "idle" })
    }
  };
  clearCapturedLyrics();
  let depth = 0;
  const fakeConsole = {
    log(...args) {
      depth += 1;
      try {
        if (depth > 1) throw new Error("recursive console wrapper call");
        this.log("nested", args.length);
      } finally {
        depth -= 1;
      }
    }
  };

  try {
    assert.equal(installRuntimeLyricsCapture(fakeConsole), true);
    assert.doesNotThrow(() => fakeConsole.log(makeTimedLyricsPayload()));
  } finally {
    clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("probeSources prefers runtime-captured lyrics over AMLL/window candidates", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    AMLL: globalThis.AMLL,
    __LL_CAPTURED_LYRICS: globalThis.__LL_CAPTURED_LYRICS
  };
  const captured = [{
    startTime: 500,
    endTime: 1500,
    words: [{ word: "captured" }],
    lyric: "captured"
  }];
  const amll = [{
    startTime: 1000,
    endTime: 2000,
    words: [{ word: "amll" }],
    translatedLyric: "ignored"
  }];
  const state = { lyricsSource: "none", apiStatus: "idle" };
  globalThis.AMLL = { currentLyrics: amll };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: (partial) => Object.assign(state, partial),
      getState: () => ({ ...state })
    }
  };
  clearCapturedLyrics();
  const fakeConsole = makeFakeConsole();
  installRuntimeLyricsCapture(fakeConsole);
  try {
    fakeConsole.log(captured);
    assert.equal(probeSources(), captured);
    assert.notEqual(state.lyricsSource, "none");
    assert.match(state.lyricsSource, /^runtime\.capture\.console/);
    assert.equal(state.lyricLineCount, 1);
  } finally {
    clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
    if (previous.AMLL === undefined) delete globalThis.AMLL;
    else globalThis.AMLL = previous.AMLL;
    if (previous.__LL_CAPTURED_LYRICS === undefined) delete globalThis.__LL_CAPTURED_LYRICS;
    else globalThis.__LL_CAPTURED_LYRICS = previous.__LL_CAPTURED_LYRICS;
  }
});

test("onRuntimeLyricsCaptured handler fires with payload/source/fingerprint after capture", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: () => {},
      getState: () => ({ apiStatus: "idle" })
    }
  };
  clearCapturedLyrics();
  const fakeConsole = makeFakeConsole();
  installRuntimeLyricsCapture(fakeConsole);
  const received = [];
  const unsubscribe = onRuntimeLyricsCaptured((detail) => received.push(detail));
  try {
    const payload = makeTimedLyricsPayload();
    fakeConsole.debug(payload);
    assert.equal(received.length, 1);
    assert.equal(received[0].payload, payload);
    assert.equal(received[0].source, "runtime.capture.console.debug");
    assert.equal(typeof received[0].fingerprint, "string");
    assert.equal(received[0].fingerprint.length > 0, true);
    assert.equal(received[0].summary.length, 2);
  } finally {
    unsubscribe();
    clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("onRuntimeLyricsCaptured returns unsubscribe that stops further events", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: () => {},
      getState: () => ({ apiStatus: "idle" })
    }
  };
  clearCapturedLyrics();
  const fakeConsole = makeFakeConsole();
  installRuntimeLyricsCapture(fakeConsole);
  let count = 0;
  const unsubscribe = onRuntimeLyricsCaptured(() => { count += 1; });
  try {
    fakeConsole.log(makeTimedLyricsPayload());
    assert.equal(count, 1);
    unsubscribe();
    fakeConsole.log(makeTimedLyricsPayload());
    assert.equal(count, 1, "listener should not fire after unsubscribe");
  } finally {
    clearCapturedLyrics();
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("fingerprintCapturedLyrics is stable for same payload and differs for distinct payloads", () => {
  const a = makeTimedLyricsPayload();
  const b = makeTimedLyricsPayload();
  assert.equal(fingerprintCapturedLyrics(a), fingerprintCapturedLyrics(b));
  const c = [
    { startTime: 9999, endTime: 10000, words: [{ word: "Other" }], lyric: "Other" }
  ];
  assert.notEqual(fingerprintCapturedLyrics(a), fingerprintCapturedLyrics(c));
  const d = [
    { startTime: 1000, endTime: 2000, words: [{ word: "Hello" }], translatedLyric: "你好" },
    { startTime: 2000, endTime: 3000, words: [{ word: "Different world" }], lyric: "Different world" }
  ];
  assert.notEqual(fingerprintCapturedLyrics(a), fingerprintCapturedLyrics(d));
  assert.equal(fingerprintCapturedLyrics(null), null);
  assert.equal(fingerprintCapturedLyrics([]), null);
});

test("RUNTIME_CAPTURE_EVENT constant exposed for window event subscribers", () => {
  assert.equal(RUNTIME_CAPTURE_EVENT, "lyriclens:lyrics-captured");
});

test("scanArgsForLyricsArray finds payload nested up to 2 levels deep", () => {
  const payload = makeTimedLyricsPayload();
  assert.equal(scanArgsForLyricsArray([payload]), payload);
  assert.equal(scanArgsForLyricsArray([{ inner: payload }]), payload);
  assert.equal(scanArgsForLyricsArray([{ outer: { inner: payload } }]), payload);
  const tooDeep = { a: { b: { c: payload } } };
  assert.equal(scanArgsForLyricsArray([tooDeep]), null);
  assert.equal(scanArgsForLyricsArray([null, undefined, "hi", 42]), null);
});

test("probeSources finds shallow window lyric candidates and clears none source", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    candidateLyricsStore: globalThis.candidateLyricsStore
  };
  const payload = [{
    lyric: "Stay",
    startTime: 1000,
    endTime: 2000
  }];
  const state = { lyricsSource: "none" };
  globalThis.candidateLyricsStore = { nested: { activeLyrics: payload } };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: (partial) => Object.assign(state, partial)
    }
  };

  try {
    assert.equal(probeSources(), payload);
    assert.match(state.lyricsSource, /candidateLyricsStore\.nested\.activeLyrics/);
    assert.notEqual(state.lyricsSource, "none");
    assert.equal(state.lyricLineCount, 1);
  } finally {
    delete globalThis.candidateLyricsStore;
    if (previous.candidateLyricsStore !== undefined) globalThis.candidateLyricsStore = previous.candidateLyricsStore;
    globalThis.LyricLens = previous.LyricLens;
  }
});

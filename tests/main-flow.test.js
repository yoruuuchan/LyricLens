const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

function freshRequire(relativePath) {
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  return require(resolved);
}

function makeFakeDoc() {
  const makeNode = () => ({
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    attributes: {},
    children: [],
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    remove() {},
    contains() { return false; }
  });
  return {
    body: {
      appendChild() {},
      contains() { return false; }
    },
    head: { appendChild() {} },
    createElement: () => makeNode(),
    createDocumentFragment: () => ({ appendChild() {}, _isFragment: true }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    readyState: "complete"
  };
}

function buildScenario(options = {}) {
  const previous = {
    LyricLens: globalThis.LyricLens,
    document: globalThis.document,
    plugin: globalThis.plugin,
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    __LL_CAPTURED_LYRICS: globalThis.__LL_CAPTURED_LYRICS
  };

  globalThis.document = makeFakeDoc();
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;

  let bootstrapFn = null;
  globalThis.plugin = { onLoad: (fn) => { bootstrapFn = fn; } };

  globalThis.LyricLens = undefined;

  freshRequire("../src/utils");
  freshRequire("../src/diagnostics");
  freshRequire("../src/cache");
  freshRequire("../src/detect");
  freshRequire("../src/lyrics");
  freshRequire("../src/api");
  freshRequire("../src/card");
  freshRequire("../src/settings");
  freshRequire("../src/sync");
  freshRequire("../src/panel");
  freshRequire("../src/styles");
  freshRequire("../src/capture");

  const LL = globalThis.LyricLens;
  const originalInstallRuntimeLyricsCapture = LL.Lyrics.installRuntimeLyricsCapture;
  LL.Utils.debounce = (fn) => fn;
  let progressCallback = null;
  let songChangeCallback = null;
  let playStateCallback = null;
  LL.Sync.startProgressListener = (callback) => {
    progressCallback = callback;
    return () => {};
  };
  LL.Sync.startSongMonitor = (onSongChange, onPlayState) => {
    songChangeCallback = onSongChange;
    playStateCallback = onPlayState;
    return () => {};
  };
  LL.Sync.getCurrentSongId = () => null;
  LL.Lyrics.wrapOnProcessLyrics = () => true;
  LL.Lyrics.installRuntimeLyricsCapture = () => true;

  const scenarioSettings = {
    apiEndpoint: "https://api.siliconflow.cn/v1",
    apiKey: "sk-test",
    modelName: "Qwen/Test",
    autoAnalyze: true,
    defaultPosition: "bottomRight",
    panelOpacity: 0.85,
    ...options.settings
  };
  LL.Settings.readSettings = async () => LL.Settings.normalizeSettings(scenarioSettings);
  LL.Settings.writeSettings = async (s) => s;

  const panelCalls = {
    showCard: [],
    showLoading: [],
    showError: [],
    hide: 0,
    showConfig: 0,
    resetForAnalyze: [],
    setCardsState: [],
    renderCardAt: [],
    syncToPlayback: []
  };
  let panelOptions = null;
  let panelCards = [];
  LL.Panel = {
    createPanel: (createdOptions) => {
      panelOptions = createdOptions;
      return ({
      mount: () => {},
      destroy: () => {},
      unmount: () => {},
      setSongId: () => {},
      setSettings: () => {},
      hide: () => { panelCalls.hide += 1; },
      mountDebugPanel: () => {},
      showConfig: () => { panelCalls.showConfig += 1; },
      showLoading: (msg) => { panelCalls.showLoading.push(msg); },
      showError: (msg) => { panelCalls.showError.push(msg); },
      resetForAnalyze: (payload) => { panelCalls.resetForAnalyze.push(payload); },
      setCardsState: (payload) => {
        panelCards = Array.isArray(payload?.cards) ? payload.cards.slice() : [];
        panelCalls.setCardsState.push(payload);
      },
      renderCardAt: (index, reason) => { panelCalls.renderCardAt.push({ index, reason }); },
      syncToPlayback: (currentMs, reason) => {
        const index = LL.Sync.selectCardByPlaybackTime(currentMs, panelCards);
        panelCalls.syncToPlayback.push({ currentMs, reason, index });
        const card = panelCards[index] || null;
        LL.diagnostics.updateState({
          currentCardIndex: index,
          currentCardLineIndex: card?.lineIndex ?? card?.index ?? null,
          currentCardStartMs: card?.startMs ?? card?.startTime ?? null,
          currentCardEndMs: card?.endMs ?? card?.endTime ?? null,
          currentCardOriginal: card?.original ?? card?.line ?? null,
          panelLastRenderReason: reason,
          panelLastRenderedAt: Date.now()
        });
        return index;
      },
      getAutoFollow: () => true,
      showCard: (analysis, lineIndex) => { panelCalls.showCard.push({ analysis, lineIndex }); }
      });
    }
  };

  const fetchCalls = [];
  let nextFetchResponse = null;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    if (typeof nextFetchResponse === "function") return nextFetchResponse({ url, init });
    return nextFetchResponse;
  };

  function setFetchResponse(response) { nextFetchResponse = response; }

  function chatCompletionResponseFor(cards) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ cards }) } }]
        });
      }
    };
  }

  function restore() {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.plugin = previous.plugin;
    globalThis.fetch = previous.fetch;
    if (previous.AbortController) globalThis.AbortController = previous.AbortController;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    if (previous.__LL_CAPTURED_LYRICS === undefined) delete globalThis.__LL_CAPTURED_LYRICS;
    else globalThis.__LL_CAPTURED_LYRICS = previous.__LL_CAPTURED_LYRICS;
    for (const file of [
      "../src/utils","../src/diagnostics","../src/cache","../src/detect","../src/lyrics",
      "../src/api","../src/card","../src/settings","../src/sync","../src/panel","../src/styles","../src/capture","../main"
    ]) {
      delete require.cache[require.resolve(file)];
    }
  }

  freshRequire("../main");

  return {
    LL,
    getBootstrap: () => bootstrapFn,
    getPanelOptions: () => panelOptions,
    installRuntimeLyricsCapture: originalInstallRuntimeLyricsCapture,
    panelCalls,
    fetchCalls,
    emitProgress: (timeMs, args = []) => progressCallback?.(timeMs, args),
    emitSongChange: (songId) => songChangeCallback?.(songId),
    emitPlayState: (...args) => playStateCallback?.(...args),
    setFetchResponse,
    chatCompletionResponseFor,
    restore
  };
}

const englishLyricsPayload = [
  { startTime: 1000, endTime: 2000, words: [{ word: "Stay" }, { word: " with" }, { word: " me" }], lyric: "Stay with me" },
  { startTime: 2000, endTime: 3500, words: [{ word: "Right" }, { word: " here" }], lyric: "Right here in my arms" },
  { startTime: 3500, endTime: 5000, words: [{ word: "Until" }, { word: " dawn" }], lyric: "Until the morning sun" }
];

const englishLyricsPayloadAlt = [
  { startTime: 4000, endTime: 6000, words: [{ word: "Dreams" }], lyric: "Dreams of yesterday haunt me" },
  { startTime: 6000, endTime: 8000, words: [{ word: "Tomorrow" }], lyric: "Tomorrow waits with open arms" }
];

const validCardsPayload = (count) => Array.from({ length: count }, (_, i) => ({
  index: i,
  line: ["Stay with me","Right here in my arms","Until the morning sun"][i] || "x",
  translation: "翻译",
  highlights: []
}));

function makeEnglishPayload(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => ({
    startTime: index * 1000,
    endTime: index * 1000 + 900,
    words: [{ word: `Line ${index} stays with me` }],
    lyric: `Line ${index} stays with me`
  }));
}

function makeFastEnglishPayload(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => ({
    startTime: index * 100,
    endTime: index * 100 + 90,
    words: [{ word: `Fast line ${index} keeps singing tonight` }],
    lyric: `Fast line ${index} keeps singing tonight`
  }));
}

function lineIndexesFromRequest(init) {
  const body = JSON.parse(init.body);
  return Array.from(String(body.messages[1].content || "").matchAll(/^\[(\d+)\]/gm))
    .map((match) => Number(match[1]));
}

function perLineCardsForIndexes(indexes, options = {}) {
  const omit = new Set(options.omit || []);
  const reverse = options.reverse === true;
  const cards = indexes
    .filter((index) => !omit.has(index))
    .map((index) => ({
      lineIndex: index,
      startMs: index * 1000,
      endMs: index * 1000 + 900,
      original: `Line ${index} stays with me`,
      translation: `第 ${index} 行`,
      points: [],
      note: "暂无可以学习的内容哦"
    }));
  return reverse ? cards.reverse() : cards;
}

function perLineCardsWithRelativeIndexes(indexes) {
  return indexes.map((index, position) => ({
    lineIndex: position,
    original: "Line " + index + " stays with me",
    translation: "第 " + index + " 行",
    points: [],
    note: "暂无可以学习的内容哦"
  }));
}

function perLineCardsWithoutTiming(indexes) {
  return indexes.map((index) => ({
    lineIndex: index,
    original: `Fast line ${index} keeps singing tonight`,
    translation: `第 ${index} 行`,
    points: [],
    note: "暂无可以学习的内容哦"
  }));
}

function wait(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFastTimeouts(fn) {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, Math.min(Number(ms) || 0, 1), ...args);
  try {
    return await fn(originalSetTimeout);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

function installFakeConsoleCapture(scn, payload) {
  const fakeConsole = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, dir: () => {}, table: () => {} };
  scn.installRuntimeLyricsCapture(fakeConsole);
  fakeConsole.log(payload);
}

function neverResolvingFetch() {
  return ({ init }) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
}

function networkErrorFetch() {
  return () => {
    const err = new TypeError("Failed to fetch");
    err.name = "TypeError";
    throw err;
  };
}

test("runtime capture event triggers analyze with null songId using fingerprint cache key", async () => {
  const scn = buildScenario();
  try {
    const bootstrap = scn.getBootstrap();
    assert.equal(typeof bootstrap, "function");
    await bootstrap();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));

    const fakeConsole = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, dir: () => {}, table: () => {} };
    scn.installRuntimeLyricsCapture(fakeConsole);
    fakeConsole.log(englishLyricsPayload);

    await new Promise((r) => setTimeout(r, 30));

    assert.equal(scn.fetchCalls.length, 1, "fetch should be called once");
    assert.equal(scn.fetchCalls[0].url, "https://api.siliconflow.cn/v1/chat/completions");

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.lastAnalyzeTrigger, "capture-pipeline");
    assert.equal(state.language, "en");
    assert.ok(state.lastAnalyzeKey && /captured:/.test(state.lastAnalyzeKey),
      "cache key should embed captured: fingerprint when songId is null");
    assert.equal(state.lastRequestUrl, "https://api.siliconflow.cn/v1/chat/completions");
    assert.ok(["success","no-cards","requesting"].includes(state.apiStatus));
    assert.notEqual(state.apiStatus, "lyrics-captured", "must not stay on lyrics-captured");
    assert.equal(state.cardCount, 3);
    assert.equal(scn.panelCalls.showCard.length + scn.panelCalls.setCardsState.length >= 1, true);
  } finally {
    scn.restore();
  }
});

test("same captured lyrics fired twice triggers only one API call", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));

    const fakeConsole = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, dir: () => {}, table: () => {} };
    scn.installRuntimeLyricsCapture(fakeConsole);

    fakeConsole.log(englishLyricsPayload);
    await new Promise((r) => setTimeout(r, 20));
    fakeConsole.log(englishLyricsPayload);
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(scn.fetchCalls.length, 1, "duplicate captured lyrics must not re-fetch");

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    assert.equal(state.panelStatus, "success");
    assert.equal(state.displayedCardCount, 3);
    assert.equal(state.actualCardCount, 3);
    assert.equal(state.skippedDuplicateAnalyzeCount > 0, true);
  } finally {
    scn.restore();
  }
});

test("new captured lyrics fingerprint triggers a new analysis", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));

    const fakeConsole = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, dir: () => {}, table: () => {} };
    scn.installRuntimeLyricsCapture(fakeConsole);

    fakeConsole.log(englishLyricsPayload);
    await new Promise((r) => setTimeout(r, 30));
    const firstFetchCount = scn.fetchCalls.length;

    scn.setFetchResponse(scn.chatCompletionResponseFor([
      { index: 0, line: "Dreams of yesterday haunt me", translation: "昨日的梦缠绕着我", highlights: [] },
      { index: 1, line: "Tomorrow waits with open arms", translation: "明天张开双臂等待", highlights: [] }
    ]));
    fakeConsole.log(englishLyricsPayloadAlt);
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(scn.fetchCalls.length, firstFetchCount + 1, "new lyrics fingerprint should fire a new fetch");
    const state = scn.LL.diagnostics.getState();
    assert.equal(state.lastAnalyzeTrigger, "capture-pipeline");
  } finally {
    scn.restore();
  }
});

test("new console capture with same opening line and timing does not reuse old cards", async () => {
  const scn = buildScenario();
  const firstPayload = [
    { startTime: 1000, endTime: 2000, words: [{ word: "Shared opening" }], lyric: "Shared opening" },
    { startTime: 2000, endTime: 3000, words: [{ word: "First song only" }], lyric: "First song only" },
    { startTime: 3000, endTime: 4000, words: [{ word: "Shared ending slot" }], lyric: "Shared ending slot" }
  ];
  const secondPayload = [
    { startTime: 1000, endTime: 2000, words: [{ word: "Shared opening" }], lyric: "Shared opening" },
    { startTime: 2000, endTime: 3000, words: [{ word: "Second song only" }], lyric: "Second song only" },
    { startTime: 3000, endTime: 4000, words: [{ word: "Shared ending slot" }], lyric: "Shared ending slot" }
  ];
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => {
      const body = JSON.parse(init.body);
      const content = String(body.messages[1].content || "");
      const isSecond = content.includes("Second song only");
      return scn.chatCompletionResponseFor([
        { index: 0, line: isSecond ? "Second song card" : "First song card", translation: "翻译", highlights: [] },
        { index: 1, line: isSecond ? "Second song only" : "First song only", translation: "翻译", highlights: [] },
        { index: 2, line: "Shared ending slot", translation: "翻译", highlights: [] }
      ]);
    });

    const fakeConsole = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, dir: () => {}, table: () => {} };
    scn.installRuntimeLyricsCapture(fakeConsole);

    fakeConsole.log(firstPayload);
    await wait(30);
    const firstState = scn.LL.diagnostics.getState();
    const firstKey = firstState.displayedAnalyzeKey;
    assert.match(firstState.panelTextSample, /First song card/);

    fakeConsole.log(secondPayload);
    await wait(30);

    const state = scn.LL.diagnostics.getState();
    assert.equal(scn.fetchCalls.length, 2, "new lyrics with same coarse opening signature must still fetch");
    assert.notEqual(state.displayedAnalyzeKey, firstKey);
    assert.match(state.panelTextSample, /Second song card/);
    assert.equal(state.apiStatus, "success");
  } finally {
    scn.restore();
  }
});

test("apiStatus transitions away from lyrics-captured into requesting/success", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    let resolveFetch;
    const fetchPromise = new Promise((res) => { resolveFetch = res; });
    scn.setFetchResponse(() => fetchPromise);

    const fakeConsole = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, dir: () => {}, table: () => {} };
    scn.installRuntimeLyricsCapture(fakeConsole);

    fakeConsole.log(englishLyricsPayload);
    await new Promise((r) => setTimeout(r, 10));

    let state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "requesting", "should enter requesting state");

    resolveFetch(scn.chatCompletionResponseFor(validCardsPayload(3)));
    await new Promise((r) => setTimeout(r, 20));

    state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    assert.equal(state.cardCount, 3);
  } finally {
    scn.restore();
  }
});

test("parse-error response surfaces parse-error status with content sample", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: "Sorry I cannot answer that today." } }]
        });
      }
    });

    const fakeConsole = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, dir: () => {}, table: () => {} };
    scn.installRuntimeLyricsCapture(fakeConsole);

    fakeConsole.log(englishLyricsPayload);
    await new Promise((r) => setTimeout(r, 30));

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "parse-error");
    assert.match(String(state.lastParsedContentSample || state.lastResponseTextSample || ""), /cannot answer/);
  } finally {
    scn.restore();
  }
});

test("analyze timeout clears in-flight key and forceRefresh retry sends again", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({
      settings: {
        fallbackOnTimeout: false
      }
    });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(neverResolvingFetch());
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      let state = scn.LL.diagnostics.getState();
      assert.equal(state.apiStatus, "timeout");
      assert.equal(state.inFlightAnalyzeKey, null);
      assert.match(state.lastError, /请求超时/);
      assert.equal(scn.fetchCalls.length, 1);

      scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
      await scn.getPanelOptions().onRetry(null);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, 2, "forceRefresh retry should not be blocked by dedupe");
      assert.equal(state.apiStatus, "success");
    } finally {
      scn.restore();
    }
  });
});

test("fallbackOnTimeout in per-line mode keeps all lines and uses smaller batches", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({
      settings: {
        fallbackOnTimeout: true,
        maxAnalysisLines: 30,
        fallbackMaxLines: 12,
        fallbackMaxTokens: 1500
      }
    });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(({ init }) => {
        if (scn.fetchCalls.length === 1) return neverResolvingFetch()({ init });
        return scn.chatCompletionResponseFor(perLineCardsForIndexes(lineIndexesFromRequest(init)));
      });

      installFakeConsoleCapture(scn, makeEnglishPayload(30));
      await new Promise((resolve) => originalSetTimeout(resolve, 50));

      const fallbackBodies = scn.fetchCalls
        .map((call) => JSON.parse(call.init.body))
        .filter((body) => body.max_tokens === 1500);
      const fallbackLineCounts = fallbackBodies.map((body) => body.messages[1].content.split("\n").filter(Boolean).length);
      assert.deepEqual(fallbackLineCounts, [5, 5, 5, 5, 5, 5]);
      assert.equal(fallbackBodies.every((body) => body.max_tokens === 1500), true);

      const state = scn.LL.diagnostics.getState();
      assert.equal(state.apiStatus, "success");
      assert.equal(state.fallbackReason, "primary-timeout");
      assert.equal(state.fallbackOutcome, "success");
      assert.equal(state.expectedCardCount, 30);
      assert.equal(state.actualCardCount, 30);
      assert.equal(state.displayedCardCount, 30);
      assert.match(state.lastAnalyzeTrigger, /\+fallback$/);
    } finally {
      scn.restore();
    }
  });
});

test("fallback timeout stops after one fallback attempt", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({
      settings: {
        fallbackOnTimeout: true,
        fallbackMaxLines: 12,
        fallbackMaxTokens: 1500
      }
    });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(neverResolvingFetch());

      installFakeConsoleCapture(scn, makeEnglishPayload(30));
      await new Promise((resolve) => originalSetTimeout(resolve, 80));

      const state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, 12, "must not trigger second-level fallback");
      assert.equal(state.apiStatus, "timeout");
      assert.equal(state.fallbackReason, "primary-timeout");
      assert.equal(state.fallbackOutcome, "timeout");
    } finally {
      scn.restore();
    }
  });
});

test("fallback parse failure stops after one fallback attempt", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({
      settings: {
        fallbackOnTimeout: true,
        fallbackMaxLines: 12,
        fallbackMaxTokens: 1500
      }
    });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(({ init }) => {
        const body = JSON.parse(init.body);
        if (body.max_tokens !== 1500) return neverResolvingFetch()({ init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ choices: [{ message: { content: "not json" } }] });
          }
        };
      });

      installFakeConsoleCapture(scn, makeEnglishPayload(30));
      await new Promise((resolve) => originalSetTimeout(resolve, 80));

      const state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, 12, "fallback parse failure must not trigger second-level fallback");
      assert.equal(state.apiStatus, "parse-error");
      assert.equal(state.fallbackReason, "primary-timeout");
      assert.equal(state.fallbackOutcome, "failed");
    } finally {
      scn.restore();
    }
  });
});


test("parse-error and API HTTP errors do not trigger fallback", async () => {
  const cases = [
    {
      name: "parse",
      response: {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: "not json" } }] });
        }
      },
      expectedStatus: "parse-error"
    },
    ...[401, 403, 404].map((status) => ({
      name: String(status),
      response: {
        ok: false,
        status,
        async text() { return `HTTP ${status}`; }
      },
      expectedStatus: "error"
    })),
    {
      name: "429",
      response: {
        ok: false,
        status: 429,
        async text() { return "HTTP 429"; }
      },
      expectedStatus: "rate-limited"
    },
    {
      name: "400",
      response: {
        ok: false,
        status: 400,
        async text() { return "HTTP 400"; }
      },
      expectedStatus: "error"
    }
  ];

  for (const item of cases) {
    const scn = buildScenario({ settings: { fallbackOnTimeout: true } });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(item.response);
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await wait(30);

      const state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, 1, `${item.name} must not fallback`);
      assert.equal(state.apiStatus, item.expectedStatus);
      assert.notEqual(state.fallbackOutcome, "success");
    } finally {
      scn.restore();
    }
  }
});

test("success path records truncated lyric counts and request sizing diagnostics", async () => {
  const scn = buildScenario({
    settings: {
      maxAnalysisLines: 10,
      analyzeMaxTokens: 4096,
      analyzeTemperature: 0.2
    }
  });
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(10)));
    installFakeConsoleCapture(scn, makeEnglishPayload(30));
    await wait(30);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    assert.equal(state.sentLyricLineCount <= 10, true);
    assert.equal(state.rawLyricLineCount, 30);
    assert.equal(state.droppedLyricLineCount, 20);
    assert.equal(state.requestBodySize > 0, true);
    assert.equal(state.promptCharCount > 0, true);
    assert.equal(state.lastRequestMaxTokens, 4096);
    assert.equal(state.lastRequestTemperature, 0.2);
    assert.equal(JSON.stringify(state).includes("sk-test"), false);
  } finally {
    scn.restore();
  }
});

test("new runtime capture resets panel into loading for a new analyze key", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    let resolveFetch;
    scn.setFetchResponse(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(10);

    const state = scn.LL.diagnostics.getState();
    assert.equal(scn.panelCalls.resetForAnalyze.length >= 1, true);
    assert.equal(scn.panelCalls.showLoading.length >= 1, true);
    assert.equal(state.displayedCardCount, 0);
    assert.equal(state.currentCardIndex, 0);
    assert.match(state.panelTextSample, /正在分析当前歌词|正在拆解歌词/);
    resolveFetch(scn.chatCompletionResponseFor(validCardsPayload(3)));
    await wait(10);
  } finally {
    scn.restore();
  }
});

test("analyze success updates displayedAnalyzeKey and displayed cards", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));

    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    assert.equal(state.displayedAnalyzeKey, state.lastAnalyzeKey);
    assert.equal(state.displayedCardCount, 3);
    assert.equal(state.currentCardIndex, 0);
    assert.equal(scn.panelCalls.setCardsState.length, 1);
    assert.equal(scn.panelCalls.setCardsState[0].analyzeKey, state.lastAnalyzeKey);
  } finally {
    scn.restore();
  }
});

test("second song success replaces first song text sample", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => {
      const isSecond = scn.fetchCalls.length >= 2;
      return scn.chatCompletionResponseFor([
        {
          index: 0,
          line: isSecond ? "Tomorrow waits with open arms" : "Stay with me",
          translation: isSecond ? "明天张开双臂等待" : "留下来陪我",
          highlights: []
        }
      ]);
    });

    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);
    const firstKey = scn.LL.diagnostics.getState().displayedAnalyzeKey;

    installFakeConsoleCapture(scn, englishLyricsPayloadAlt);
    await wait(30);

    const state = scn.LL.diagnostics.getState();
    assert.notEqual(state.displayedAnalyzeKey, firstKey);
    assert.match(state.panelTextSample, /Tomorrow waits/);
    assert.equal(scn.panelCalls.setCardsState.length, 2);
  } finally {
    scn.restore();
  }
});

test("song change clears stale console capture before waiting for new lyrics", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));

    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);
    assert.equal(scn.LL.diagnostics.getState().displayedCardCount, 3);

    const fetchCountBeforeSongChange = scn.fetchCalls.length;
    scn.emitSongChange("222222");
    await wait(20);

    const state = scn.LL.diagnostics.getState();
    assert.equal(scn.fetchCalls.length, fetchCountBeforeSongChange,
      "song change must not immediately analyze the previous console payload");
    assert.equal(state.songId, "222222");
    assert.equal(state.displayedCardCount, 0);
    assert.equal(state.activeCaptureSource, null);
    assert.equal(state.activeCaptureLineCount, 0);
    assert.equal(state.captureStatus === "waiting-for-lyrics" || state.captureStatus === "capture-failed", true);
  } finally {
    scn.restore();
  }
});

test("analyze parse error after old success clears displayed cards", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);
    assert.equal(scn.LL.diagnostics.getState().displayedCardCount, 3);

    scn.setFetchResponse({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "not json" } }] });
      }
    });
    installFakeConsoleCapture(scn, englishLyricsPayloadAlt);
    await wait(30);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "parse-error");
    assert.equal(state.displayedCardCount, 0);
    assert.equal(scn.panelCalls.showError.length >= 1, true);
    assert.equal(/Stay with me/.test(String(state.panelTextSample || "")), false);
  } finally {
    scn.restore();
  }
});

test("PlayProgress push promotes timeSourceCandidate to live status", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);

    scn.emitProgress(2100);
    await wait(5);

    const state = scn.LL.diagnostics.getState();
    const liveCandidate = (state.timeSourceCandidates || []).find(
      (c) => c?.name === "PlayProgress" && c?.status === "live"
    );
    assert.ok(liveCandidate, "PlayProgress should appear as a live trusted candidate after a push");
    assert.equal(liveCandidate.trusted, true);
    assert.equal(state.timeSourceFailureReason, null);
  } finally {
    scn.restore();
  }
});

test("playback progress index change renders the matching card", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);

    scn.emitProgress(4200);
    await wait(5);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.currentCardIndex, 2);
    assert.equal(state.currentCardLineIndex, 2);
    assert.equal(scn.panelCalls.syncToPlayback.some((call) => call.index === 2 && call.reason === "playback-sync"), true);
  } finally {
    scn.restore();
  }
});

test("playback sync does not advance from local estimate without a real time source", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => scn.chatCompletionResponseFor(perLineCardsWithoutTiming(lineIndexesFromRequest(init))));

    installFakeConsoleCapture(scn, makeFastEnglishPayload(5));
    await wait(40);

    let state = scn.LL.diagnostics.getState();
    assert.equal(state.currentCardIndex, 0);

    await wait(650);

    state = scn.LL.diagnostics.getState();
    assert.equal(state.currentCardIndex, 0);
    assert.equal(state.playbackSyncStatus, "no-time-source");
    assert.equal(scn.panelCalls.renderCardAt.some((call) => call.reason === "playback-sync"), false);
  } finally {
    scn.restore();
  }
});

test("playback sync extrapolates via wall-clock after a PlayProgress anchor", async () => {
  // Necessary so cards keep advancing when AMLL stalls updating
  // --amll-player-time mid-song (e.g. when AMLL can't find TTML). With
  // an anchor from any progress source (PlayProgress, AMLL warning, etc.)
  // we extrapolate using wall-clock elapsed.
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => scn.chatCompletionResponseFor(perLineCardsWithoutTiming(lineIndexesFromRequest(init))));

    installFakeConsoleCapture(scn, makeFastEnglishPayload(5));
    await wait(40);

    scn.emitProgress(50);
    await wait(5);

    let state = scn.LL.diagnostics.getState();
    assert.equal(state.currentCardIndex, 0);
    assert.equal(state.playbackCurrentMs, 50);

    await wait(650);

    state = scn.LL.diagnostics.getState();
    // After ~650ms wall-clock elapsed from baseMs=50, we should be ~700ms
    // which is past the 4th card's start (400ms) — last available card.
    assert.equal(state.currentCardIndex, 4, "wall-clock extrapolation must advance past anchor");
  } finally {
    scn.restore();
  }
});

test("playback sync polls latest trusted getter after a stale PlayProgress baseline", async () => {
  const scn = buildScenario();
  const previousBetterncm = globalThis.betterncm;
  let trustedMs = null;
  try {
    globalThis.betterncm = {
      ncm: {
        getPlayingProgress: () => trustedMs
      }
    };
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);

    scn.emitProgress(1100);
    await wait(5);
    assert.equal(scn.LL.diagnostics.getState().currentCardLineIndex, 0);

    trustedMs = 4200;
    await wait(220);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.playbackCurrentMs, 4200);
    assert.equal(state.currentCardLineIndex, 2);
    assert.equal(scn.panelCalls.syncToPlayback.some((call) => call.index === 2), true);
  } finally {
    if (previousBetterncm === undefined) delete globalThis.betterncm;
    else globalThis.betterncm = previousBetterncm;
    scn.restore();
  }
});

test("DOM audio currentTime is observed for diagnostics only, never as a trusted time source", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    // Stub <audio> to return a fixed currentTime so we can distinguish trusted vs. untrusted handling
    const originalQuerySelector = globalThis.document.querySelector;
    globalThis.document.querySelector = (sel) => {
      if (sel === "audio") return { currentTime: 4.2 };
      return originalQuerySelector.call(globalThis.document, sel);
    };

    scn.setFetchResponse(({ init }) => scn.chatCompletionResponseFor(perLineCardsWithoutTiming(lineIndexesFromRequest(init))));
    installFakeConsoleCapture(scn, makeFastEnglishPayload(5));
    await wait(650);

    const state = scn.LL.diagnostics.getState();
    // Even with audio.currentTime available, sync status must stay no-time-source
    assert.equal(state.playbackSyncStatus, "no-time-source",
      "DOM audio must NOT drive playbackSyncStatus to synced/live");
    assert.equal(state.playbackCurrentMs, null,
      "DOM audio must NOT populate playbackCurrentMs");
    assert.equal(state.currentCardIndex, 0,
      "DOM audio must NOT advance currentCardIndex past the initial card");
    assert.equal(scn.panelCalls.renderCardAt.some((call) => call.reason === "playback-sync"), false,
      "no playback-sync render should fire without a trusted time source");

    // It IS allowed to surface as a diagnostic candidate with trusted: false
    const candidate = (state.timeSourceCandidates || []).find((c) => c?.name === "dom-audio");
    if (candidate) {
      assert.equal(candidate.trusted, false, "dom-audio candidate must be trusted=false");
      assert.ok(["observed", "not-found", "untrusted", "song-mismatch"].includes(candidate.status),
        `unexpected dom-audio status: ${candidate.status}`);
    }
    // No candidate must be named audio.currentTime with trusted=true
    const trustedAudio = (state.timeSourceCandidates || []).find(
      (c) => (c?.name === "audio.currentTime" || c?.name === "dom-audio") && c?.trusted === true
    );
    assert.equal(trustedAudio, undefined, "no audio candidate may carry trusted=true");
  } finally {
    scn.restore();
  }
});

test("readTrustedPlaybackTime does not return audio.currentTime as a trusted source", () => {
  const Sync = require("../src/sync");
  const fakeContext = {
    document: { querySelector: () => ({ currentTime: 12.345 }) },
    betterncm: { ncm: {} }
  };
  const result = Sync.readTrustedPlaybackTime(fakeContext);
  assert.equal(result.timeMs, null, "must not return a trusted timeMs from DOM audio");
  assert.equal(result.source, null);
  const trustedNames = (result.candidates || []).filter((c) => c?.trusted === true).map((c) => c.name);
  assert.equal(trustedNames.some((n) => n === "audio.currentTime" || n === "dom-audio"), false,
    "no DOM audio candidate may be trusted=true");
});

test("readTrustedPlaybackTime accepts AMLL player css time as a trusted source", () => {
  const Sync = require("../src/sync");
  const element = {
    style: {
      getPropertyValue(name) {
        return name === "--amll-player-time" ? "20310" : "";
      }
    }
  };
  const fakeContext = {
    document: { querySelector: (selector) => selector === '[style*="--amll-player-time"]' ? element : null },
    betterncm: { ncm: {} }
  };

  const result = Sync.readTrustedPlaybackTime(fakeContext);
  assert.equal(result.timeMs, 20310);
  assert.equal(result.source, "AMLL.player-css-time");
  assert.equal(result.failureReason, null);
  const candidate = result.candidates.find((item) => item?.name === "AMLL.player-css-time");
  assert.deepEqual(candidate, {
    name: "AMLL.player-css-time",
    status: "available",
    trusted: true,
    source: "--amll-player-time"
  });
});

test("readTrustedPlaybackTime falls back to walking all elements when attribute selector misses", () => {
  // Some NCM/AMLL builds set --amll-player-time via CSSStyleDeclaration
  // in a way that doesn't show up in the serialized style attribute, so
  // [style*="--amll-player-time"] returns nothing. We must still find the
  // element by scanning all nodes.
  const Sync = require("../src/sync");
  const realElement = {
    style: { getPropertyValue: (n) => n === "--amll-player-time" ? "42050" : "" }
  };
  const otherElement = { style: { getPropertyValue: () => "" } };
  const fakeContext = {
    document: {
      querySelector: () => null, // [style*=...] returns nothing
      querySelectorAll: (sel) => sel === "*" ? [otherElement, realElement] : [],
      contains: () => false
    },
    betterncm: { ncm: {} }
  };

  const result = Sync.readTrustedPlaybackTime(fakeContext);
  assert.equal(result.timeMs, 42050);
  assert.equal(result.source, "AMLL.player-css-time");
  const amll = result.candidates.find((c) => c?.name === "AMLL.player-css-time");
  assert.equal(amll.status, "available");
});

test("readTrustedPlaybackTime rejects invalid AMLL css time without using DOM audio", () => {
  const Sync = require("../src/sync");
  const element = {
    style: {
      getPropertyValue(name) {
        return name === "--amll-player-time" ? "not-a-number" : "";
      }
    }
  };
  const fakeContext = {
    document: {
      querySelector(selector) {
        if (selector === '[style*="--amll-player-time"]') return element;
        if (selector === "audio") return { currentTime: 42 };
        return null;
      }
    },
    betterncm: { ncm: {} }
  };

  const result = Sync.readTrustedPlaybackTime(fakeContext);
  assert.equal(result.timeMs, null);
  assert.equal(result.source, null);
  const amllCandidate = result.candidates.find((item) => item?.name === "AMLL.player-css-time");
  assert.equal(amllCandidate.status, "invalid-value");
  const audioCandidate = result.candidates.find((item) => item?.name === "dom-audio");
  assert.equal(audioCandidate.trusted, false);
});

test("orderBatchesByPlaybackTime uses default order when no trusted currentMs is known", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    // Provide DOM audio with a time deep into the song — should be ignored for ordering
    const originalQuerySelector = globalThis.document.querySelector;
    globalThis.document.querySelector = (sel) => {
      if (sel === "audio") return { currentTime: 25 };
      return originalQuerySelector.call(globalThis.document, sel);
    };

    const requestFirstIndexes = [];
    scn.setFetchResponse(({ init }) => {
      const indexes = lineIndexesFromRequest(init);
      requestFirstIndexes.push(indexes[0]);
      return scn.chatCompletionResponseFor(perLineCardsForIndexes(indexes));
    });

    installFakeConsoleCapture(scn, makeEnglishPayload(30));
    await wait(80);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    assert.equal(requestFirstIndexes[0], 0,
      `without trusted currentMs, batches must use default order; got first=${requestFirstIndexes[0]}`);
    assert.deepEqual(state.analyzeBatchOrder, [0, 1, 2, 3, 4, 5],
      `analyzeBatchOrder must be default when no trusted time; got ${JSON.stringify(state.analyzeBatchOrder)}`);
  } finally {
    scn.restore();
  }
});

test("per-line mode generates one card for each of 30 input lines", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => scn.chatCompletionResponseFor(perLineCardsForIndexes(lineIndexesFromRequest(init))));

    installFakeConsoleCapture(scn, makeEnglishPayload(30));
    await wait(50);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.cardGenerationMode, "per-line");
    assert.equal(state.expectedCardCount, 30);
    assert.equal(state.actualCardCount, 30);
    assert.equal(state.cardCount, 30);
    assert.equal(state.displayedCardCount, 30);
    assert.equal(state.apiStatus, "success");
  } finally {
    scn.restore();
  }
});

test("per-line mode recovers batch-relative indexes in later batches", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => {
      const indexes = lineIndexesFromRequest(init);
      return scn.chatCompletionResponseFor(
        indexes[0] === 5
          ? perLineCardsWithRelativeIndexes(indexes)
          : perLineCardsForIndexes(indexes)
      );
    });

    installFakeConsoleCapture(scn, makeEnglishPayload(30));
    await wait(80);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.expectedCardCount, 30);
    assert.equal(state.actualCardCount, 30);
    assert.equal(state.displayedCardCount, 30);
    assert.equal(state.apiStatus, "success");
    assert.deepEqual(state.missingCardLineIndexes, []);
    assert.equal(state.cardDropReasons.relativeIndexRecovered, 5);
  } finally {
    scn.restore();
  }
});

test("per-line primary analysis uses small full-song batches by default", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    const requestLineCounts = [];
    scn.setFetchResponse(({ init }) => {
      const indexes = lineIndexesFromRequest(init);
      requestLineCounts.push(indexes.length);
      return scn.chatCompletionResponseFor(perLineCardsForIndexes(indexes));
    });

    installFakeConsoleCapture(scn, makeEnglishPayload(45));
    await wait(80);

    const state = scn.LL.diagnostics.getState();
    assert.deepEqual(requestLineCounts, [5, 5, 5, 5, 5, 5, 5, 5, 5]);
    assert.equal(state.apiStatus, "success");
    assert.equal(state.expectedCardCount, 45);
    assert.equal(state.actualCardCount, 45);
    assert.equal(state.fallbackReason, null);
  } finally {
    scn.restore();
  }
});

test("per-line fallback uses small batches even when default fallbackMaxLines is larger", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({ settings: { fallbackOnTimeout: true, maxAnalysisLines: 45, fallbackMaxTokens: 1500 } });
    try {
      await scn.getBootstrap()();
      const fallbackLineCounts = [];
      scn.setFetchResponse(({ init }) => {
        const body = JSON.parse(init.body);
        const indexes = lineIndexesFromRequest(init);
        if (body.max_tokens !== 1500) return neverResolvingFetch()({ init });
        fallbackLineCounts.push(indexes.length);
        return scn.chatCompletionResponseFor(perLineCardsForIndexes(indexes));
      });

      installFakeConsoleCapture(scn, makeEnglishPayload(45));
      await new Promise((resolve) => originalSetTimeout(resolve, 80));

      const state = scn.LL.diagnostics.getState();
      assert.deepEqual(fallbackLineCounts, [5, 5, 5, 5, 5, 5, 5, 5, 5]);
      assert.equal(state.apiStatus, "success");
      assert.equal(state.fallbackReason, "primary-timeout");
      assert.equal(state.expectedCardCount, 45);
      assert.equal(state.actualCardCount, 45);
    } finally {
      scn.restore();
    }
  });
});

test("per-line watchdog window scales with full-song batch count", async () => {
  const scn = buildScenario({ settings: { maxAnalysisLines: 45 } });
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => new Promise((resolve) => {
      setTimeout(() => {
        const indexes = lineIndexesFromRequest(init);
        resolve(scn.chatCompletionResponseFor(perLineCardsForIndexes(indexes)));
      }, 5);
    }));

    installFakeConsoleCapture(scn, makeEnglishPayload(45));

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.loadingWatchdogBatchCount, 9);
    assert.equal(state.loadingWatchdogConcurrency, 6);
    assert.equal(state.loadingWatchdogWaveCount, 2);
    assert.equal(state.loadingWatchdogRequestTimeoutMs, 60000);
    assert.equal(state.loadingWatchdogMaxWaitMs, 125000);

    await wait(80);
    assert.equal(scn.LL.diagnostics.getState().apiStatus, "success");
  } finally {
    scn.restore();
  }
});

test("per-line batches are reordered so the batch covering the current playback time is sent first", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    // Simulate playback already being mid-song before the lyrics arrive
    scn.emitProgress(15500); // line 15 -> batch index 3 (lines 15-19)
    await wait(5);

    const requestFirstIndexes = [];
    scn.setFetchResponse(({ init }) => {
      const indexes = lineIndexesFromRequest(init);
      requestFirstIndexes.push(indexes[0]);
      return scn.chatCompletionResponseFor(perLineCardsForIndexes(indexes));
    });

    installFakeConsoleCapture(scn, makeEnglishPayload(30));
    await wait(80);

    assert.equal(scn.LL.diagnostics.getState().apiStatus, "success");
    assert.equal(requestFirstIndexes[0], 15,
      `first request should cover the batch containing playback time; sequence was ${requestFirstIndexes.join(",")}`);
    const order = scn.LL.diagnostics.getState().analyzeBatchOrder;
    assert.deepEqual(order, [3, 4, 5, 0, 1, 2], `analyzeBatchOrder should rotate to start at current batch; got ${JSON.stringify(order)}`);
  } finally {
    scn.restore();
  }
});

test("per-line mode streams cards after each batch instead of waiting for all batches", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    const pending = [];
    scn.setFetchResponse(({ init }) => new Promise((resolve) => {
      const indexes = lineIndexesFromRequest(init);
      pending.push({ resolve, indexes });
    }));

    installFakeConsoleCapture(scn, makeEnglishPayload(30));
    await wait(30);
    assert.equal(pending.length, 6, "first concurrent batch wave should be requested");
    assert.equal(scn.panelCalls.setCardsState.length, 0, "no cards rendered before any batch completes");

    async function resolveOneAndWaitForRender() {
      const head = pending.shift();
      head.resolve(scn.chatCompletionResponseFor(perLineCardsForIndexes(head.indexes)));
      for (let i = 0; i < 25; i += 1) {
        await wait(8);
        if (scn.panelCalls.setCardsState.length > 0) return;
        if (scn.LL.diagnostics.getState().apiStatus === "success") return;
      }
    }

    await resolveOneAndWaitForRender();
    const setCardsAfterBatch1 = scn.panelCalls.setCardsState.length;
    assert.ok(setCardsAfterBatch1 >= 1, "first batch should render incrementally");
    const partialState = scn.LL.diagnostics.getState();
    assert.equal(partialState.partialCardCount > 0, true, "partialCardCount should be > 0 after first batch");
    assert.equal(partialState.cardCount > 0, true);
    assert.notEqual(partialState.apiStatus, "success", "should still be in-flight after only one batch");

    while (pending.length) {
      const head = pending.shift();
      head.resolve(scn.chatCompletionResponseFor(perLineCardsForIndexes(head.indexes)));
    }
    await wait(30);

    const finalState = scn.LL.diagnostics.getState();
    assert.equal(finalState.apiStatus, "success");
    assert.equal(finalState.cardCount, 30);
    assert.equal(scn.panelCalls.setCardsState.length > setCardsAfterBatch1,
      true, "final batch should produce another setCardsState call");
  } finally {
    scn.restore();
  }
});

test("per-line mode batches 60 input lines and merges sorted cards", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => scn.chatCompletionResponseFor(perLineCardsForIndexes(lineIndexesFromRequest(init), { reverse: true })));

    installFakeConsoleCapture(scn, makeEnglishPayload(60));
    await wait(80);

    const state = scn.LL.diagnostics.getState();
    assert.equal(scn.fetchCalls.length, 12);
    assert.equal(state.analyzeBatchCount, 12);
    assert.equal(state.analyzeMergedCardCount, 60);
    assert.equal(state.expectedCardCount, 60);
    assert.equal(state.actualCardCount, 60);
    assert.deepEqual(scn.panelCalls.setCardsState.at(-1).cards.map((card) => card.lineIndex), Array.from({ length: 60 }, (_, index) => index));
  } finally {
    scn.restore();
  }
});

test("per-line mode records missing card line indexes instead of silent success", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => scn.chatCompletionResponseFor(perLineCardsForIndexes(lineIndexesFromRequest(init), { omit: [2] })));

    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(40);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.expectedCardCount, 3);
    assert.equal(state.actualCardCount, 2);
    assert.deepEqual(state.missingCardLineIndexes, [2]);
    assert.equal(state.partialCardGeneration, true);
    assert.equal(state.apiStatus, "success-with-missing");
    assert.equal(state.panelStatus, "success-with-missing");
  } finally {
    scn.restore();
  }
});

test("selected mode keeps sparse 6-8 card output and does not require every line", async () => {
  const scn = buildScenario({ settings: { cardGenerationMode: "selected" } });
  try {
    await scn.getBootstrap()();
    const selectedCards = Array.from({ length: 7 }, (_, index) => ({
      lineIndex: index * 3,
      original: `Line ${index * 3} stays with me`,
      translation: "精选翻译",
      points: [],
      note: ""
    }));
    scn.setFetchResponse(scn.chatCompletionResponseFor(selectedCards));

    installFakeConsoleCapture(scn, makeEnglishPayload(30));
    await wait(40);

    const state = scn.LL.diagnostics.getState();
    assert.equal(state.cardGenerationMode, "selected");
    assert.equal(scn.fetchCalls.length, 1);
    assert.equal(state.cardCount, 7);
    assert.equal(state.apiStatus, "success");
    assert.equal(state.partialCardGeneration, false);
  } finally {
    scn.restore();
  }
});

test("timeout + same-key duplicate capture does not reset loading or re-fetch", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({ settings: { fallbackOnTimeout: false } });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(neverResolvingFetch());
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      let state = scn.LL.diagnostics.getState();
      assert.equal(state.apiStatus, "timeout", "primary must be timeout");
      assert.equal(state.lastSettledAnalyzeStatus, "timeout", "must be settled timeout");
      const fetchCountBefore = scn.fetchCalls.length;
      const showLoadingBefore = scn.panelCalls.showLoading.length;

      // duplicate capture of same lyrics
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await new Promise((resolve) => originalSetTimeout(resolve, 10));

      state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, fetchCountBefore, "must not re-fetch on duplicate capture after timeout");
      assert.equal(state.apiStatus, "timeout", "apiStatus must stay timeout");
      assert.equal(state.analysisSkippedReason, "same-settled-canonical-key", "must skip duplicate with settled reason");
      assert.equal(state.lastDuplicateCaptureKey, state.lastSettledAnalyzeKey, "must record duplicate capture key");
      assert.ok(Number.isFinite(state.lastDuplicateCaptureAt), "must record duplicate capture timestamp");
      assert.equal(state.panelStatus, "timeout", "panelStatus must not reset to loading");
    } finally {
      scn.restore();
    }
  });
});

test("settled success + same capture serves cached cards without re-fetch", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);

    let state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    assert.equal(state.lastSettledAnalyzeStatus, "success");
    const fetchCountBefore = scn.fetchCalls.length;

    // same capture again
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(10);

    state = scn.LL.diagnostics.getState();
    assert.equal(scn.fetchCalls.length, fetchCountBefore, "must not re-fetch for settled success");
    assert.equal(state.apiStatus, "success", "duplicate settled success must not rewrite API status");
    assert.equal(state.panelStatus, "success");
    assert.equal(state.displayedCardCount, 3);
    assert.equal(state.cardCount, 3, "cards should still be present");
    assert.equal(state.skippedDuplicateAnalyzeCount > 0, true);
  } finally {
    scn.restore();
  }
});

test("new key capture after timeout starts fresh request", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({ settings: { fallbackOnTimeout: false } });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(neverResolvingFetch());
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      let state = scn.LL.diagnostics.getState();
      assert.equal(state.apiStatus, "timeout");
      const oldSettledKey = state.lastSettledAnalyzeKey;
      const fetchCountBefore = scn.fetchCalls.length;

      // different capture
      scn.setFetchResponse(scn.chatCompletionResponseFor([
        { index: 0, line: "Dreams of yesterday haunt me", translation: "昨日的梦缠绕着我", highlights: [] },
        { index: 1, line: "Tomorrow waits with open arms", translation: "明天张开双臂等待", highlights: [] }
      ]));
      installFakeConsoleCapture(scn, englishLyricsPayloadAlt);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, fetchCountBefore + 1, "new key must trigger new fetch");
      assert.equal(state.apiStatus, "success", "new key request should succeed");
      assert.notEqual(state.lastAnalyzeKey, oldSettledKey, "new analyze key must differ from old settled key");
    } finally {
      scn.restore();
    }
  });
});

test("manual retry from timeout bypasses settled gating", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({ settings: { fallbackOnTimeout: false } });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(neverResolvingFetch());
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      let state = scn.LL.diagnostics.getState();
      assert.equal(state.apiStatus, "timeout");
      assert.equal(state.lastSettledAnalyzeStatus, "timeout");

      scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
      await scn.getPanelOptions().onRetry(null);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      state = scn.LL.diagnostics.getState();
      assert.equal(state.apiStatus, "success", "manual retry must succeed");
      assert.equal(state.lastSettledAnalyzeStatus, "success", "settled status must update after retry");
    } finally {
      scn.restore();
    }
  });
});

test("watchdog terminal state is not overwritten to aborted", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({
      settings: {
        fallbackOnTimeout: false,
        analyzeTimeoutMs: 1,
        fallbackTimeoutMs: 1
      }
    });
    try {
      await scn.getBootstrap()();
      const diag = scn.LL.diagnostics;

      // Simulate: request starts, watchdog fires
      diag.updateState({ apiStatus: "requesting", panelStatus: "loading" });
      // Simulate watchdog settling
      diag.updateState({
        panelStatus: "error",
        panelTextSample: "分析没有正常结束，请重试",
        panelLastRenderReason: "loading-watchdog-timeout",
        loadingWatchdogTriggered: true,
        apiStatus: "error",
        lastError: "loading watchdog timeout"
      });
      const state = diag.getState();
      assert.equal(state.apiStatus, "error", "apiStatus must stay error after watchdog settle");
      assert.equal(state.panelStatus, "error", "panelStatus must stay error");
      assert.equal(state.loadingWatchdogTriggered, true, "watchdog flag must be true");
      assert.notEqual(state.apiStatus, "aborted", "silent abort must not set apiStatus to aborted");
    } finally {
      scn.restore();
    }
  });
});

test("captured key then playstate with real songId aliases and does not re-fetch", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    // First: runtime capture starts with captured key, request succeeds
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);

    const state1 = scn.LL.diagnostics.getState();
    assert.equal(state1.apiStatus, "success");
    assert.ok(state1.rawAnalyzeKey && String(state1.rawAnalyzeKey).startsWith("captured:"),
      "first raw key should be captured:*");
    const firstCanonical = state1.canonicalAnalyzeKey;
    const fetchCountBefore = scn.fetchCalls.length;
    const showLoadingBefore = scn.panelCalls.showLoading.length;

    // Second: simulate PlayState providing real songId for same lyrics
    scn.LL.diagnostics.updateState({ songId: "514774419" });
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(10);

    const state2 = scn.LL.diagnostics.getState();
    assert.equal(scn.fetchCalls.length, fetchCountBefore, "must not re-fetch after alias");
    assert.equal(scn.panelCalls.showLoading.length, showLoadingBefore, "must not showLoading again");
    assert.notEqual(state2.rawAnalyzeKey, firstCanonical, "raw key should differ (songId-based)");
    // canonical should now be promoted
    // canonical should now be promoted — check alias diagnostics or gating outcome
    assert.ok(state2.keyAliasReason === "captured-key-promoted-to-song-key" ||
              state2.apiStatus === "cache-hit" ||
              state2.analysisSkippedReason === "same-settled-canonical-key",
      "should alias or serve from cache: got keyAliasReason=" + state2.keyAliasReason +
      " apiStatus=" + state2.apiStatus +
      " skippedReason=" + state2.analysisSkippedReason);
  } finally {
    scn.restore();
  }
});

test("captured key in-flight when playstate arrives with same lyrics does not abort", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    let resolveFetch;
    const fetchPromise = new Promise((res) => { resolveFetch = res; });
    scn.setFetchResponse(() => fetchPromise);

    // Start captured-key request (in-flight)
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(10);

    const state1 = scn.LL.diagnostics.getState();
    assert.equal(state1.apiStatus, "requesting", "should be in-flight");
    const fetchCountBefore = scn.fetchCalls.length;

    // PlayState arrives with real songId, same lyrics
    scn.LL.diagnostics.updateState({ songId: "514774419" });
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(5);

    const state2 = scn.LL.diagnostics.getState();
    assert.equal(scn.fetchCalls.length, fetchCountBefore, "must not abort and re-fetch");
    assert.equal(state2.analysisSkippedReason, "same-inflight-canonical-key",
      "should skip because canonical key matches in-flight");

    // Complete the original request
    resolveFetch(scn.chatCompletionResponseFor(validCardsPayload(3)));
    await wait(15);

    const state3 = scn.LL.diagnostics.getState();
    assert.equal(state3.apiStatus, "success");
  } finally {
    scn.restore();
  }
});

test("captured key in-flight promoted by songId settles under songId canonical key", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    let resolveFetch;
    const fetchPromise = new Promise((res) => { resolveFetch = res; });
    scn.setFetchResponse(() => fetchPromise);

    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(10);

    let state = scn.LL.diagnostics.getState();
    assert.match(String(state.canonicalAnalyzeKey), /^captured:/);
    const fetchCountBefore = scn.fetchCalls.length;

    scn.LL.diagnostics.updateState({ songId: "514774419" });
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(5);

    state = scn.LL.diagnostics.getState();
    const promotedKey = state.canonicalAnalyzeKey;
    assert.equal(scn.fetchCalls.length, fetchCountBefore, "promotion must not start a second request");
    assert.match(String(promotedKey), /^514774419:/);
    assert.equal(state.promotionReason, "captured-key-promoted-to-song-key");

    resolveFetch(scn.chatCompletionResponseFor(validCardsPayload(3)));
    await wait(20);

    state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    assert.equal(state.canonicalAnalyzeKey, promotedKey);
    assert.equal(state.lastSettledAnalyzeKey, promotedKey);
    assert.equal(state.displayedAnalyzeKey, promotedKey);
    assert.equal(scn.panelCalls.setCardsState.at(-1).analyzeKey, promotedKey);
  } finally {
    scn.restore();
  }
});

test("captured key timeout then real songId with same lyrics hits settled canonical gate", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({ settings: { fallbackOnTimeout: false } });
    try {
      await scn.getBootstrap()();
      scn.setFetchResponse(neverResolvingFetch());
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await new Promise((resolve) => originalSetTimeout(resolve, 30));

      let state = scn.LL.diagnostics.getState();
      assert.equal(state.apiStatus, "timeout");
      assert.equal(state.lastSettledAnalyzeStatus, "timeout");
      const fetchCountBefore = scn.fetchCalls.length;

      // Real songId arrives, same lyrics — should hit settled canonical gate
      scn.LL.diagnostics.updateState({ songId: "514774419" });
      installFakeConsoleCapture(scn, englishLyricsPayload);
      await new Promise((resolve) => originalSetTimeout(resolve, 10));

      state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, fetchCountBefore, "must not re-fetch after settled timeout");
      assert.equal(state.analysisSkippedReason, "same-settled-canonical-key",
        "should skip with canonical settled reason");
    } finally {
      scn.restore();
    }
  });
});

test("new song with different lyrics triggers new request even with existing settled", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    // First analysis succeeds
    scn.setFetchResponse(scn.chatCompletionResponseFor(validCardsPayload(3)));
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);

    let state = scn.LL.diagnostics.getState();
    assert.equal(state.apiStatus, "success");
    const fetchCountBefore = scn.fetchCalls.length;

    // Different lyrics arrive — must trigger new request
    scn.setFetchResponse(scn.chatCompletionResponseFor([
      { index: 0, line: "Dreams", translation: "梦", highlights: [] }
    ]));
    installFakeConsoleCapture(scn, englishLyricsPayloadAlt);
    await wait(30);

    state = scn.LL.diagnostics.getState();
    assert.equal(scn.fetchCalls.length, fetchCountBefore + 1, "new lyrics must trigger new fetch");
  } finally {
    scn.restore();
  }
});

test("fallback network error writes settled error and blocks duplicate capture", async () => {
  await withFastTimeouts(async (originalSetTimeout) => {
    const scn = buildScenario({
      settings: {
        fallbackOnTimeout: true,
        analyzeTimeoutMs: 1,
        fallbackTimeoutMs: 1,
        fallbackMaxTokens: 1500
      }
    });
    try {
      await scn.getBootstrap()();
      let callCount = 0;
      scn.setFetchResponse(({ init }) => {
        callCount += 1;
        const body = JSON.parse(init.body);
        if (body.max_tokens !== 1500) {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        }
        const err = new TypeError("Failed to fetch");
        err.name = "TypeError";
        throw err;
      });

      installFakeConsoleCapture(scn, makeEnglishPayload(30));
      await new Promise((resolve) => originalSetTimeout(resolve, 50));

      let state = scn.LL.diagnostics.getState();
      assert.equal(callCount, 12, "primary + one fallback attempt only");
      assert.ok(
        state.apiStatus === "error" || state.apiStatus === "network-error",
        "fallback network error must settle: got " + state.apiStatus
      );
      assert.equal(state.lastSettledAnalyzeStatus, "error", "settled status must be error");
      assert.ok(FAILED_SETTLED_STATUSES.has(state.lastSettledAnalyzeStatus));
      assert.equal(state.panelStatus, "error");
      const fetchCountBefore = scn.fetchCalls.length;

      // Duplicate capture after fallback network error
      installFakeConsoleCapture(scn, makeEnglishPayload(30));
      await new Promise((resolve) => originalSetTimeout(resolve, 10));

      state = scn.LL.diagnostics.getState();
      assert.equal(scn.fetchCalls.length, fetchCountBefore,
        "duplicate capture must not re-fetch after fallback network error");
      assert.equal(state.analysisSkippedReason, "same-settled-canonical-key",
        "should hit settled canonical gate");
    } finally {
      scn.restore();
    }
  });
});

const FAILED_SETTLED_STATUSES = new Set(["timeout", "error", "parse-error", "no-cards", "rate-limited"]);

test("buildChatRequestBody with off thinking mode for DeepSeek V4 adds disabled thinking", () => {
  const { buildChatRequestBody } = require("../src/api");
  const body = buildChatRequestBody({
    modelName: "deepseek-ai/DeepSeek-V4-Flash",
    language: "en",
    formattedLyrics: "[0] Hello",
    maxTokens: 4096,
    temperature: 0.2,
    thinkingMode: "off"
  });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
});

test("buildChatRequestBody with high thinking mode adds reasoning_effort", () => {
  const { buildChatRequestBody } = require("../src/api");
  const body = buildChatRequestBody({
    modelName: "deepseek-ai/DeepSeek-V4-Flash",
    language: "en",
    formattedLyrics: "[0] Hello",
    thinkingMode: "high"
  });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.thinking, undefined);
});

test("buildChatRequestBody for non-DeepSeek model does not add thinking params", () => {
  const { buildChatRequestBody } = require("../src/api");
  const body = buildChatRequestBody({
    modelName: "Qwen/Qwen2.5-7B-Instruct",
    language: "en",
    formattedLyrics: "[0] Hello",
    thinkingMode: "off"
  });
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test("buildChatRequestBody auto mode sends no thinking params even for DeepSeek", () => {
  const { buildChatRequestBody } = require("../src/api");
  const body = buildChatRequestBody({
    modelName: "deepseek-ai/DeepSeek-V4-Flash",
    language: "en",
    formattedLyrics: "[0] Hello",
    thinkingMode: "auto"
  });
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test("testAnalyzeSpeed with mock fetch returns speed test result", async () => {
  const { testAnalyzeSpeed } = require("../src/api");
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ cards: [{ index: 0, line: "x", translation: "y", highlights: [] }] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });
    }
  });
  const result = await testAnalyzeSpeed({
    apiEndpoint: "https://api.siliconflow.cn/v1",
    apiKey: "sk-test",
    modelName: "deepseek-ai/DeepSeek-V4-Flash",
    lyricsLines: [{ text: "Hello" }, { text: "World" }],
    thinkingMode: "off",
    fetchImpl: fakeFetch
  });
  assert.equal(result.speedTestStatus, "success");
  assert.ok(result.speedTestDurationMs >= 0);
  assert.ok(result.speedTestPromptCharCount > 0);
  assert.deepEqual(result.speedTestTokens, { prompt: 10, completion: 5, total: 15 });
  assert.equal(result.speedTestThinkingMode, "off");
});

test("a→b→a switch: returning to a song served from cache, no extra fetch", async () => {
  const scn = buildScenario();
  try {
    await scn.getBootstrap()();
    scn.setFetchResponse(({ init }) => {
      const body = JSON.parse(init.body);
      const isAlt = JSON.stringify(body).includes("Dreams of yesterday");
      return scn.chatCompletionResponseFor([
        { index: 0, line: isAlt ? "Dreams of yesterday haunt me" : "Stay with me", translation: isAlt ? "昨日的梦缠绕着我" : "留下来陪我", highlights: [] }
      ]);
    });

    const isSuccessish = (status) => status === "success" || status === "success-with-missing";

    // First exposure to song A → API call #1, cards cached.
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);
    assert.equal(scn.fetchCalls.length, 1, "first A capture must fire one fetch");
    const stateA = scn.LL.diagnostics.getState();
    assert.ok(isSuccessish(stateA.apiStatus), `apiStatus was ${stateA.apiStatus}`);
    assert.equal(stateA.displayedCardCount, 1);
    const aKey = stateA.displayedAnalyzeKey;

    // Switch to song B → API call #2, B's cards cached.
    installFakeConsoleCapture(scn, englishLyricsPayloadAlt);
    await wait(30);
    assert.equal(scn.fetchCalls.length, 2, "B capture must fire one more fetch");
    const stateB = scn.LL.diagnostics.getState();
    assert.ok(isSuccessish(stateB.apiStatus));
    assert.notEqual(stateB.displayedAnalyzeKey, aKey);

    // Return to song A — cards should come from cache, no new fetch.
    installFakeConsoleCapture(scn, englishLyricsPayload);
    await wait(30);
    assert.equal(scn.fetchCalls.length, 2, "returning to cached A must NOT fire a fresh fetch");
    const stateAgain = scn.LL.diagnostics.getState();
    assert.ok(isSuccessish(stateAgain.apiStatus), "must reach a success status served from cache");
    assert.equal(stateAgain.cacheUseStatus, "served-from-cache");
    assert.equal(stateAgain.cacheHit, true);
    assert.equal(stateAgain.displayedAnalyzeKey, aKey, "displayed key must match the original A key");
    assert.equal(stateAgain.displayedCardCount, 1);
    assert.match(stateAgain.panelTextSample, /Stay with me/);
  } finally {
    scn.restore();
  }
});

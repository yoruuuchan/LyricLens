(function initLyricLensDiagnostics(root) {
  "use strict";

  const PREFIX = "[LyricLens:diagnostics]";
  const DEBUG_LOCAL_STORAGE_KEY = "ll_debug";
  const DEFAULT_MAX_STRING = 120;
  const DEFAULT_MAX_KEYS = 12;
  const DEFAULT_MAX_ARRAY = 4;
  const DEFAULT_MAX_DEPTH = 2;

  function isDebugEnabled(context = root, settings) {
    if (context?.__LYRICLENS_DEBUG === true) return true;
    if (settings?.debug === true || settings?.debugEnabled === true) return true;
    try {
      const value = context?.localStorage?.getItem(DEBUG_LOCAL_STORAGE_KEY);
      return /^(1|true|yes|on)$/i.test(String(value || ""));
    } catch (_) {
      return false;
    }
  }

  function truncateString(value, maxString = DEFAULT_MAX_STRING) {
    const text = String(value ?? "");
    if (text.length <= maxString) return text;
    return `${text.slice(0, maxString)}…(${text.length})`;
  }

  function safeSample(value, options = {}, seen = new WeakSet(), depth = 0) {
    const maxString = options.maxString ?? DEFAULT_MAX_STRING;
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    const maxArray = options.maxArray ?? DEFAULT_MAX_ARRAY;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

    if (value == null) return value;
    const type = typeof value;
    if (type === "string") return truncateString(value, maxString);
    if (type === "number" || type === "boolean") return value;
    if (type === "bigint") return String(value);
    if (type === "function") return `[Function ${value.name || "anonymous"}]`;
    if (type !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    if (depth >= maxDepth) return Array.isArray(value) ? `[Array(${value.length})]` : objectSummary(value);

    seen.add(value);
    if (Array.isArray(value)) {
      const sample = value.slice(0, maxArray).map((item) => safeSample(item, options, seen, depth + 1));
      if (value.length > maxArray) sample.push(`…(${value.length})`);
      return sample;
    }

    const keys = Object.keys(value);
    const output = {};
    keys.slice(0, maxKeys).forEach((key) => {
      output[key] = safeSample(value[key], options, seen, depth + 1);
    });
    if (keys.length > maxKeys) output.__truncatedKeys = keys.length - maxKeys;
    return output;
  }

  function objectSummary(value) {
    const keys = value && typeof value === "object" ? Object.keys(value) : [];
    return `{${keys.slice(0, DEFAULT_MAX_KEYS).join(",")}${keys.length > DEFAULT_MAX_KEYS ? ",…" : ""}}`;
  }

  function describeValue(value, options) {
    if (value == null) return { exists: value !== undefined && value !== null, type: String(value), sample: value };
    const type = Array.isArray(value) ? "array" : typeof value;
    return { exists: true, type, sample: safeSample(value, options) };
  }

  function safeInvoke(name, fn, options = {}) {
    if (typeof fn !== "function") {
      return {
        name,
        ok: false,
        exists: false,
        type: typeof fn,
        sample: undefined,
        value: undefined,
        error: "not available"
      };
    }
    try {
      const value = fn();
      const described = describeValue(value, options);
      return {
        name,
        ok: true,
        exists: true,
        type: "function",
        sample: described.sample,
        value,
        error: null
      };
    } catch (err) {
      return {
        name,
        ok: false,
        exists: true,
        type: "error",
        sample: undefined,
        value: undefined,
        error: errorMessage(err)
      };
    }
  }

  async function safeInvokeAsync(name, fn, options = {}) {
    if (typeof fn !== "function") {
      return {
        name,
        ok: false,
        exists: false,
        type: typeof fn,
        sample: undefined,
        value: undefined,
        error: "not available"
      };
    }
    try {
      const value = await fn();
      const described = describeValue(value, options);
      return {
        name,
        ok: true,
        exists: true,
        type: "function",
        sample: described.sample,
        value,
        error: null
      };
    } catch (err) {
      return {
        name,
        ok: false,
        exists: true,
        type: "error",
        sample: undefined,
        value: undefined,
        error: errorMessage(err)
      };
    }
  }

  function probeValue(name, getter, options = {}) {
    try {
      const value = getter();
      const described = describeValue(value, options);
      return { name, ok: described.exists, error: null, ...described };
    } catch (err) {
      return {
        name,
        ok: false,
        exists: false,
        type: "error",
        sample: undefined,
        error: errorMessage(err)
      };
    }
  }

  function sampleLyricsPayload(payload) {
    const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
    const lyricText = getLyricText(payload);
    return {
      keys,
      has: {
        lrc: Boolean(payload?.lrc),
        yrc: Boolean(payload?.yrc),
        tlyric: Boolean(payload?.tlyric),
        romalrc: Boolean(payload?.romalrc)
      },
      lyricLength: lyricText.length,
      firstLines: lyricText.split(/\r?\n/).filter(Boolean).slice(0, 2).map((line) => truncateString(line, 96))
    };
  }

  function getLyricText(payload) {
    if (typeof payload === "string") return payload;
    if (!payload || typeof payload !== "object") return "";
    const candidates = [
      payload.lrc?.lyric,
      payload.yrc?.lyric,
      payload.lyric,
      payload.rawLyric,
      payload.data?.lrc?.lyric,
      payload.data?.lyric
    ];
    return String(candidates.find((item) => typeof item === "string") || "");
  }

  function errorMessage(err) {
    if (!err) return "";
    return String(err.message || err);
  }

  function createDiagnostics(context = root, options = {}) {
    let debug = options.debug ?? isDebugEnabled(context, options.settings);
    let playProgressCount = 0;
    let lastPlayProgressLogAt = 0;
    const state = {
      loaded: true,
      songId: null,
      getPlayingStatus: "not-run",
      getPlayingSongStatus: "not-run",
      playbackStatus: null,
      playStateStatus: "not-run",
      lastPlayStateArgs: null,
      playProgressEventCount: 0,
      lastPlayProgressArgs: null,
      playProgressAcceptedMs: null,
      playProgressRejectedReason: null,
      playProgressLastEventAt: null,
      language: null,
      lyricsSource: "none",
      lyricLineCount: 0,
      lastLyricsSummary: null,
      cardCount: 0,
      cardGenerationMode: null,
      expectedCardCount: null,
      actualCardCount: null,
      missingCardLineIndexes: [],
      analyzeBatchCount: null,
      analyzeBatchIndex: null,
      analyzeBatchSize: null,
      analyzeMergedCardCount: null,
      partialCardGeneration: false,
      currentCardIndex: null,
      currentAnalyzeKey: null,
      displayedAnalyzeKey: null,
      displayedCardCount: 0,
      currentCardLineIndex: null,
      currentCardStartMs: null,
      currentCardEndMs: null,
      currentCardOriginal: null,
      previousCardLineIndex: null,
      previousCardOriginal: null,
      previousCardStartMs: null,
      nextCardLineIndex: null,
      nextCardOriginal: null,
      nextCardStartMs: null,
      panelLastRenderReason: null,
      panelLastRenderedAt: null,
      lastSongChangeAt: null,
      lastPanelResetReason: null,
      staleCardsCleared: false,
      playbackSyncEnabled: false,
      playbackSyncStatus: "disabled",
      playbackCurrentMs: null,
      playbackEstimatedMs: null,
      playbackTimerActive: false,
      lastPlaybackSyncAt: null,
      apiStatus: "idle",
      lastError: null,
      cssStatus: null,
      lastCapturedAt: null,
      lastCaptureSource: null,
      lastAnalyzeTrigger: null,
      lastAnalyzeKey: null,
      analysisSkippedReason: null,
      inFlightAnalyzeKey: null,
      lastRequestUrl: null,
      lastResponseStatus: null,
      lastResponseTextSample: null,
      lastParsedContentSample: null,
      lastParsedCardsCount: 0,
      lastNormalizedCardsCount: 0,
      cardDropReasons: null,
      analyzeTimeoutMs: null,
      lastRequestStartedAt: null,
      lastRequestEndedAt: null,
      lastRequestDurationMs: null,
      timeoutStage: null,
      rawLyricLineCount: 0,
      sentLyricLineCount: 0,
      droppedLyricLineCount: 0,
      requestBodySize: 0,
      promptCharCount: 0,
      lastRequestModel: null,
      lastRequestMaxTokens: null,
      lastRequestTemperature: null,
      fallbackReason: null,
      fallbackOutcome: null,
      lastSettledAnalyzeKey: null,
      lastSettledAnalyzeStatus: null,
      lastSettledAt: 0,
      panelStatus: null,
      panelLoadingStartedAt: null,
      loadingWatchdogTriggered: false,
      lastDuplicateCaptureKey: null,
      lastDuplicateCaptureAt: 0,
      abortedAnalyzeKey: null,
      abortReason: null,
      rawAnalyzeKey: null,
      canonicalAnalyzeKey: null,
      analyzeKeyAliasFrom: null,
      analyzeKeyAliasTo: null,
      keyAliasReason: null,
      promotionReason: null,
      lastKeyAliasAt: 0,
      timeSourceCandidates: [],
      timeSourceFailureReason: null,
      cacheHit: false,
      cacheKey: null,
      cacheUseStatus: "not-checked",
      modelThinkingMode: null,
      lastRequestThinkingPayload: null,
      reasoningEffort: null,
      responsePromptTokens: null,
      responseCompletionTokens: null,
      responseReasoningTokens: null,
      responseTotalTokens: null,
      finishReason: null,
      speedTestModel: null,
      speedTestStartedAt: null,
      speedTestDurationMs: null,
      speedTestStatus: null,
      speedTestError: null,
      speedTestResponseSample: null,
      speedTestThinkingMode: null,
      speedTestPromptCharCount: null,
      speedTestRequestBodySize: null,
      speedTestTokens: null,
      responseFormatMode: null,
      lastRequestResponseFormat: null,
      responseFormatUnsupported: false,
      responseFormatFallbackAttempted: false,
      parseFailureReason: null,
      rawContentSample: null,
      rawContentLength: null,
      extractedJsonStrategy: null,
      finishReasonWasLength: false,
      forceRefreshReason: null,
      lastRetryAt: null,
      lastAutoAnalyzeAt: null,
      panelMounted: false,
      panelVisible: false,
      panelTextSample: null,
      llDomCount: 0,
      panelDraggable: false,
      panelResizable: false,
      panelBounds: null,
      panelCollapsed: false,
      autoFollow: true,
      lastRawSongIdCandidate: null,
      lastExtractedSongId: null,
      lastSongIdExtractStrategy: null,
      lastPlayStateArgsSummary: null,
      lastPlayStateStatus: null,
      lastPlayStateAt: null,
      autoFollowSuppressedUntil: null,
      lastManualNavigationAt: null,
      autoFollowRestoreReason: null,
      playbackPaused: false,
      playStateListenerRegistered: false,
      playStateEventCount: 0,
      playStateLastEventAt: null,
      playStateLastError: null,
      lastConsoleSongIdCandidate: null,
      lastConsoleSongIdAt: null,
      consoleSongIdExtractStrategy: null,
      rawSongIdCandidate: null,
      normalizedTrackIdCount: 0,
      lastNormalizedTrackIdFrom: null,
      lastNormalizedTrackIdTo: null,
      ignoredExternalErrorCount: 0,
      lastIgnoredExternalErrorSample: null,
      runtimeLyricsCaptureInstalled: false,
      runtimeLyricsCaptureEventCount: 0,
      lastLyricsCaptureReason: null,
      lastLyricsCaptureLineCount: null,
      lastLyricsCaptureAt: null,
      captureStatus: "initializing",
      captureSource: null,
      analyzeTriggerStatus: "blocked-no-lyrics",
      analyzeTriggerBlockedReason: null,
      domLyricsRawLineCount: 0,
      domLyricsFilteredLineCount: 0,
      domLyricsRejectedReason: null,
      captureConfidence: null,
      lastCaptureSample: null,
      lastRejectedCaptureSample: null,
      activeCaptureSource: null,
      activeCaptureLineCount: 0,
      activeCaptureScore: 0,
      skippedCaptureReason: null,
      skippedDuplicateAnalyzeCount: 0,
      lastSkippedCaptureSample: null,
      diagnosticsSchemaVersion: "1.2"
    };

    function enabled() {
      return Boolean(debug || isDebugEnabled(context, options.settings));
    }

    function setDebug(value) {
      debug = Boolean(value);
    }

    function log(event, data) {
      if (!enabled()) return;
      try {
        console.log(PREFIX, event, data === undefined ? "" : safeSample(data, { maxDepth: 3 }));
      } catch (_) {}
    }

    function updateState(partial) {
      Object.assign(state, partial || {});
      if (partial?.lastError) state.lastError = truncateString(partial.lastError, 180);
      return { ...state };
    }

    function getState() {
      return { ...state, debug: enabled() };
    }

    function probeRuntime() {
      const report = {
        "window.betterncm": probeValue("window.betterncm", () => context.betterncm),
        "betterncm.ncm": probeValue("betterncm.ncm", () => context.betterncm?.ncm),
        "betterncm.ncm.getPlaying": safeGetPlaying(context),
        "betterncm.ncm.getPlayingSong": safeGetPlayingSong(context),
        "legacyNativeCmder": probeValue("legacyNativeCmder", () => context.legacyNativeCmder),
        "window.currentLyrics": probeValue("window.currentLyrics", () => context.currentLyrics),
        "window.CPPLYRICS_INTERNALS.currentLyrics": probeValue("window.CPPLYRICS_INTERNALS.currentLyrics", () => context.CPPLYRICS_INTERNALS?.currentLyrics),
        "window.AMLL.currentLyrics": probeValue("window.AMLL.currentLyrics", () => context.AMLL?.currentLyrics),
        "betterncm.app.readConfig": probeValue("betterncm.app.readConfig", () => context.betterncm?.app?.readConfig),
        "betterncm.app.writeConfig": probeValue("betterncm.app.writeConfig", () => context.betterncm?.app?.writeConfig)
      };
      log("runtime probe", report);
      return report;
    }

    function probeFunctionWithSample(name, getter) {
      let fn;
      try {
        fn = getter();
      } catch (err) {
        return { name, ok: false, exists: false, type: "error", sample: undefined, error: errorMessage(err) };
      }
      if (typeof fn !== "function") {
        return { name, ok: false, exists: false, type: typeof fn, sample: undefined, error: "not available" };
      }
      const invoked = safeInvoke(name, () => fn.call(context.betterncm?.ncm));
      return { name, ok: invoked.ok, exists: true, type: "function", sample: invoked.sample, error: invoked.error };
    }

    function recordLyricsPayload(source, payload) {
      const sample = sampleLyricsPayload(payload);
      log(`lyrics payload: ${source}`, sample);
      return sample;
    }

    function recordPlayProgressArgs(args) {
      playProgressCount += 1;
      const now = Date.now();
      const sample = Array.from(args || []).map((item) => safeSample(item, { maxDepth: 2 }));
      updateState({
        playProgressEventCount: playProgressCount,
        lastPlayProgressArgs: sample,
        playProgressLastEventAt: now
      });
      if (playProgressCount <= 5 || now - lastPlayProgressLogAt >= 10000) {
        lastPlayProgressLogAt = now;
        log("PlayProgress args", {
          count: playProgressCount,
          args: sample
        });
      }
    }

    function recordPlayStateArgs(args, parsed) {
      const sample = Array.from(args || []).map((item) => safeSample(item, { maxDepth: 1 }));
      const partial = {
        lastPlayStateArgs: sample,
        playStateStatus: parsed?.playStateStatus || "received",
        playbackStatus: parsed?.playbackStatus || null
      };
      if (parsed?.songId) partial.songId = parsed.songId;
      updateState(partial);
      log("PlayState args", sample);
      return getState();
    }

    function recordCss(status) {
      updateState({ cssStatus: status });
      log("css", status);
    }

    return {
      enabled,
      setDebug,
      log,
      updateState,
      getState,
      probeRuntime,
      recordLyricsPayload,
      recordPlayProgressArgs,
      recordPlayStateArgs,
      recordCss
    };
  }

  function safeGetPlaying(context = root) {
    const fn = context.betterncm?.ncm?.getPlaying;
    const result = safeInvoke("betterncm.ncm.getPlaying", typeof fn === "function" ? () => fn.call(context.betterncm.ncm) : undefined);
    recordPlaybackProbe(context, "getPlayingStatus", result);
    return result;
  }

  function safeGetPlayingSong(context = root) {
    const fn = context.betterncm?.ncm?.getPlayingSong;
    const result = safeInvoke("betterncm.ncm.getPlayingSong", typeof fn === "function" ? () => fn.call(context.betterncm.ncm) : undefined);
    recordPlaybackProbe(context, "getPlayingSongStatus", result);
    return result;
  }

  function recordPlaybackProbe(context, stateKey, result) {
    const diagnostics = context?.LyricLens?.diagnostics;
    if (!diagnostics?.updateState) return;
    let status = "not-available";
    const partial = {};
    if (result?.ok) {
      status = result.value == null ? "null" : "ok";
    } else if (result?.error) {
      status = `error: ${truncateString(result.error, 120)}`;
    }
    partial[stateKey] = status;
    diagnostics.updateState(partial);
  }

  async function safeReadConfig(context = root, key, defaultValue) {
    const fn = context.betterncm?.app?.readConfig;
    return safeInvokeAsync("betterncm.app.readConfig", typeof fn === "function" ? () => fn.call(context.betterncm.app, key, defaultValue) : undefined);
  }

  async function safeWriteConfig(context = root, key, value) {
    const fn = context.betterncm?.app?.writeConfig;
    return safeInvokeAsync("betterncm.app.writeConfig", typeof fn === "function" ? () => fn.call(context.betterncm.app, key, value) : undefined);
  }

  function safeAppendRegisterCall(context = root, eventName, targetName, callback) {
    const fn = context.legacyNativeCmder?.appendRegisterCall;
    return safeInvoke(
      `legacyNativeCmder.appendRegisterCall:${eventName}`,
      typeof fn === "function" ? () => fn.call(context.legacyNativeCmder, eventName, targetName, callback) : undefined
    );
  }

  const api = {
    PREFIX,
    DEBUG_LOCAL_STORAGE_KEY,
    isDebugEnabled,
    truncateString,
    safeSample,
    safeInvoke,
    safeInvokeAsync,
    probeValue,
    sampleLyricsPayload,
    createDiagnostics,
    safeGetPlaying,
    safeGetPlayingSong,
    safeReadConfig,
    safeWriteConfig,
    safeAppendRegisterCall
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Diagnostics = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

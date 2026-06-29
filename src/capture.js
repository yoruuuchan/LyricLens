(function initLyricLensCapture(root) {
  "use strict";

  // ── Source priority (lower index = higher priority) ──
  const SOURCE_ORDER = ["amll-state", "console", "dom-lyrics", "cache"];

  // ── Capture quality scoring ──

  const SOURCE_SCORE = { "amll-state": 40, "console": 30, "dom-lyrics": 20, "cache": 10 };
  const CONFIDENCE_SCORE = { high: 30, medium: 20, low: 10 };

  function isTrustedStartMs(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric !== 999999999;
  }

  function countTimedLines(lines) {
    return Array.isArray(lines)
      ? lines.filter((line) => isTrustedStartMs(line.startMs ?? line.startTime)).length
      : 0;
  }

  function hasCompleteLineTiming(payload) {
    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    if (!lines.length) return false;
    let previous = -1;
    for (const line of lines) {
      const start = Number(line.startMs ?? line.startTime);
      if (!isTrustedStartMs(start)) return false;
      if (start < previous) return false;
      previous = start;
    }
    return true;
  }

  function computeCaptureScore(payload) {
    if (!payload) return 0;
    const sourceScore = SOURCE_SCORE[payload.source] || 0;
    const confidenceScore = CONFIDENCE_SCORE[payload.confidence] || 10;
    const lineCount = Array.isArray(payload.lines) ? payload.lines.length : 0;
    const lineBonus = Math.min(lineCount, 80); // 0–80
    const hasTiming = countTimedLines(payload.lines);
    const timingBonus = Math.min(hasTiming * 2, 20); // 0–20, reward timed lines
    return sourceScore + confidenceScore + lineBonus + timingBonus;
  }

  function shouldReplaceActiveCapture(newPayload, activeState) {
    if (!newPayload) return false;
    if (!activeState || !activeState.activeCaptureSource) return true; // no active capture
    const newScore = computeCaptureScore(newPayload);
    const oldScore = activeState.activeCaptureScore || 0;
    // Require meaningful improvement: at least 10 points higher or different source with more lines
    if (newScore > oldScore + 10) return true;
    if (newPayload.source !== activeState.activeCaptureSource && newScore > oldScore + 5) return true;
    return false;
  }

  // ── Build unified captured payload ──

  function buildPayload({ source, lines, songId, rawSongIdCandidate, confidence }) {
    const normalized = (Array.isArray(lines) ? lines : []).map((line, i) => ({
      lineIndex: Number.isInteger(line.lineIndex)
        ? line.lineIndex
        : Number.isInteger(line.index) ? line.index : i,
      original: String(line.original ?? line.text ?? line.line ?? line.originalLyric ?? ""),
      startMs: Number.isFinite(Number(line.startMs ?? line.startTime))
        ? Number(line.startMs ?? line.startTime) : null,
      endMs: Number.isFinite(Number(line.endMs ?? line.endTime))
        ? Number(line.endMs ?? line.endTime) : null,
      translation: line.translation ?? line.referenceTranslation ?? line.translatedLyric ?? null,
      romanLyric: line.romanLyric ?? line.romalrc ?? line.romaji ?? null
    }));
    return {
      source,
      songId: songId || null,
      rawSongIdCandidate: rawSongIdCandidate || null,
      lines: normalized,
      capturedAt: Date.now(),
      confidence: normalized.length ? (confidence || "medium") : "low"
    };
  }

  // ── AMLL state source (highest priority) ──

  function readAmllStateLyrics(context) {
    const Lyrics = root.LyricLens?.Lyrics;
    if (!Lyrics) return null;

    // Direct AMLL-specific paths only — does NOT use probeSources()
    // which would also return console-captured payloads.
    const probed = readDirectAmllState(context);

    if (!probed || !Array.isArray(probed) || !probed.length) return null;

    const normalized = Lyrics.normalizeLyricPayload?.(probed) || [];
    if (!normalized.length) return null;

    return buildPayload({
      source: "amll-state",
      lines: normalized.map((l) => ({
        lineIndex: l.index,
        original: l.text,
        startMs: l.startTime,
        endMs: l.endTime,
        translation: l.referenceTranslation,
        romanLyric: l.romanLyric
      })),
      songId: context?.LyricLens?.diagnostics?.getState?.()?.songId || null,
      confidence: "high"
    });
  }

  function readDirectAmllState(context) {
    // Direct paths that probeSources already checks, but belt-and-suspenders
    const candidates = [
      () => context?.AMLL?.currentLyrics,
      () => context?.currentLyrics,
      () => context?.CPPLYRICS_INTERNALS?.currentLyrics,
      () => readAmllReactLyricLines(context)
    ];
    const Lyrics = root.LyricLens?.Lyrics;
    for (const getter of candidates) {
      let value;
      try { value = getter(); } catch (_) { continue; }
      if (Lyrics?.isParsedTimedLyricsArray?.(value)) return value;
    }
    return null;
  }

  function readAmllReactLyricLines(context) {
    const document = context?.document;
    const Lyrics = root.LyricLens?.Lyrics;
    if (!document?.querySelectorAll || !Lyrics?.isParsedTimedLyricsArray) return null;

    const selectors = [
      ".amll-lyric-player-wrapper",
      "[class*='amll-lyric-player']",
      "[class*='amll'][class*='lyric']"
    ];
    const elements = [];
    for (const selector of selectors) {
      let found = [];
      try { found = Array.from(document.querySelectorAll(selector) || []); } catch (_) { found = []; }
      for (const element of found) {
        if (element && !elements.includes(element)) elements.push(element);
        if (elements.length >= 80) break;
      }
      if (elements.length >= 80) break;
    }

    for (const element of elements) {
      const fiber = getReactFiberFromElement(element);
      const lyrics = findTimedLyricsInReactFiber(fiber, Lyrics);
      if (lyrics) return lyrics;
    }
    return null;
  }

  function getReactFiberFromElement(element) {
    if (!element || typeof element !== "object") return null;
    const key = Object.keys(element).find((name) => (
      name.startsWith("__reactFiber$") ||
      name.startsWith("__reactInternalInstance$")
    ));
    return key ? element[key] : null;
  }

  function findTimedLyricsInReactFiber(startFiber, Lyrics) {
    if (!startFiber || !Lyrics?.isParsedTimedLyricsArray) return null;
    const stack = [startFiber];
    const seen = new Set();
    let visited = 0;

    while (stack.length && visited < 160) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      visited += 1;

      const direct = extractTimedLyricsCandidate(fiber, Lyrics);
      if (direct) return direct;

      let hook = fiber.memoizedState;
      let hookCount = 0;
      while (hook && hookCount < 40) {
        const fromHook = extractTimedLyricsCandidate(hook.memoizedState, Lyrics);
        if (fromHook) return fromHook;
        hook = hook.next;
        hookCount += 1;
      }

      if (fiber.return) stack.push(fiber.return);
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.alternate) stack.push(fiber.alternate);
    }
    return null;
  }

  function extractTimedLyricsCandidate(value, Lyrics) {
    if (!value || !Lyrics?.isParsedTimedLyricsArray) return null;
    if (Lyrics.isParsedTimedLyricsArray(value)) return value;

    const candidates = [
      value.lyricLines,
      value.lyrics,
      value.lines,
      value.memoizedProps?.lyricLines,
      value.pendingProps?.lyricLines,
      value.stateNode?.lyricLines,
      value.current?.lyricLines,
      value.current?.lyrics,
      value.current?.getLyricLines?.(),
      value.current?.lyricPlayer?.getLyricLines?.(),
      value.lyricPlayer?.getLyricLines?.(),
      value.getLyricLines?.()
    ];

    for (const candidate of candidates) {
      if (Lyrics.isParsedTimedLyricsArray(candidate)) return candidate;
    }
    return null;
  }

  // ── DOM lyrics source ──

  // Patterns that identify metadata / non-lyric text in DOM captures
  const DOM_METADATA_PATTERNS = [
    /^(?:创作者|歌手|作词|作曲|编曲|专辑|来源|翻譯|翻译|作詞|作曲|編曲|專輯|來源)\s*[：:]/i,
    /^(?:artist|composer|lyricist|arranger|album|source)\s*[：:]/i,
    /^(?:原唱|演唱|制作|製作|发行|發行|版权|版權)\s*[：:]/i,
    /^(?:纯音乐|純音樂|instrumental|music\s*[-—])\s*$/i,
    /^\s*[\[【](?:instrumental|music|间奏|間奏|伴奏|纯音乐|純音樂)[\]】]\s*$/i,
    /^[※*•·●■□▪▸►▼▲→←↑↓✓✔✗✘]\s/,
    /^[0-9]{1,2}[:：][0-9]{2}/,
    /^\s*(?:LyricLens|AMLL|NCM|lyric)\s*$/i
  ];

  function isMetadataLine(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (t.length < 2) return true;
    // Purely whitespace / punctuation
    if (/^[\s.,;:!?，。；：！？…\-—~・·]+$/.test(t)) return true;
    // Known metadata patterns
    for (const pattern of DOM_METADATA_PATTERNS) {
      if (pattern.test(t)) return true;
    }
    return false;
  }

  function createDomLyricsObserver(context, onCapture, options) {
    const opts = options || {};
    const selectors = Array.isArray(opts.selectors) && opts.selectors.length
      ? opts.selectors
      : [
          ".amll-lyric__wrapper",
          ".amll-lyric-wrapper",
          '[class*="amll"] [class*="lyric"]',
          ".ncm-lyric-container",
          '[class*="lyric-wrapper"]',
          '[class*="lyric-container"]'
        ];
    const debounceMs = Number.isFinite(Number(opts.debounceMs)) && Number(opts.debounceMs) >= 100
      ? Number(opts.debounceMs) : 500;
    // Require at least 5 valid lyric lines (not 2) for DOM source
    const minLines = Number.isFinite(Number(opts.minLines)) && Number(opts.minLines) >= 2
      ? Number(opts.minLines) : 5;

    let observer = null;
    let debounceTimer = null;
    let targetContainer = null;
    let lastExtractedSignature = null;
    let stopped = false;

    function getDiag() {
      return context?.LyricLens?.diagnostics;
    }

    function findTarget() {
      if (!context?.document) return null;
      for (const sel of selectors) {
        try {
          const el = context.document.querySelector(sel);
          if (el) return el;
        } catch (_) {}
      }
      return null;
    }

    function extractLines(container) {
      if (!container) return [];
      let rawLines = [];

      // Try to find per-line elements first
      const lineCandidates = [
        container.querySelectorAll('[class*="line"]'),
        container.querySelectorAll('[class*="lyric"] > *'),
        container.querySelectorAll('p, div'),
        container.querySelectorAll('span')
      ];
      for (const nodeList of lineCandidates) {
        if (!nodeList || !nodeList.length) continue;
        const found = [];
        nodeList.forEach((el) => {
          const text = (el.textContent || "").trim();
          if (!text) return;
          if (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "A") return;
          if (el.getAttribute?.("role") === "button") return;
          found.push(text);
        });
        if (found.length >= 3) {
          rawLines = found;
          break;
        }
      }

      // Fallback: split text content
      if (!rawLines.length) {
        const fullText = (container.textContent || "").trim();
        if (!fullText) return [];
        rawLines = fullText.split(/\r?\n/).filter(Boolean).map((t) => t.trim()).filter((t) => t.length >= 2);
      }

      return rawLines;
    }

    function extractAndDeliver() {
      if (stopped) return;
      if (!targetContainer) {
        targetContainer = findTarget();
        if (!targetContainer) return;
        if (observer) {
          try { observer.disconnect(); } catch (_) {}
          observer = null;
        }
        startObserving();
      }

      const rawLines = extractLines(targetContainer);
      const rawCount = rawLines.length;

      // Filter metadata
      const validLines = [];
      const rejectedSamples = [];
      for (const text of rawLines) {
        if (isMetadataLine(text)) {
          if (rejectedSamples.length < 5) rejectedSamples.push(text.slice(0, 60));
          continue;
        }
        validLines.push(text);
      }

      const filteredCount = validLines.length;
      const rejectedCount = rawCount - filteredCount;

      // Update DOM-specific diagnostics
      const diag = getDiag();
      if (diag?.updateState) {
        diag.updateState({
          domLyricsRawLineCount: rawCount,
          domLyricsFilteredLineCount: filteredCount,
          domLyricsRejectedReason: rejectedCount > 0
            ? (rejectedCount >= rawCount ? "dom-source-metadata-only" : "dom-source-partial-metadata")
            : null,
          lastRejectedCaptureSample: rejectedSamples.length ? rejectedSamples : null
        });
      }

      // Quality gate: not enough valid lines
      if (filteredCount < minLines) {
        if (diag?.updateState) {
          const current = diag.getState ? diag.getState() : {};
          const hasActiveCapture =
            current.captureStatus === "captured-valid-lines" ||
            current.captureStatus === "using-cache";
          const isAnalyzing =
            current.analyzeTriggerStatus === "running" ||
            current.analyzeTriggerStatus === "success" ||
            current.apiStatus === "requesting";

          // NEVER regress global state — only update DOM-specific diagnostics
          const partial = {
            domLyricsRawLineCount: rawCount,
            domLyricsFilteredLineCount: filteredCount,
            domLyricsRejectedReason: filteredCount > 0
              ? "dom-source-too-few-lines"
              : "dom-source-metadata-only",
            lastRejectedCaptureSample: rejectedSamples.length ? rejectedSamples : null,
            skippedCaptureReason: hasActiveCapture || isAnalyzing
              ? "dom-outranked-by-active-capture"
              : (filteredCount > 0 ? "dom-source-too-few-lines" : "dom-source-metadata-only")
          };

          // Only set blocked status if nothing better is active
          if (!hasActiveCapture && !isAnalyzing) {
            partial.captureStatus = filteredCount > 0 ? "captured-empty-lines" : "waiting-for-lyrics";
            partial.analyzeTriggerStatus = "blocked-empty-lines";
            partial.analyzeTriggerBlockedReason = filteredCount > 0
              ? "dom-source-too-few-lines"
              : "dom-source-metadata-only";
            partial.captureConfidence = "low";
          }

          diag.updateState(partial);
        }
        return; // Don't trigger analyze
      }

      const lines = validLines.map((text, i) => ({
        lineIndex: i, original: text, startMs: null, endMs: null
      }));

      if (!hasCompleteLineTiming({ lines })) {
        if (diag?.updateState) {
          const current = diag.getState ? diag.getState() : {};
          const hasActiveCapture =
            current.captureStatus === "captured-valid-lines" ||
            current.captureStatus === "using-cache";
          const isAnalyzing =
            current.analyzeTriggerStatus === "running" ||
            current.analyzeTriggerStatus === "success" ||
            current.apiStatus === "requesting" ||
            current.apiStatus === "success";

          const partial = {
            domLyricsRawLineCount: rawCount,
            domLyricsFilteredLineCount: filteredCount,
            domLyricsRejectedReason: "dom-source-missing-timing",
            skippedCaptureReason: hasActiveCapture || isAnalyzing
              ? "dom-outranked-by-active-capture"
              : "dom-source-missing-timing",
            lastRejectedCaptureSample: validLines.slice(0, 3).map((line) => line.slice(0, 60))
          };
          if (!hasActiveCapture && !isAnalyzing) {
            partial.captureStatus = "waiting-for-timed-lyrics";
            partial.analyzeTriggerStatus = "blocked-no-timed-lyrics";
            partial.analyzeTriggerBlockedReason = "dom-source-missing-timing";
            partial.captureConfidence = "low";
          }
          diag.updateState(partial);
        }
        return;
      }

      // Build signature to avoid re-triggering on same content
      const signature = validLines.map((l) => l.slice(0, 40)).join("|");
      if (signature === lastExtractedSignature) return;
      lastExtractedSignature = signature;

      const payload = buildPayload({
        source: "dom-lyrics",
        lines,
        songId: null,
        confidence: "medium"
      });

      // Update diagnostics before delivering
      if (diag?.updateState) {
        diag.updateState({
          captureConfidence: "medium",
          lastCaptureSample: lines.slice(0, 3).map((l) => l.original.slice(0, 60))
        });
      }

      if (typeof onCapture === "function") {
        try { onCapture(payload); } catch (_) {}
      }
    }

    function debouncedExtract() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(extractAndDeliver, debounceMs);
    }

    function computeCurrentSignature() {
      const container = targetContainer || findTarget();
      if (!container) return null;
      const rawLines = extractLines(container);
      const validLines = [];
      for (const text of rawLines) {
        if (isMetadataLine(text)) continue;
        validLines.push(text);
      }
      if (validLines.length < minLines) return null;
      return validLines.map((l) => l.slice(0, 40)).join("|");
    }

    function startObserving() {
      const watchTarget = targetContainer || context?.document?.body;
      if (!watchTarget || typeof context.MutationObserver !== "function") return;
      try {
        observer = new context.MutationObserver(() => {
          debouncedExtract();
        });
        observer.observe(watchTarget, {
          childList: true,
          subtree: targetContainer ? false : true,
          characterData: targetContainer ? false : true
        });
      } catch (_) {
        observer = null;
      }
    }

    function start(startOptions) {
      stopped = false;
      targetContainer = findTarget();
      lastExtractedSignature = startOptions?.seedFromCurrentDom
        ? computeCurrentSignature()
        : null;
      startObserving();
      debounceTimer = setTimeout(extractAndDeliver, debounceMs);
    }

    function cleanup() {
      stopped = true;
      if (observer) {
        try { observer.disconnect(); } catch (_) {}
        observer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      targetContainer = null;
      lastExtractedSignature = null;
    }

    return { start, cleanup, extractNow: extractAndDeliver };
  }

  // ── Console source ──

  function readConsoleCapturedLyrics(context) {
    const Lyrics = root.LyricLens?.Lyrics;
    if (!Lyrics) return null;

    const captured = Lyrics.getLastCapturedLyrics?.();
    if (!captured || !Array.isArray(captured) || !captured.length) return null;

    const normalized = Lyrics.normalizeLyricPayload?.(captured) || [];
    if (!normalized.length) return null;

    const hasTiming = normalized.some(
      (l) => Number.isFinite(Number(l.startTime)) && Number(l.startTime) !== 999999999
    );

    return buildPayload({
      source: "console",
      lines: normalized.map((l) => ({
        lineIndex: l.index,
        original: l.text,
        startMs: l.startTime,
        endMs: l.endTime,
        translation: l.referenceTranslation,
        romanLyric: l.romanLyric
      })),
      songId: context?.LyricLens?.diagnostics?.getState?.()?.songId || null,
      confidence: hasTiming ? "high" : "medium"
    });
  }

  // ── Cache fallback ──

  function readCacheFallback(context, { songId, lyricsFingerprint, lyricsHash }) {
    const Cache = root.LyricLens?.Cache;
    const Settings = root.LyricLens?.Settings;
    const Api = root.LyricLens?.Api;
    if (!Cache) return null;

    const settings = Settings
      ? (root.LyricLens?._activeSettings || Settings.DEFAULT_SETTINGS)
      : {};

    // Build candidate cache keys
    const candidates = [];
    if (songId && lyricsHash && settings.apiEndpoint) {
      candidates.push(Cache.buildCacheKey?.({
        songId,
        lyricsHash,
        apiEndpoint: settings.apiEndpoint,
        modelName: settings.modelName,
        promptVersion: Api?.PROMPT_VERSION || "v2",
        cardGenerationMode: settings.cardGenerationMode === "selected" ? "selected" : "per-line"
      }));
    }
    if (songId && lyricsHash) {
      // Try without full key components (broad match)
      const entries = [];
      try {
        for (const [key] of Cache.defaultCache?.entries?.() || []) {
          entries.push(key);
        }
      } catch (_) {
        // Map iteration fallback
        if (Cache.defaultCache?.forEach) {
          Cache.defaultCache.forEach((_, key) => entries.push(key));
        }
      }
      const partial = `${songId}:${lyricsHash}`;
      for (const key of entries) {
        if (typeof key === "string" && key.startsWith(partial)) {
          if (!candidates.includes(key)) candidates.push(key);
        }
      }
    }

    for (const key of candidates) {
      if (!Cache.defaultCache?.has?.(key)) continue;
      const cards = Cache.defaultCache.get(key);
      if (!Array.isArray(cards) || !cards.length) continue;
      return {
        source: "cache",
        cards,
        cacheKey: key,
        capturedAt: Date.now(),
        confidence: "low"
      };
    }

    return null;
  }

  function recordCacheHitDiagnostics(context, cacheResult) {
    const diagnostics = context?.LyricLens?.diagnostics;
    if (!diagnostics?.updateState || !cacheResult?.cacheKey) return;
    const current = diagnostics.getState ? diagnostics.getState() : {};
    const hasActiveCapture =
      current.captureStatus === "captured-valid-lines" ||
      current.analyzeTriggerStatus === "running" ||
      current.analyzeTriggerStatus === "success" ||
      current.apiStatus === "requesting" ||
      current.apiStatus === "success";
    const partial = {
      cacheHit: true,
      cacheKey: cacheResult.cacheKey,
      cacheUseStatus: "diagnostic-only",
      skippedCaptureReason: "cache-hit-not-used",
      analyzeTriggerBlockedReason: "cache-hit-not-used"
    };
    if (!hasActiveCapture) {
      partial.captureStatus = "capture-failed";
      partial.captureSource = null;
      partial.analyzeTriggerStatus = "blocked-no-lyrics";
      partial.activeCaptureSource = null;
      partial.activeCaptureLineCount = 0;
      partial.activeCaptureScore = 0;
    }
    diagnostics.updateState(partial);
  }

  // ── Main capture orchestrator ──

  function captureLyrics(context, options) {
    const opts = options || {};
    const startedAt = Date.now();

    // 1. amll-state (highest priority, synchronous)
    const amll = readAmllStateLyrics(context);
    if (amll && amll.lines.length) {
      updateCaptureDiagnostics(context, amll);
      return amll;
    }

    // 2. console (synchronous)
    const consoleResult = readConsoleCapturedLyrics(context);
    if (consoleResult && consoleResult.lines.length) {
      updateCaptureDiagnostics(context, consoleResult);
      return consoleResult;
    }

    // 3. cache fallback
    const cacheResult = readCacheFallback(context, {
      songId: opts.songId || context?.LyricLens?.diagnostics?.getState?.()?.songId || null,
      lyricsFingerprint: opts.lyricsFingerprint || null,
      lyricsHash: opts.lyricsHash || null
    });
    if (cacheResult) {
      recordCacheHitDiagnostics(context, cacheResult);
      return null;
    }

    updateCaptureDiagnostics(context, null, "capture-failed");
    return null;
  }

  // ── Diagnostics helpers ──

  function updateCaptureDiagnostics(context, payload, forceStatus) {
    const diagnostics = context?.LyricLens?.diagnostics;
    if (!diagnostics?.updateState) return;

    if (!payload && forceStatus === "capture-failed") {
      const current = diagnostics.getState ? diagnostics.getState() : {};
      // Never regress from an active capture — only set failed if truly idle
      if (current.captureStatus !== "captured-valid-lines" &&
          current.captureStatus !== "using-cache" &&
          current.analyzeTriggerStatus !== "running" &&
          current.analyzeTriggerStatus !== "success") {
        diagnostics.updateState({
          captureStatus: "capture-failed",
          captureSource: null,
          analyzeTriggerStatus: "blocked-no-lyrics",
          analyzeTriggerBlockedReason: "no-capture-source"
        });
      }
      return;
    }

    if (!payload) return;

    const status = forceStatus || "captured-valid-lines";
    const lineCount = Array.isArray(payload.lines) ? payload.lines.length : 0;

    const score = computeCaptureScore(payload);

    diagnostics.updateState({
      captureStatus: status,
      captureSource: payload.source || null,
      lastCapturedAt: payload.capturedAt || Date.now(),
      lastCaptureSource: payload.source || null,
      lyricLineCount: lineCount,
      captureConfidence: payload.confidence || null,
      lastCaptureSample: Array.isArray(payload.lines)
        ? payload.lines.slice(0, 3).map((l) => (l.original || "").slice(0, 60))
        : null,
      activeCaptureSource: payload.source || null,
      activeCaptureLineCount: lineCount,
      activeCaptureScore: score
    });
  }

  // ── Wait helper (retry loop like existing waitForLyrics) ──

  async function waitForCapture(context, options) {
    const opts = options || {};
    const maxWaitMs = Number.isFinite(Number(opts.maxWaitMs)) ? Number(opts.maxWaitMs) : 6000;
    const pollMs = Number.isFinite(Number(opts.pollMs)) ? Number(opts.pollMs) : 400;
    const isStaleLines = typeof opts.isStaleLines === "function" ? opts.isStaleLines : null;
    const startedAt = Date.now();
    let staleSkipCount = 0;

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    while (Date.now() - startedAt < maxWaitMs) {
      if (opts.signal?.aborted) return null;

      const result = captureLyrics(context, opts);
      if (result && result.source !== "cache" && Array.isArray(result.lines) && result.lines.length) {
        if (isStaleLines && isStaleLines(result.lines, result.source)) {
          // Capture matches previous song's signature — keep polling until source
          // (amll-state etc.) catches up to the new song or we time out.
          staleSkipCount += 1;
          const diagnostics = context?.LyricLens?.diagnostics;
          if (diagnostics?.updateState) {
            diagnostics.updateState({
              staleCaptureSkippedCount: staleSkipCount,
              staleCaptureLastSkippedSource: result.source,
              staleCaptureLastSkippedAt: Date.now()
            });
          }
        } else {
          return result;
        }
      }

      // Also check for cache fallback on the last poll
      if (Date.now() - startedAt > maxWaitMs - pollMs) {
        const cacheResult = readCacheFallback(context, {
          songId: opts.songId,
          lyricsFingerprint: opts.lyricsFingerprint,
          lyricsHash: opts.lyricsHash
        });
        if (cacheResult) {
          recordCacheHitDiagnostics(context, cacheResult);
          return null;
        }
      }

      await delay(pollMs);
    }

    // Final cache check
    const cacheResult = readCacheFallback(context, {
      songId: opts.songId,
      lyricsFingerprint: opts.lyricsFingerprint,
      lyricsHash: opts.lyricsHash
    });
    if (cacheResult) recordCacheHitDiagnostics(context, cacheResult);
    return null;
  }

  const api = {
    SOURCE_ORDER,
    computeCaptureScore,
    countTimedLines,
    hasCompleteLineTiming,
    shouldReplaceActiveCapture,
    buildPayload,
    readAmllStateLyrics,
    createDomLyricsObserver,
    readConsoleCapturedLyrics,
    readCacheFallback,
    recordCacheHitDiagnostics,
    captureLyrics,
    waitForCapture,
    updateCaptureDiagnostics
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Capture = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

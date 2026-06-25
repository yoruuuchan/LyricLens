(function initLyricLensLyrics(root) {
  "use strict";

  const LRC_TIME_RE = /^\[((?:\d+:)?\d{1,2}[:.]\d{1,3})\]/;
  const META_TIME_RE = /^\[[a-zA-Z]+:/;
  const WORD_TIME_RE = /(?:\(\s*\d+(?:\.\d+)?\s*[,，:]\s*\d+(?:\.\d+)?(?:\s*[,，:]\s*\d+)?\s*\)|<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>)/g;
  const MEANINGFUL_RE = /[\p{L}\p{N}\u3040-\u30ff\u3400-\u9fff]/u;
  const MUSIC_MARKER_RE = /^\s*[\[【(（]?\s*(?:instrumental|music|intro|outro|interlude|间奏|間奏|伴奏|纯音乐|純音樂)\s*[\]】)）]?\s*$/i;

  let capturedPayload = null;
  let capturedAt = 0;
  let lastPayload = null;

  let lastCapturedLyrics = null;
  let lastCapturedLyricsSource = null;
  let lastCapturedLyricsAt = 0;
  let lastCapturedLyricsFingerprint = null;
  const CONSOLE_CAPTURE_METHODS = ["log", "debug", "info", "warn", "dir", "table"];
  const PROTECTED_API_STATUSES = new Set([
    "requesting",
    "success",
    "success-with-missing",
    "error",
    "timeout",
    "parse-error",
    "no-cards",
    "rate-limited",
    "network-error",
    "cache-hit-not-used"
  ]);
  const patchedConsoles = typeof WeakSet === "function" ? new WeakSet() : null;
  const captureListeners = new Set();
  const RUNTIME_CAPTURE_EVENT = "lyriclens:lyrics-captured";
  let consoleWrapperDepth = 0;

  function stripWordTimestamps(text) {
    return String(text ?? "").replace(WORD_TIME_RE, "").replace(/\s+/g, " ").trim();
  }

  function parseTimestampMs(raw) {
    const parts = String(raw ?? "").replace(".", ":").split(":").map(Number);
    if (parts.some((part) => Number.isNaN(part))) return null;
    let ms = 0;
    if (parts.length === 3) {
      ms = (parts[0] * 60 + parts[1]) * 1000 + normalizeFraction(parts[2]);
    } else if (parts.length === 2) {
      ms = parts[0] * 60 * 1000 + parts[1] * 1000;
    } else if (parts.length === 1) {
      ms = parts[0] * 1000;
    }
    if (parts.length >= 2 && String(raw).includes(".")) {
      const [minutePart, secondPart] = String(raw).split(":").slice(-2);
      const [seconds, fraction = "0"] = secondPart.split(".");
      const hoursOrMinutes = String(raw).split(":").slice(0, -2).map(Number);
      const minutes = Number(minutePart);
      const hours = hoursOrMinutes.length ? hoursOrMinutes.reduce((acc, part) => acc * 60 + part, 0) : 0;
      ms = (hours * 60 + minutes) * 60 * 1000 + Number(seconds) * 1000 + normalizeFractionString(fraction);
    }
    return Math.floor(ms);
  }

  function normalizeFraction(value) {
    const text = String(value ?? "0");
    return normalizeFractionString(text);
  }

  function normalizeFractionString(text) {
    const padded = String(text ?? "0").padEnd(3, "0").slice(0, 3);
    return Number(padded);
  }

  function parseLrcText(rawText) {
    const result = [];
    const rawLines = String(rawText ?? "").split(/\r?\n/);
    rawLines.forEach((rawLine, rawIndex) => {
      let line = rawLine.trim();
      if (!line || META_TIME_RE.test(line)) return;
      const timestamps = [];
      while (true) {
        const match = line.match(LRC_TIME_RE);
        if (!match) break;
        const time = parseTimestampMs(match[1]);
        if (time !== null) timestamps.push(time);
        line = line.slice(match[0].length).trim();
      }
      const text = stripWordTimestamps(line);
      timestamps.forEach((startTime) => {
        result.push({ index: rawIndex, text, startTime, endTime: undefined });
      });
    });
    result.sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < result.length - 1; i += 1) {
      result[i].endTime = result[i + 1].startTime;
    }
    return result;
  }

  function parsePlainText(rawText) {
    return String(rawText ?? "")
      .split(/\r?\n/)
      .map((line, index) => ({
        index,
        text: stripWordTimestamps(line),
        startTime: index === 0 ? 0 : 999999999,
        endTime: undefined
      }));
  }

  function parseCppLyricsString(rawText) {
    const lines = [];
    String(rawText ?? "").split(/\r?\n/).forEach((rawLine, index) => {
      const originalPart = rawLine.split("|")[0] || "";
      const matches = Array.from(originalPart.matchAll(/\((\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\)([^`|]*)/g));
      if (!matches.length) return;
      const text = stripWordTimestamps(matches.map((match) => match[3] || "").join(""));
      const startTime = Number(matches[0][1]);
      const endTime = Number(matches[matches.length - 1][2]);
      if (!Number.isFinite(startTime)) return;
      lines.push({
        index,
        text,
        startTime,
        endTime: Number.isFinite(endTime) ? endTime : undefined
      });
    });
    return lines;
  }

  function itemText(item) {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const words = lyricWordArray(item);
    if (words.length) {
      return words.map((word) => {
        if (typeof word === "string") return word;
        return word?.word ?? word?.text ?? word?.content ?? "";
      }).join("");
    }
    return item.originalLyric ?? item.lyric ?? item.text ?? item.content ?? item.line ?? item.rawLyric ?? "";
  }

  function itemStartTime(item, fallback) {
    if (!item || typeof item !== "object") return fallback;
    const value = item.startTime ?? item.startMs ?? item.start ?? item.from ?? item.begin ?? item.beginTime ??
      item.time ?? item.t ?? item.ts ?? firstWordTime(item, ["startTime", "startMs", "start", "from", "begin", "beginTime", "time", "t", "ts"]) ?? fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return numeric;
  }

  function itemEndTime(item) {
    if (!item || typeof item !== "object") return undefined;
    const direct = item.endTime ?? item.endMs ?? item.end ?? item.to ?? item.finish ?? item.finishTime;
    const directNumeric = Number(direct);
    if (Number.isFinite(directNumeric)) return directNumeric;

    const start = item.startTime ?? item.startMs ?? item.start ?? item.from ?? item.begin ?? item.beginTime ?? item.time ?? item.t ?? item.ts;
    const duration = item.duration ?? item.durationMs ?? item.dur ?? item.length ?? item.lengthMs;
    const startNumeric = Number(start);
    const durationNumeric = Number(duration);
    if (Number.isFinite(startNumeric) && Number.isFinite(durationNumeric)) return startNumeric + durationNumeric;

    return lastWordEndTime(item);
  }

  function lyricWordArray(item) {
    if (Array.isArray(item?.words)) return item.words;
    if (Array.isArray(item?.dynamicLyric)) return item.dynamicLyric;
    if (Array.isArray(item?.syllables)) return item.syllables;
    return [];
  }

  function firstWordTime(item, keys) {
    const words = lyricWordArray(item);
    for (const word of words) {
      const value = numericFromKeys(word, keys);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  }

  function lastWordEndTime(item) {
    const words = lyricWordArray(item);
    for (let i = words.length - 1; i >= 0; i -= 1) {
      const word = words[i];
      const end = numericFromKeys(word, ["endTime", "endMs", "end", "to", "finish", "finishTime"]);
      if (Number.isFinite(end)) return end;
      const start = numericFromKeys(word, ["startTime", "startMs", "start", "from", "begin", "beginTime", "time", "t", "ts"]);
      const duration = numericFromKeys(word, ["duration", "durationMs", "dur", "length", "lengthMs"]);
      if (Number.isFinite(start) && Number.isFinite(duration)) return start + duration;
    }
    return undefined;
  }

  function numericFromKeys(value, keys) {
    if (!value || typeof value !== "object") return undefined;
    for (const key of keys) {
      const numeric = Number(value[key]);
      if (Number.isFinite(numeric)) return numeric;
    }
    return undefined;
  }

  function inferTimeScale(rawLines) {
    const values = [];
    for (const line of rawLines) {
      if (Number.isFinite(line.rawStartTime)) values.push(line.rawStartTime);
      if (Number.isFinite(line.rawEndTime)) values.push(line.rawEndTime);
    }
    const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
    if (!positive.length) return 1;
    if (positive.some((value) => value >= 1000)) return 1;
    if (positive.some((value) => !Number.isInteger(value))) return 1000;

    const gaps = [];
    for (let i = 1; i < positive.length; i += 1) {
      const gap = positive[i] - positive[i - 1];
      if (gap > 0) gaps.push(gap);
    }
    if (!gaps.length) return positive[0] <= 60 ? 1000 : 1;
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    return medianGap <= 60 ? 1000 : 1;
  }

  function itemReferenceTranslation(item) {
    if (!item || typeof item !== "object") return "";
    return item.referenceTranslation ?? item.translatedLyric ?? item.translation ?? item.tlyric ?? "";
  }

  function itemRomanLyric(item) {
    if (!item || typeof item !== "object") return "";
    return item.romanLyric ?? item.romalrc ?? item.romaji ?? "";
  }

  function normalizeArrayPayload(arrayPayload) {
    const rawLines = arrayPayload.map((item, index) => ({
      index: Number.isInteger(item?.index) ? item.index : index,
      text: stripWordTimestamps(itemText(item)),
      rawStartTime: itemStartTime(item, index === 0 ? 0 : undefined),
      rawEndTime: itemEndTime(item),
      referenceTranslation: String(itemReferenceTranslation(item) || ""),
      romanLyric: String(itemRomanLyric(item) || "")
    }));
    const scale = inferTimeScale(rawLines);
    const lines = rawLines.map((line, index) => ({
      index: line.index,
      text: line.text,
      startTime: Number.isFinite(line.rawStartTime)
        ? line.rawStartTime * scale
        : (index === 0 ? 0 : 999999999),
      endTime: Number.isFinite(line.rawEndTime) ? line.rawEndTime * scale : undefined,
      referenceTranslation: line.referenceTranslation,
      romanLyric: line.romanLyric
    }));
    lines.sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (lines[i].endTime === undefined && lines[i + 1].startTime !== 999999999) {
        lines[i].endTime = lines[i + 1].startTime;
      }
    }
    return lines;
  }

  function normalizeLyricPayload(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return normalizeArrayPayload(payload);
    if (typeof payload === "string") {
      if (/\(\d+(?:\.\d+)?:\d+(?:\.\d+)?\)/.test(payload)) return parseCppLyricsString(payload);
      if (/^\s*\[\d{1,3}:\d{1,2}[.:]\d{1,3}\]/m.test(payload)) return parseLrcText(payload);
      return parsePlainText(payload);
    }
    if (typeof payload !== "object") return [];

    const candidateArray = payload.lyrics ?? payload.lines ?? payload.data?.lyrics ?? payload.data?.lines;
    if (Array.isArray(candidateArray)) return normalizeArrayPayload(candidateArray);

    const candidateText =
      payload.lrc?.lyric ??
      payload.lrc ??
      payload.lyric ??
      payload.data?.lrc?.lyric ??
      payload.data?.lyric ??
      payload.rawLyric;
    if (typeof candidateText === "string") return normalizeLyricPayload(candidateText);

    return [];
  }

  function preprocessLyricLinesWithReport(lines, maxLines = 80) {
    const inputLines = Array.isArray(lines) ? lines : [];
    const normalizedLines = normalizeArrayPayload(inputLines);
    const result = [];
    for (const line of normalizedLines) {
      const text = stripWordTimestamps(line?.text ?? "");
      if (!text) continue;
      if (!MEANINGFUL_RE.test(text)) continue;
      if (MUSIC_MARKER_RE.test(text)) continue;
      if (result.length >= maxLines) continue;
      const processed = {
        index: Number.isInteger(line.index) ? line.index : result.length,
        text,
        startTime: Number.isFinite(Number(line.startTime)) ? Number(line.startTime) : 999999999,
        endTime: Number.isFinite(Number(line.endTime)) ? Number(line.endTime) : undefined
      };
      const referenceTranslation = line.referenceTranslation ?? line.translatedLyric ?? "";
      const romanLyric = line.romanLyric ?? "";
      if (referenceTranslation) processed.referenceTranslation = String(referenceTranslation);
      if (romanLyric) processed.romanLyric = String(romanLyric);
      result.push(processed);
    }
    return {
      lines: result,
      rawCount: inputLines.length,
      sentCount: result.length,
      droppedCount: Math.max(0, inputLines.length - result.length)
    };
  }

  function preprocessLyricLines(lines, maxLines = 80) {
    return preprocessLyricLinesWithReport(lines, maxLines).lines;
  }

  function formatPromptField(name, value) {
    if (value === undefined || value === null || value === "") return "";
    return `${name}=${JSON.stringify(String(value))}`;
  }

  function formatLinesForPrompt(lines, options = {}) {
    const detailed = options?.detailed === true;
    return (Array.isArray(lines) ? lines : [])
      .map((line) => {
        if (!detailed) return `[${line.index}] ${line.text}`;
        const parts = [
          `[${line.index}]`,
          `startMs=${Number.isFinite(Number(line.startTime)) ? Number(line.startTime) : null}`,
          `endMs=${Number.isFinite(Number(line.endTime)) ? Number(line.endTime) : null}`,
          formatPromptField("original", line.text),
          formatPromptField("referenceTranslation", line.referenceTranslation),
          formatPromptField("romanLyric", line.romanLyric)
        ].filter(Boolean);
        return parts.join(" ");
      })
      .join("\n");
  }

  function describePayload(payload) {
    if (Array.isArray(payload)) return { type: "array", length: payload.length, sample: payload.slice(0, 2) };
    if (typeof payload === "string") return { type: "string", length: payload.length, sample: payload.slice(0, 160) };
    if (payload && typeof payload === "object") return { type: "object", keys: Object.keys(payload).slice(0, 20) };
    return { type: typeof payload };
  }

  function hasTimedLyricShape(item) {
    if (!item || typeof item !== "object") return false;
    const hasLineTime =
      (item.startTime !== undefined || item.startMs !== undefined || item.start !== undefined || item.from !== undefined || item.begin !== undefined || item.beginTime !== undefined || item.time !== undefined || item.t !== undefined || item.ts !== undefined) &&
      (item.endTime !== undefined || item.endMs !== undefined || item.end !== undefined || item.to !== undefined || item.finish !== undefined || item.finishTime !== undefined || item.duration !== undefined || item.durationMs !== undefined || item.dur !== undefined || item.length !== undefined || item.lengthMs !== undefined);
    const hasWordTime = lyricWordArray(item).some((word) => {
      const start = numericFromKeys(word, ["startTime", "startMs", "start", "from", "begin", "beginTime", "time", "t", "ts"]);
      const end = numericFromKeys(word, ["endTime", "endMs", "end", "to", "finish", "finishTime"]);
      const duration = numericFromKeys(word, ["duration", "durationMs", "dur", "length", "lengthMs"]);
      return Number.isFinite(start) && (Number.isFinite(end) || Number.isFinite(duration));
    });
    const hasTime = hasLineTime || hasWordTime;
    const hasLyricField =
      item.words !== undefined ||
      item.dynamicLyric !== undefined ||
      item.syllables !== undefined ||
      item.lyric !== undefined ||
      item.translatedLyric !== undefined ||
      item.romanLyric !== undefined;
    return hasTime && hasLyricField;
  }

  function isParsedTimedLyricsArray(value) {
    return Array.isArray(value) && value.some(hasTimedLyricShape);
  }

  function summarizeTimedLyricsArray(value) {
    const array = Array.isArray(value) ? value : [];
    const first = array.find(hasTimedLyricShape) || array[0] || {};
    return {
      length: array.length,
      firstStartTime: itemStartTime(first, undefined),
      firstEndTime: itemEndTime(first),
      hasWords: lyricWordArray(first).length > 0,
      hasTranslatedLyric: Boolean(first?.translatedLyric),
      hasRomanLyric: Boolean(first?.romanLyric),
      sampleText: itemText(first).slice(0, 120)
    };
  }

  function updateLyricsSourceDiagnostics(source, payload) {
    const summary = summarizeTimedLyricsArray(payload);
    const diagnostics = root.LyricLens?.diagnostics;
    if (diagnostics?.updateState) {
      diagnostics.updateState({
        lyricsSource: source,
        lyricLineCount: summary.length,
        lastLyricsSummary: summary
      });
    }
    return summary;
  }

  function recordTimedLyricsSource(source, payload) {
    lastPayload = payload;
    capturedPayload = payload;
    capturedAt = Date.now();
    updateLyricsSourceDiagnostics(source, payload);
    return payload;
  }

  function fingerprintCapturedLyrics(payload) {
    if (!Array.isArray(payload) || !payload.length) return null;
    const len = payload.length;
    const first = payload[0] || {};
    const last = payload[payload.length - 1] || {};
    const sample = itemText(first).slice(0, 64);
    const signature = payload.map((item, index) => [
      index,
      itemStartTime(item, ""),
      itemEndTime(item) ?? "",
      itemText(item)
    ].join("|")).join("\n");
    const cache = root.LyricLens?.Cache;
    let hash = cache?.hashString ? cache.hashString(signature) : null;
    if (!hash) {
      let fallbackHash = 0;
      for (let i = 0; i < signature.length; i += 1) {
        fallbackHash = ((fallbackHash << 5) - fallbackHash + signature.charCodeAt(i)) | 0;
      }
      hash = (fallbackHash >>> 0).toString(36);
    }
    return `${len}:${first.startTime ?? ""}:${first.endTime ?? ""}:${last.startTime ?? ""}:${sample.length}:${sample}:${hash}`;
  }

  function notifyRuntimeCaptureListeners(detail) {
    for (const fn of Array.from(captureListeners)) {
      try {
        fn(detail);
      } catch (err) {
        try { console.warn("[LyricLens]", "runtime capture listener threw", err); } catch (_) {}
      }
    }
    try {
      const Ev = root.CustomEvent || (typeof CustomEvent !== "undefined" ? CustomEvent : null);
      if (typeof Ev === "function" && typeof root.dispatchEvent === "function") {
        root.dispatchEvent(new Ev(RUNTIME_CAPTURE_EVENT, { detail }));
      }
    } catch (_) {}
  }

  function onRuntimeLyricsCaptured(handler) {
    if (typeof handler !== "function") return () => {};
    captureListeners.add(handler);
    return () => captureListeners.delete(handler);
  }

  function setRuntimeCapturedLyrics(payload, source) {
    lastCapturedLyrics = payload;
    lastCapturedLyricsSource = source;
    lastCapturedLyricsAt = Date.now();
    lastCapturedLyricsFingerprint = fingerprintCapturedLyrics(payload);
    try {
      root.__LL_CAPTURED_LYRICS = payload;
    } catch (_) {}
    const summary = summarizeTimedLyricsArray(payload);
    const diagnostics = root.LyricLens?.diagnostics;
    if (diagnostics?.updateState) {
      const current = diagnostics.getState ? diagnostics.getState() : {};
      const partial = {
        lyricsSource: source,
        lyricLineCount: summary.length,
        lastLyricsSummary: summary,
        lastCapturedAt: lastCapturedLyricsAt,
        lastCaptureSource: source,
        runtimeLyricsCaptureEventCount: (current.runtimeLyricsCaptureEventCount || 0) + 1,
        lastLyricsCaptureReason: source,
        lastLyricsCaptureLineCount: Array.isArray(payload) ? payload.length : (summary.length || 0),
        lastLyricsCaptureAt: lastCapturedLyricsAt
      };
      if (!PROTECTED_API_STATUSES.has(current.apiStatus)) {
        partial.apiStatus = "lyrics-captured";
      }
      diagnostics.updateState(partial);
    }
    notifyRuntimeCaptureListeners({
      payload,
      source,
      summary,
      capturedAt: lastCapturedLyricsAt,
      fingerprint: lastCapturedLyricsFingerprint
    });
    return payload;
  }

  function scanArgForLyricsArray(value, remainingDepth, seen) {
    try {
      if (isParsedTimedLyricsArray(value)) return value;
    } catch (_) {
      return null;
    }
    if (!value || typeof value !== "object" || remainingDepth <= 0) return null;
    if (seen.has(value)) return null;
    try {
      seen.add(value);
    } catch (_) {
      return null;
    }
    let keys;
    try {
      keys = Array.isArray(value)
        ? value.slice(0, 80).map((_, index) => index)
        : Object.keys(value).slice(0, 80);
    } catch (_) {
      return null;
    }
    for (const key of keys) {
      let child;
      try {
        child = value[key];
      } catch (_) {
        continue;
      }
      const found = scanArgForLyricsArray(child, remainingDepth - 1, seen);
      if (found) return found;
    }
    return null;
  }

  function scanArgsForLyricsArray(args, maxDepth = 2) {
    if (!args || typeof args.length !== "number") return null;
    const seen = typeof WeakSet === "function" ? new WeakSet() : { has() { return false; }, add() {} };
    for (let i = 0; i < args.length; i += 1) {
      try {
        const found = scanArgForLyricsArray(args[i], maxDepth, seen);
        if (found) return found;
      } catch (_) {}
    }
    return null;
  }

  function installRuntimeLyricsCapture(consoleRef) {
    const target = consoleRef || root.console || (typeof console !== "undefined" ? console : null);
    if (!target) return false;
    if (patchedConsoles && patchedConsoles.has(target)) return true;
    let anyPatched = false;
    for (const methodName of CONSOLE_CAPTURE_METHODS) {
      let original;
      try {
        original = target[methodName];
      } catch (_) {
        continue;
      }
      if (typeof original !== "function") continue;
      if (original.__lyricLensConsoleWrapped) {
        anyPatched = true;
        continue;
      }
      function wrappedConsoleMethod(...args) {
        // Reentrancy guard: when our own scan triggers a nested console call
        // we deliberately swallow it instead of passing through to original.
        // The trade-off is real: capture-listener warnings inside the wrapper
        // are lost. But forwarding to original would re-enter any other
        // plugin that has also wrapped this console method, and pathological
        // self-recursive console mocks (see lyrics.test.js) would blow the
        // stack. Net: better to lose a warn than to crash the renderer.
        if (consoleWrapperDepth > 0) return undefined;
        consoleWrapperDepth += 1;
        try {
          // ── Phase 0: classify external errors (lightweight, never blocks scan) ──
          const firstArg = args.length > 0 ? String(args[0] ?? "") : "";
          const EXTERNAL_ERROR_PATTERNS = [
            /ERR_NAME_NOT_RESOLVED/i,
            /better.?ncm.*插件市场|plugin.?market/i,
            /AMLL.*mirror|mirror.*fail|ncm-lyrics.*(?:fail|error|404)/i,
            /orpheus.*cache.*(?:error|fail|image)|orpheus\.cache/i,
            /InfLink.*[Bb]lob|[Bb]lob.*error|createObjectURL.*fail/i
          ];
          let isExternalError = false;
          for (const pattern of EXTERNAL_ERROR_PATTERNS) {
            if (pattern.test(firstArg)) {
              isExternalError = true;
              break;
            }
          }
          if (isExternalError) {
            const diagnostics = root.LyricLens?.diagnostics;
            if (diagnostics?.updateState) {
              try {
                const state = diagnostics.getState();
                const count = (state.ignoredExternalErrorCount || 0) + 1;
                diagnostics.updateState({
                  ignoredExternalErrorCount: count,
                  lastIgnoredExternalErrorSample: firstArg.slice(0, 120)
                });
              } catch (_) {}
            }
            // DO NOT return — still run lyrics scan below.
            // External error classification only suppresses songId extraction, never lyrics capture.
          }

          // ── Phase 1: ALWAYS scan for lyrics arrays (highest priority) ──
          try {
            const found = scanArgsForLyricsArray(args, 2);
            if (found) {
              setRuntimeCapturedLyrics(found, `runtime.capture.console.${methodName}`);
            }
          } catch (_) {}

          // ── Phase 2: extract songId only from relevant, non-external-error logs ──
          if (!isExternalError) {
            const RELEVANT_PATTERNS = [
              /AMLL/i,
              /track-\d{4,16}/i,
              /\d{5,16}_[A-Z0-9]+/,
              /play.?progress|播放进度/i,
              /lyric|lrc|ttml/i
            ];
            let isRelevant = false;
            for (const arg of args) {
              const text = typeof arg === "string" ? arg : "";
              if (!text) continue;
              for (const pattern of RELEVANT_PATTERNS) {
                if (pattern.test(text)) {
                  isRelevant = true;
                  break;
                }
              }
              if (isRelevant) break;
            }

            if (isRelevant) {
              try {
                const Sync = root.LyricLens?.Sync;
                if (Sync?.extractSongIdFromConsoleArgs) {
                  const candidateId = Sync.extractSongIdFromConsoleArgs(args);
                  if (candidateId) {
                    const diagnostics = root.LyricLens?.diagnostics;
                    if (diagnostics?.updateState) {
                      diagnostics.updateState({
                        lastConsoleSongIdCandidate: candidateId,
                        lastConsoleSongIdAt: Date.now(),
                        consoleSongIdExtractStrategy: "console-wrapper"
                      });
                    }
                    // Fallback: if PlayState hasn't delivered a songId, use this candidate
                    if (diagnostics?.getState) {
                      const state = diagnostics.getState();
                      if (!state.songId && !state.lastExtractedSongId) {
                        diagnostics.updateState({
                          songId: candidateId,
                          lastExtractedSongId: candidateId,
                          lastSongIdExtractStrategy: "console-fallback"
                        });
                      }
                    }
                    // Store for promotion check by main.js
                    try {
                      root.__LL_CONSOLE_SONG_ID_CANDIDATE = candidateId;
                      root.__LL_CONSOLE_SONG_ID_CANDIDATE_AT = Date.now();
                    } catch (_) {}
                  }
                }
              } catch (_) {}
            }
          }

          return original.apply(this, args);
        } finally {
          consoleWrapperDepth -= 1;
        }
      }
      wrappedConsoleMethod.__lyricLensConsoleWrapped = true;
      wrappedConsoleMethod.__lyricLensOriginal = original;
      try {
        target[methodName] = wrappedConsoleMethod;
        anyPatched = true;
      } catch (_) {}
    }
    if (patchedConsoles) patchedConsoles.add(target);
    if (anyPatched) {
      const diagnostics = root.LyricLens?.diagnostics;
      if (diagnostics?.updateState) {
        diagnostics.updateState({ runtimeLyricsCaptureInstalled: true });
      }
    }
    return anyPatched;
  }

  function getLastCapturedLyrics() {
    return lastCapturedLyrics;
  }

  function clearCapturedLyrics() {
    lastCapturedLyrics = null;
    lastCapturedLyricsSource = null;
    lastCapturedLyricsAt = 0;
    lastCapturedLyricsFingerprint = null;
    // Also wipe the onProcessLyrics-derived buffer. probeSources() and the
    // legacy getCapturedLyrics() fallback both read these — leaving them
    // populated after a song change means a stale payload can resurface
    // through those paths and get attributed to the new song.
    capturedPayload = null;
    lastPayload = null;
    capturedAt = 0;
    try {
      root.__LL_CAPTURED_LYRICS = null;
    } catch (_) {}
    try {
      root.__LYRICLENS_CAPTURED_ON_PROCESS_LYRICS = null;
    } catch (_) {}
  }

  function probeSources() {
    if (isParsedTimedLyricsArray(lastCapturedLyrics)) {
      const source = lastCapturedLyricsSource || "runtime.capture";
      updateLyricsSourceDiagnostics(source, lastCapturedLyrics);
      return lastCapturedLyrics;
    }

    try {
      const fromGlobal = root.__LL_CAPTURED_LYRICS;
      if (isParsedTimedLyricsArray(fromGlobal)) {
        updateLyricsSourceDiagnostics("window.__LL_CAPTURED_LYRICS", fromGlobal);
        return fromGlobal;
      }
    } catch (_) {}

    const directCandidates = [
      ["window.currentLyrics", () => root.currentLyrics],
      ["window.CPPLYRICS_INTERNALS.currentLyrics", () => root.CPPLYRICS_INTERNALS?.currentLyrics],
      ["window.AMLL.currentLyrics", () => root.AMLL?.currentLyrics]
    ];

    for (const [source, getter] of directCandidates) {
      let value;
      try {
        value = getter();
      } catch (_) {
        continue;
      }
      const found = findTimedLyricsArray(value, source);
      if (found) return recordTimedLyricsSource(found.source, found.payload);
    }

    for (const key of Object.keys(root || {})) {
      if (!/(lyric|lyrics|amll|cpp)/i.test(key)) continue;
      let value;
      try {
        value = root[key];
      } catch (_) {
        continue;
      }
      const found = findTimedLyricsArray(value, `window.${key}`);
      if (found) return recordTimedLyricsSource(found.source, found.payload);
    }

    return null;
  }

  function findTimedLyricsArray(value, source, depth = 0, seen = new WeakSet()) {
    if (isParsedTimedLyricsArray(value)) return { source, payload: value };
    if (!value || typeof value !== "object" || depth >= 2) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    for (const key of Object.keys(value).slice(0, 80)) {
      let child;
      try {
        child = value[key];
      } catch (_) {
        continue;
      }
      if (!child || (typeof child !== "object" && !Array.isArray(child))) continue;
      const found = findTimedLyricsArray(child, `${source}.${key}`, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  function getCurrentLyricsFromGlobals() {
    const probed = probeSources();
    if (probed) return { source: root.LyricLens?.diagnostics?.getState?.().lyricsSource || "probeSources", lines: normalizeLyricPayload(probed), payload: probed, capturedAt };

    const candidates = [
      ["window.currentLyrics", () => root.currentLyrics],
      ["window.CPPLYRICS_INTERNALS.currentLyrics", () => root.CPPLYRICS_INTERNALS?.currentLyrics],
      ["window.AMLL.currentLyrics", () => root.AMLL?.currentLyrics],
      ["window.__LYRICLENS_CAPTURED_ON_PROCESS_LYRICS", () => capturedPayload]
    ];

    for (const [source, getter] of candidates) {
      let payload;
      try {
        payload = getter();
      } catch (err) {
        console.warn("[LyricLens]", "歌词来源探测失败", source, err);
        continue;
      }
      if (!payload) continue;
      console.log("[LyricLens]", "歌词来源探测", source, describePayload(payload));
      const lines = normalizeLyricPayload(payload);
      if (lines.length) return { source, lines, payload, capturedAt };
    }
    return null;
  }

  function tryGetLyricsFromNcmRuntime() {
    const ncm = root.betterncm?.ncm;
    if (!ncm) return null;
    const Diagnostics = root.LyricLens?.Diagnostics;
    const result = Diagnostics?.safeGetPlayingSong
      ? Diagnostics.safeGetPlayingSong(root)
      : null;
    let song = result?.ok ? result.value : null;
    if (!Diagnostics?.safeGetPlayingSong) {
      try {
        song = ncm.getPlayingSong?.();
      } catch (err) {
        console.warn("[LyricLens]", "betterncm.ncm.getPlayingSong 探测失败", err);
      }
    }
    const candidates = [
      song?.lyrics,
      song?.lyric,
      song?.data?.lyrics,
      song?.data?.lyric,
      song?.data?.lrc
    ];
    for (const payload of candidates) {
      const lines = normalizeLyricPayload(payload);
      if (lines.length) return { source: "betterncm.ncm.getPlayingSong", lines, payload };
    }
    return null;
  }

  function getCapturedLyrics() {
    if (!capturedPayload) return null;
    const lines = normalizeLyricPayload(capturedPayload);
    return lines.length ? { source: "window.onProcessLyrics wrapper", lines, payload: capturedPayload, capturedAt } : null;
  }

  function getLastPayload() {
    return lastPayload || capturedPayload;
  }

  function captureProcessLyricsPayload(payload) {
    if (!payload) return;
    capturedPayload = payload;
    lastPayload = payload;
    capturedAt = Date.now();
    root.__LYRICLENS_CAPTURED_ON_PROCESS_LYRICS = payload;
    try {
      root.LyricLens?.diagnostics?.recordLyricsPayload?.("window.onProcessLyrics", payload);
    } catch (err) {
      console.warn("[LyricLens]", "歌词 payload 诊断采样失败", err);
    }
    console.log("[LyricLens]", "onProcessLyrics 捕获歌词", describePayload(payload));
  }

  function wrapOnProcessLyrics() {
    const original = root.onProcessLyrics;
    if (typeof original !== "function") return false;
    if (original.__lyricLensWrapped) return true;

    function wrappedOnProcessLyrics(...args) {
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then((value) => {
          captureProcessLyricsPayload(value);
          return value;
        });
      }
      captureProcessLyricsPayload(result);
      return result;
    }
    wrappedOnProcessLyrics.__lyricLensWrapped = true;
    wrappedOnProcessLyrics.__lyricLensOriginal = original;
    root.onProcessLyrics = wrappedOnProcessLyrics;
    console.log("[LyricLens]", "已安全包装 window.onProcessLyrics");
    return true;
  }

  function lyricsHash(lines) {
    const cache = root.LyricLens?.Cache;
    const text = formatLinesForPrompt(lines);
    if (cache?.hashString) return cache.hashString(text);
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
  }

  const api = {
    stripWordTimestamps,
    parseTimestampMs,
    parseLrcText,
    parseCppLyricsString,
    isParsedTimedLyricsArray,
    summarizeTimedLyricsArray,
    normalizeLyricPayload,
    preprocessLyricLinesWithReport,
    preprocessLyricLines,
    formatLinesForPrompt,
    probeSources,
    getCurrentLyricsFromGlobals,
    tryGetLyricsFromNcmRuntime,
    getCapturedLyrics,
    getLastPayload,
    wrapOnProcessLyrics,
    lyricsHash,
    installRuntimeLyricsCapture,
    getLastCapturedLyrics,
    clearCapturedLyrics,
    scanArgsForLyricsArray,
    fingerprintCapturedLyrics,
    onRuntimeLyricsCaptured,
    RUNTIME_CAPTURE_EVENT
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Lyrics = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

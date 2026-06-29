(function initLyricLensMain(root) {
  "use strict";

  const LL = root.LyricLens || {};
  const { Utils, Lyrics, Detect, Api, Cache, Sync, Settings, Panel, Diagnostics, Styles, Capture, Bridge, NcmLyricApi } = LL;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let settings = Settings.DEFAULT_SETTINGS;
  let diagnostics = null;
  let panel = null;
  let bridge = null;
  // Random per-session secret. Passed to companion on launch via --bridge-token
  // and presented in the WS hello frame. Defends against same-machine rogue
  // connections (notably browser tabs that can dial ws://127.0.0.1:47621).
  // Not persisted: if NCM restarts while an old companion is still running,
  // the user relaunches it from the panel — cost of that edge case is one
  // click, the gain is not having a long-lived secret on disk.
  let bridgeToken = "";
  let currentSongId = null;
  let suppressedSongId = null;
  let currentAnalysis = null;
  let activeController = null;
  let activeRequestId = 0;
  let lastProgressMs = 0;
  let lastLineIndex = null;
  let lastLyricsHash = null;
  let lastAnalyzedKey = null;
  let inFlightAnalyzeKey = null;
  let currentAnalyzeKey = null;
  let displayedAnalyzeKey = null;
  let currentCardOrdinal = 0;
  let lastSettledAnalyzeKey = null;
  let lastSettledAnalyzeStatus = null;
  let lastSettledAt = 0;
  let watchdogTimer = null;
  let playbackSyncTimer = null;
  let playbackBaseWallClock = 0;
  let playbackBaseMs = 0;
  let playbackHasRealTime = false;
  let lastProgressEventAt = 0;
  let playbackPaused = false;
  // Track whether the trusted time source is actually advancing. When AMLL
  // fails to find TTML for a song it stops updating --amll-player-time, but
  // the CSS var stays in the DOM with its frozen final value. We detect
  // freeze by remembering the last observed value and the wall-clock time
  // at which it changed; after TRUSTED_TIME_STALE_MS we fall back to
  // wall-clock extrapolation from playbackBaseMs.
  let lastTrustedTimeMs = null;
  let lastTrustedTimeChangedAt = 0;
  const TRUSTED_TIME_STALE_MS = 1500;
  // If AMLL hasn't pushed a new value in this long, infer paused. Normal
  // playback updates --amll-player-time at ~10Hz, so anything beyond a
  // few seconds is almost certainly NCM-paused, song-loading, or
  // AMLL-stuck. Better to freeze cards than to keep extrapolating into
  // a wildly wrong position.
  const TRUSTED_TIME_PAUSE_INFER_MS = 5000;
  // Within this many ms after a song change, refuse to anchor on an
  // unreliable time source (the AMLL CSS var, which freezes on the
  // previous song's tail when the slider DOM is mid-remount). Anchoring
  // there would yank cards to whatever ordinal corresponds to ~230s of
  // the new track — the "切歌开头卡片摇摆" symptom. We extrapolate from
  // songChangeAt instead, which always starts at 0 for a new song.
  const TRUSTED_TIME_DISTRUST_AFTER_SONG_CHANGE_MS = 5000;
  let autoFollowSuppressTimer = null;
  let domObserver = null;
  let analysisPlaybackState = null;
  let previousSongLyricsSignature = null;
  let previousSongLyricsHash = null;
  let songChangeAt = 0;
  let lastProgressRawTrackMarker = null;
  // Widened from 8000 → 12000ms because amll-state sometimes lags NCM's
  // internal songId flip by 5-8 seconds on slower machines; the previous
  // window expired before the new song's capture became available.
  const PREVIOUS_SONG_LYRICS_REJECT_MS = 12000;

  function buildLyricsTextSignature(lines) {
    if (!Array.isArray(lines) || !lines.length) return null;
    const texts = [];
    for (const line of lines) {
      const raw = String(line?.text ?? line?.original ?? "");
      if (!raw) continue;
      // Aggressive normalization so the same lyrics produce the same
      // signature regardless of which capture path produced them.
      // - <00:00.500> and (0,500) word timestamps leak through some
      //   capture sources (amll-state / console raw items) but are
      //   stripped by preprocessLyricLines on the analysis path.
      // - Parenthesized inline annotations / translations sometimes
      //   appear in one path and not the other.
      // - Strip every non-alphanumeric character (punctuation, full-width
      //   marks, whitespace) and lowercase the rest — the goal here is
      //   "are these the same lyrics", not byte-equality.
      const stripped = raw
        .replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, "")
        .replace(/\(\s*\d+(?:\.\d+)?\s*[,，:]\s*\d+(?:\.\d+)?(?:\s*[,，:]\s*\d+)?\s*\)/g, "")
        .replace(/[（(][^）)]*[）)]/g, "")
        .replace(/[^\p{L}\p{N}]/gu, "")
        .toLowerCase();
      if (stripped) texts.push(stripped);
      if (texts.length >= 30) break;
    }
    if (!texts.length) return null;
    return `${texts.length}|${texts.join("|")}`;
  }

  // Compute a precise FNV-1a hash over preprocessed lyric lines. Falls back
  // to null if the lines can't be preprocessed (no Lyrics module / empty
  // input). Used as a second stale-capture defense alongside the loose
  // signature above.
  function buildPreprocessedLyricsHash(lines) {
    if (!Array.isArray(lines) || !lines.length) return null;
    try {
      const preprocessed = Lyrics?.preprocessLyricLines?.(lines);
      if (!Array.isArray(preprocessed) || !preprocessed.length) return null;
      return Lyrics?.lyricsHash?.(preprocessed) || null;
    } catch (_) {
      return null;
    }
  }
  const AUTO_FOLLOW_SUPPRESS_MS = 3000;
  let lastPromotedConsoleSongId = null;
  const RUNTIME_CAPTURE_DEBOUNCE_MS = 600;
  const PLAYBACK_SYNC_INTERVAL_MS = 150;
  const PER_LINE_BATCH_SIZE = 5;
  const PER_LINE_BATCH_CONCURRENCY = 6;
  const TERMINAL_STATUSES = new Set(["success", "timeout", "error", "parse-error", "no-cards", "rate-limited"]);
  const FAILED_SETTLED_STATUSES = new Set(["timeout", "error", "parse-error", "no-cards", "rate-limited"]);
  let lyricsFingerprintToCanonicalKey = new Map();
  let keyAliasMap = new Map();
  let canonicalToProvisionalKeys = new Map();

  async function bootstrap() {
    if (!Utils || !Lyrics || !Detect || !Api || !Cache || !Sync || !Settings || !Panel || !Diagnostics || !Styles || !Capture) {
      console.error("[LyricLens]", "模块加载不完整，插件停止启动");
      return;
    }

    Utils.log("插件加载成功");
    try {
      Lyrics.installRuntimeLyricsCapture?.();
    } catch (err) {
      Utils.warn("installRuntimeLyricsCapture 失败", err);
    }
    diagnostics = Diagnostics.createDiagnostics(root);
    LL.diagnostics = diagnostics;
    if (diagnostics.enabled()) diagnostics.probeRuntime();
    Utils.injectInlineStyle("ll-panel-style", Styles.PANEL_CSS, diagnostics);
    settings = Settings.normalizeSettings(await Settings.readSettings());
    panel = Panel.createPanel({
      settings,
      isDebugEnabled: () => diagnostics?.enabled?.() === true,
      getDiagnosticState: () => diagnostics?.getState?.(),
      onSettingsSave: handleSettingsSave,
      onRetry: retryCurrentSong,
      onCloseCurrentSong: closeCurrentSong,
      onRestoreCurrentSong: restoreCurrentSong,
      onManualNavigation: handleManualNavigation,
      onAutoFollowChanged: handleAutoFollowChanged,
      onPopOutToggle: handlePopOutToggle,
      onStateChange: handlePanelStateChange,
      onCheckUpdate: () => triggerUpdateCheck({ silent: false }),
      onInstallUpdate: (payload) => triggerUpdateInstall(payload),
      onRequestRestart: () => triggerRestart()
    });
    if (diagnostics.enabled()) panel.mountDebugPanel();

    bridgeToken = generateBridgeToken();
    if (Bridge?.createBridge) {
      bridge = Bridge.createBridge({
        port: Bridge.DEFAULT_PORT,
        clientVersion: "0.1.0",
        token: bridgeToken,
        getSnapshot: buildBridgeSnapshot,
        onStatusChange: (status) => {
          panel?.setBridgeStatus?.(status);
          diagnostics?.updateState?.({ bridgeStatus: status });
        },
        onCommand: handleBridgeCommand,
        logger: (...args) => {
          if (diagnostics?.enabled?.()) {
            try { console.log("[LyricLens:bridge]", ...args); } catch (_) {}
          }
        }
      });
      LL.bridge = bridge;
    }

    installLyricsWrapperProbe();

    // Set up DOM lyrics observer (runs continuously in background)
    try {
      domObserver = Capture.createDomLyricsObserver?.(root, (payload) => {
        if (payload && payload.lines && payload.lines.length) {
          handleCapturePayload(payload);
        }
      });
      if (domObserver?.start) domObserver.start();
      diagnostics?.updateState?.({ captureStatus: "source-ready" });
    } catch (err) {
      Utils.warn("DOM lyrics observer 初始化失败", err);
    }

    // Register for console capture events (fallback source)
    try {
      Lyrics.onRuntimeLyricsCaptured?.(handleRuntimeLyricsCapturedDebounced);
    } catch (err) {
      Utils.warn("onRuntimeLyricsCaptured 注册失败", err);
    }
    Sync.startProgressListener(handleProgress, diagnostics);
    Sync.startSongMonitor(handleSongChange, handlePlayState, diagnostics);
    // AMLL's "音乐播放进度跳变" warning carries an unreliable time (it's the
    // jump TARGET, not the current position), but the trackId it embeds is
    // gold: the songId flips on every real song change while seeks keep it
    // stable. On this BetterNCM build that's our only dependable song-change
    // signal — PlayState is dead, getPlaying() throws (so startSongMonitor
    // never fires), and the console-content-diff fallback silently misses
    // re-played songs because NCM doesn't re-log their lyrics. Drive
    // handleSongChange from the parsed songId; guard on currentSongId so
    // seeks (same trackId) don't spuriously re-trigger a reset.
    Sync.installAmllWarningProbe?.((timeMs, args, parsed) => {
      diagnostics?.updateState?.({
        lastAmllWarningTimeMs: timeMs,
        lastAmllWarningAt: Date.now(),
        lastAmllWarningSongId: parsed?.songId || null
      });
      const sid = parsed?.songId;
      if (sid && sid !== currentSongId) {
        console.log("[LyricLens:song-change-from-amll-warning]", { from: currentSongId, to: sid });
        handleSongChange(sid);
      }
    });
    // Last-resort song-change signal: NCM's progress slider carries the
    // track duration on `max`. When it shifts, the song changed — even
    // when AMLL's console.warn hook got clobbered (which it does on this
    // build) and lyrics-content-diff misses re-played songs. We don't get
    // a songId from the slider, so feed softResetForNewLyrics; the next
    // lyrics capture (DOM observer restarted below) drives analyze.
    Sync.startProgressDurationMonitor?.(({ prevSec, nextSec }) => {
      console.log("[LyricLens:song-change-from-slider-duration]", {
        prevSec, nextSec, currentSongId
      });
      softResetForNewLyrics({ reason: "slider-duration-changed" });
      // CRITICAL: softResetForNewLyrics deliberately keeps the capture
      // buffer (its original caller — handleCapturePayload — has the new
      // payload in hand). Our caller does NOT: the DOM observer has just
      // been reset and the new song's lyrics haven't arrived yet. If we
      // leave the buffer holding the previous song's lyrics, a user
      // pressing the loading-state retry button will pull THOSE stale
      // lyrics out of getLastCapturedLyrics() and analyze them as the new
      // song — the "shows song A's lyrics but syncs to song B's time"
      // catastrophe. Clear it so retry waits for fresh capture.
      Lyrics.clearCapturedLyrics?.();
      try {
        if (domObserver?.cleanup) { domObserver.cleanup(); domObserver = null; }
        domObserver = Capture.createDomLyricsObserver?.(root, (payload) => {
          if (payload && payload.lines && payload.lines.length) {
            handleCapturePayload(payload);
          }
        });
        if (domObserver?.start) domObserver.start();
      } catch (_) {}
      // Drive analyzeSong proactively, mirroring handleSongChange — it'd
      // otherwise wait passively for the DOM observer to push a payload,
      // and we just nuked the capture buffer so a retry click would also
      // find nothing. analyzeSong's internal waitForCapture (12s) is the
      // right primitive to let the new song's lyrics arrive on their own
      // schedule, including on re-played tracks where the console-print
      // path is silent.
      // analyzeSong is async; a synchronous try-catch wouldn't see its
      // rejections, so handle them via .catch() to suppress unhandled-promise
      // noise without masking real errors elsewhere.
      analyzeSong(currentSongId, { forceRefresh: false, trigger: "slider-duration" }).catch(() => {});
    }, diagnostics);

    // Master switch may have been flipped off in a prior session. The
    // overlay was just created visible; sync it to the persisted state.
    // currentSongId is still null here, so the retry branch is a no-op.
    applyEnabledState();

    // Silent background update probe — gated by settings.autoCheckUpdate
    // (default on). Sets a badge on the gear icon if a newer version
    // exists than what the user has seen.
    scheduleStartupUpdateCheck();
  }

  const handleRuntimeLyricsCapturedDebounced = Utils.debounce((detail) => {
    handleCaptureFromConsole(detail);
  }, RUNTIME_CAPTURE_DEBOUNCE_MS);

  function handleCaptureFromConsole(detail) {
    if (!detail || !Array.isArray(detail.payload) || !detail.payload.length) return;

    // Use capture pipeline: console source already has the payload, pass it through
    const payload = Capture.readConsoleCapturedLyrics?.(root);
    if (payload && payload.lines.length) {
      handleCapturePayload(payload);
    }
  }

  function handleCapturePayload(payload) {
    if (!payload || !Array.isArray(payload.lines) || !payload.lines.length) return;
    // Master switch: when disabled we drop the capture on the floor. We
    // do NOT shut down the DOM observer because resumption needs to be
    // instant — restarting an observer mid-song would miss the lyric
    // already on screen.
    if (settings.enabled === false) {
      diagnostics?.updateState?.({ analysisSkippedReason: "plugin-disabled" });
      return;
    }
    const source = payload.source || "unknown";
    const songId = currentSongId || diagnostics?.getState?.()?.songId || payload.songId || null;

    if (songId && suppressedSongId === songId) {
      diagnostics?.updateState?.({ analysisSkippedReason: "suppressed" });
      return;
    }

    // ── Implicit song-change detection ──
    // On NCM builds where PlayState/PlayProgress events don't fire and
    // betterncm.ncm.getPlaying() throws (observed on at least one user's
    // setup), handleSongChange never runs. The capture content itself is
    // then the only reliable signal: if the new lyrics fingerprint differs
    // from the analysis we're displaying, treat it as a song change and
    // clear stale analysis state so the new lyrics get a fresh run.
    if (currentAnalysis?.lines?.length) {
      const candidate = payload.lines.map((l) => ({
        text: l.original ?? l.text,
        startTime: l.startMs,
        endTime: l.endMs
      }));
      const candidateSig = buildLyricsTextSignature(candidate);
      const currentSig = buildLyricsTextSignature(currentAnalysis.lines);
      const sigDiffers = Boolean(candidateSig) && Boolean(currentSig) && candidateSig !== currentSig;
      let needsReset = sigDiffers;
      if (!needsReset && candidateSig && currentSig) {
        // Signatures match. Double-check with the precise hash to catch the
        // rare case where the loose signature collapses two different lyrics.
        const candHash = buildPreprocessedLyricsHash(candidate);
        const curHash = Lyrics.lyricsHash?.(currentAnalysis.lines);
        needsReset = Boolean(candHash) && Boolean(curHash) && candHash !== curHash;
      }
      if (needsReset) {
        console.log("[LyricLens:song-change-from-capture]", {
          source,
          from: currentSongId,
          prevSigHead: currentSig ? currentSig.slice(0, 40) : null,
          nextSigHead: candidateSig ? candidateSig.slice(0, 40) : null
        });
        softResetForNewLyrics({ reason: "capture-lyrics-changed" });
        // currentSongId may still be stale (we couldn't refresh it without a
        // working PlayState/PlayProgress signal), so cacheKey uses the same
        // songId + new lyricsHash — that's a fresh key, cache miss, fresh
        // analysis. The displayedAnalyzeKey will track this new key.
      }
    }

    // ── Grace-window stale-capture drop ──
    // Within PREVIOUS_SONG_LYRICS_REJECT_MS of a song change, drop captures
    // whose lines match the previous song. amll-state / console / DOM all
    // lag NCM's internal songId flip, so a's lyrics can arrive after
    // handleSongChange has set currentSongId = b and get attributed to b —
    // that's the "切歌但卡片不变" bug.
    //
    // Two-layer fingerprint: signature (loose, format-tolerant) catches
    // amll-state ↔ analysis path drift; lyricsHash (exact, on preprocessed
    // text) catches anything the signature missed.
    if ((previousSongLyricsSignature || previousSongLyricsHash)
        && Date.now() - songChangeAt < PREVIOUS_SONG_LYRICS_REJECT_MS) {
      const candidateLines = payload.lines.map((l) => ({
        text: l.original ?? l.text,
        startTime: l.startMs,
        endTime: l.endMs
      }));
      const candidateSig = buildLyricsTextSignature(candidateLines);
      const candidateHash = buildPreprocessedLyricsHash(candidateLines);
      const sigMatch = Boolean(candidateSig) && candidateSig === previousSongLyricsSignature;
      const hashMatch = Boolean(candidateHash) && candidateHash === previousSongLyricsHash;
      if (sigMatch || hashMatch) {
        diagnostics?.updateState?.({
          analysisSkippedReason: "previous-song-capture-in-grace-window",
          analyzeTriggerBlockedReason: "previous-song-capture-in-grace-window",
          staleLyricsRejectedAt: Date.now(),
          staleLyricsRejectedSource: source,
          staleLyricsRejectedBy: sigMatch && hashMatch ? "sig+hash" : (sigMatch ? "sig" : "hash"),
          staleLyricsPrevSigSample: previousSongLyricsSignature ? previousSongLyricsSignature.slice(0, 100) : null,
          staleLyricsCandidateSigSample: candidateSig ? candidateSig.slice(0, 100) : null,
          staleLyricsPrevHash: previousSongLyricsHash || null,
          staleLyricsCandidateHash: candidateHash || null
        });
        return;
      }
      // Record near-miss diagnostics so a future "bug still happens" report
      // tells us whether the grace window saw the stale capture at all.
      diagnostics?.updateState?.({
        lastStaleCheckPassedAt: Date.now(),
        lastStaleCheckSource: source,
        lastStaleCheckPrevSigSample: previousSongLyricsSignature ? previousSongLyricsSignature.slice(0, 100) : null,
        lastStaleCheckCandidateSigSample: candidateSig ? candidateSig.slice(0, 100) : null,
        lastStaleCheckPrevHash: previousSongLyricsHash || null,
        lastStaleCheckCandidateHash: candidateHash || null
      });
    }

    // ── Arbitration: low-quality DOM must not override active capture ──
    const currentState = diagnostics?.getState?.() || {};
    const newScore = Capture.computeCaptureScore?.(payload) || 0;
    const activeScore = currentState.activeCaptureScore || 0;

    // Only apply strict gating to DOM source (lowest confidence)
    if (source === "dom-lyrics") {
      const hasActiveCapture =
        currentState.captureStatus === "captured-valid-lines" ||
        currentState.captureStatus === "using-cache";
      const isAnalyzing =
        currentState.analyzeTriggerStatus === "running" ||
        currentState.analyzeTriggerStatus === "success" ||
        currentState.apiStatus === "requesting" ||
        currentState.apiStatus === "success" ||
        currentState.apiStatus === "cache-hit" ||
        Boolean(currentState.inFlightAnalyzeKey);

      if (!Capture.hasCompleteLineTiming?.(payload)) {
        diagnostics?.updateState?.({
          skippedCaptureReason: hasActiveCapture || isAnalyzing
            ? "dom-outranked-by-active-capture"
            : "dom-source-missing-timing",
          domLyricsRejectedReason: "dom-source-missing-timing",
          analyzeTriggerStatus: hasActiveCapture || isAnalyzing
            ? currentState.analyzeTriggerStatus
            : "blocked-no-timed-lyrics",
          analyzeTriggerBlockedReason: hasActiveCapture || isAnalyzing
            ? currentState.analyzeTriggerBlockedReason || null
            : "dom-source-missing-timing",
          lastSkippedCaptureSample: Array.isArray(payload.lines)
            ? payload.lines.slice(0, 2).map((l) => (l.original || "").slice(0, 60))
            : null
        });
        return;
      }

      // DOM must not replace a better or equal active source
      if (isAnalyzing && newScore <= activeScore + 20) {
        const skipCount = (currentState.skippedDuplicateAnalyzeCount || 0) + 1;
        diagnostics?.updateState?.({
          skippedCaptureReason: "dom-outranked-by-active-capture",
          skippedDuplicateAnalyzeCount: skipCount,
          lastSkippedCaptureSample: Array.isArray(payload.lines)
            ? payload.lines.slice(0, 2).map((l) => (l.original || "").slice(0, 60))
            : null
        });
        return;
      }
      if (hasActiveCapture && !isAnalyzing && newScore <= activeScore + 10) {
        const skipCount = (currentState.skippedDuplicateAnalyzeCount || 0) + 1;
        diagnostics?.updateState?.({
          skippedCaptureReason: "dom-outranked-by-active-capture",
          skippedDuplicateAnalyzeCount: skipCount,
          lastSkippedCaptureSample: Array.isArray(payload.lines)
            ? payload.lines.slice(0, 2).map((l) => (l.original || "").slice(0, 60))
            : null
        });
        return;
      }
    }

    // For console / amll-state: let analyzeSong handle dedup internally
    // For DOM with sufficient quality: proceed

    // ── Build capture options for analyze ──
    const capturePayload = payload.lines.map((l) => ({
      index: l.lineIndex,
      text: l.original,
      startTime: l.startMs,
      endTime: l.endMs,
      referenceTranslation: l.translation || undefined,
      romanLyric: l.romanLyric || undefined
    }));
    const fingerprint = Lyrics.fingerprintCapturedLyrics?.(capturePayload);

    diagnostics?.updateState?.({
      captureStatus: "captured-valid-lines",
      captureSource: source,
      analyzeTriggerStatus: "pending",
      lastCapturedAt: payload.capturedAt || Date.now(),
      lastCaptureSource: source,
      lyricLineCount: payload.lines.length,
      analyzeTriggerBlockedReason: null,
      activeCaptureSource: source,
      activeCaptureLineCount: payload.lines.length,
      activeCaptureScore: newScore,
      captureConfidence: payload.confidence || null,
      lastCaptureSample: Array.isArray(payload.lines)
        ? payload.lines.slice(0, 3).map((l) => (l.original || "").slice(0, 60))
        : null
    });

    analyzeSong(songId, {
      forceRefresh: false,
      capturePayload,
      captureSource: source,
      captureFingerprint: fingerprint,
      trigger: "capture-pipeline"
    });
  }

  // Legacy: keep for backward compat
  function triggerAnalyzeFromRuntimeCapture(detail) {
    if (!detail || !Array.isArray(detail.payload) || !detail.payload.length) return;

    // Try to extract a console songId candidate from the captured payload source
    // (e.g. AMLL console args like "1893590234_XIAY0O")
    let consoleSongId = null;
    if (detail.source && typeof detail.source === "string") {
      consoleSongId = Sync.extractSongIdFromConsoleString?.(detail.source);
    }
    if (!consoleSongId && detail.payload) {
      // Also try the first few payload items for embedded IDs
      consoleSongId = Sync.extractSongIdFromConsoleArgs?.(detail.payload);
    }
    if (consoleSongId && diagnostics?.enabled?.()) {
      console.log("[LyricLens:songid]", "console candidate", consoleSongId, "source", detail.source);
    }
    if (consoleSongId) {
      diagnostics?.updateState?.({
        lastConsoleSongIdCandidate: consoleSongId,
        lastConsoleSongIdAt: Date.now(),
        consoleSongIdExtractStrategy: "capture-payload"
      });
      // Try to promote existing captured:* key to songId-based key
      tryPromoteCapturedKeyFromConsoleSongId(consoleSongId, detail.fingerprint);
    }

    const songId = currentSongId || diagnostics?.getState?.()?.songId || consoleSongId || null;
    diagnostics?.updateState?.({
      lastCaptureSource: detail.source || null,
      lastCapturedAt: detail.capturedAt || Date.now(),
      lastAutoAnalyzeAt: Date.now()
    });
    if (songId && suppressedSongId === songId) {
      diagnostics?.updateState?.({ analysisSkippedReason: "suppressed" });
      return;
    }
    analyzeSong(songId, {
      forceRefresh: false,
      capturePayload: detail.payload,
      captureSource: detail.source,
      captureFingerprint: detail.fingerprint,
      trigger: "runtime-capture"
    });
  }

  function installLyricsWrapperProbe() {
    let attempts = 0;
    const tryWrap = () => {
      attempts += 1;
      const wrapped = Lyrics.wrapOnProcessLyrics();
      if (wrapped || attempts >= 10) clearInterval(timer);
    };
    const timer = setInterval(tryWrap, 1000);
    tryWrap();
  }

  // ── PlayState handler (pause / resume / stop) ──

  function handlePlayState(parsed) {
    if (!parsed) return;
    const diagPartial = {
      lastPlayStateStatus: parsed.playbackStatus,
      lastPlayStateAt: Date.now(),
      lastPlayStateArgsSummary: parsed.playStateArgsSummary || null,
      rawSongIdCandidate: parsed.rawSongIdCandidate ?? null,
      lastRawSongIdCandidate: parsed.rawSongIdCandidate ?? null,
      lastExtractedSongId: parsed.songId ?? null,
      lastSongIdExtractStrategy: parsed.songIdExtractStrategy || null
    };
    // Track track- → numeric normalization
    if (parsed.normalizedTrackIdFrom && parsed.normalizedTrackIdTo) {
      const state = diagnostics?.getState?.() || {};
      diagPartial.normalizedTrackIdCount = (state.normalizedTrackIdCount || 0) + 1;
      diagPartial.lastNormalizedTrackIdFrom = parsed.normalizedTrackIdFrom;
      diagPartial.lastNormalizedTrackIdTo = parsed.normalizedTrackIdTo;
    }
    diagnostics?.updateState?.(diagPartial);
    switch (parsed.playbackStatus) {
      case "pause":
        playbackPaused = true;
        diagnostics?.updateState?.({ playbackSyncStatus: "paused", playbackPaused: true });
        break;
      case "resume":
      case "play":
        playbackPaused = false;
        playbackBaseWallClock = 0;
        playbackBaseMs = Number.isFinite(lastProgressMs) ? lastProgressMs : 0;
        diagnostics?.updateState?.({ playbackSyncStatus: "running", playbackPaused: false });
        break;
      case "stop":
        playbackPaused = true;
        playbackBaseMs = 0;
        diagnostics?.updateState?.({ playbackSyncStatus: "stopped", playbackPaused: true });
        break;
      default:
        break;
    }
  }

  // ── Auto-follow coordination ──

  function handleManualNavigation({ index, ordinal }) {
    clearAutoFollowSuppressTimer();
    if (panel?.setAutoFollow) panel.setAutoFollow(false);
    autoFollowSuppressTimer = setTimeout(() => {
      autoFollowSuppressTimer = null;
      if (panel?.setAutoFollow) panel.setAutoFollow(true);
      diagnostics?.updateState?.({
        autoFollowSuppressedUntil: null,
        autoFollowRestoreReason: "timer-expired"
      });
    }, AUTO_FOLLOW_SUPPRESS_MS);
    const suppressedUntil = Date.now() + AUTO_FOLLOW_SUPPRESS_MS;
    diagnostics?.updateState?.({
      autoFollowSuppressedUntil: suppressedUntil,
      lastManualNavigationAt: Date.now(),
      autoFollowRestoreReason: null
    });
  }

  function handleAutoFollowChanged(value) {
    if (value === true) {
      clearAutoFollowSuppressTimer();
      diagnostics?.updateState?.({
        autoFollowSuppressedUntil: null,
        autoFollowRestoreReason: "manual-toggle"
      });
    }
    if (value === false && autoFollowSuppressTimer) {
      // User manually turned off while the manual-navigation suppress timer
      // is running. Cancel the timer too — otherwise it fires N seconds later
      // and silently flips autoFollow back to true behind the user's back
      // ("跟随" toggle randomly reverts). Matches the harness behavior in
      // tests/manual-auto-follow.test.js manualToggleFollow.
      clearAutoFollowSuppressTimer();
      diagnostics?.updateState?.({
        autoFollowSuppressedUntil: null,
        autoFollowRestoreReason: "manual-off"
      });
    }
  }

  function clearAutoFollowSuppressTimer() {
    if (autoFollowSuppressTimer) {
      clearTimeout(autoFollowSuppressTimer);
      autoFollowSuppressTimer = null;
    }
  }

  // ── Bridge (desktop companion) ──

  function buildBridgeSnapshot() {
    if (!Bridge?.buildSnapshot) return null;
    const snap = panel?.getPanelSnapshot?.();
    if (!snap) return null;
    return Bridge.buildSnapshot({
      panelState: snap.panelState,
      settings: snap.settings,
      mode: snap.mode,
      loadingMessage: snap.mode === "loading" ? snap.message : null,
      errorMessage: snap.mode === "error" ? snap.message : null,
      language: snap.language,
      song: snap.songId ? { id: String(snap.songId) } : null,
      playbackMs: Number.isFinite(lastProgressMs) ? lastProgressMs : null
    });
  }

  function handlePanelStateChange() {
    bridge?.publish?.("panel-change");
  }

  function handlePopOutToggle(value) {
    if (value) {
      panel?.setPoppedOut?.(true);
      tryLaunchCompanion();
      bridge?.popOut?.();
    } else {
      bridge?.popIn?.();
      panel?.setPoppedOut?.(false);
    }
  }

  function generateBridgeToken() {
    // 32 hex chars = 128 bits. crypto.randomUUID() is available in modern
    // Electron/Chromium; fall back to crypto.getRandomValues. We never fall
    // back to Math.random — predictable token defeats the whole point.
    try {
      const crypto = root.crypto;
      if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, "");
      if (crypto?.getRandomValues) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (_) {}
    return "";
  }

  // Accept only an absolute Windows-style path to an .exe, with no characters
  // that could break out of cmd.exe's quoted-argument parsing or be reserved
  // in Win32 paths (`" < > | * ?` and control chars). Anything else is a
  // potential command-injection vector — path is user-typed in the settings
  // panel, so a stray `"` lets the rest of the string run as a fresh
  // command (e.g. `C:\x.exe" & calc & rem `).
  const COMPANION_EXE_PATH_RE = /^[A-Za-z]:\\[^"<>|*?\x00-\x1f]+\.exe$/;

  function tryLaunchCompanion() {
    const path = String(settings.companionExePath || "").trim();
    if (!path) return;
    if (!COMPANION_EXE_PATH_RE.test(path)) {
      Utils.warn("companion exe path rejected (must be absolute Windows .exe path)", path);
      diagnostics?.updateState?.({
        companionLaunchAttemptedAt: Date.now(),
        companionLaunchRejectedReason: "invalid-path"
      });
      return;
    }
    const exec = root.betterncm?.app?.exec;
    if (typeof exec !== "function") return;
    // Wrap in `start ""` so betterncm.app.exec returns without waiting; the
    // empty quoted string is the window title (not the path). Token is hex
    // only (regex-validated in generateBridgeToken's call sites — empty or
    // [0-9a-f]+), so it cannot contain shell metacharacters.
    const tokenArg = /^[0-9a-f]+$/.test(bridgeToken) ? ` --bridge-token=${bridgeToken}` : "";
    const cmd = `cmd /c start "" "${path}"${tokenArg}`;
    try {
      const result = exec(cmd, false, false);
      if (result && typeof result.catch === "function") {
        result.catch((err) => Utils.warn("companion exec rejected", err));
      }
      diagnostics?.updateState?.({ companionLaunchAttemptedAt: Date.now() });
    } catch (err) {
      Utils.warn("companion exec threw", err);
    }
  }

  function handleBridgeCommand(name, payload) {
    switch (name) {
      case "next":
        panel?.nextCard?.();
        break;
      case "prev":
        panel?.prevCard?.();
        break;
      case "toggleAutoFollow":
        if (panel?.setAutoFollow && panel?.getAutoFollow) {
          panel.setAutoFollow(!panel.getAutoFollow());
        }
        break;
      case "closeCurrentSong":
        closeCurrentSong(currentSongId);
        break;
      case "retry":
        retryCurrentSong(currentSongId);
        break;
      case "popIn":
        handlePopOutToggle(false);
        break;
      default:
        break;
    }
  }

  // ── Cache fallback diagnostics ──

  function recordCacheFallbackNotUsed(cacheResult) {
    if (!cacheResult?.cacheKey) return;
    Utils.log("缓存命中但不作为当前捕获结果", cacheResult.cacheKey);
    diagnostics?.updateState?.({
      cacheHit: true,
      cacheKey: cacheResult.cacheKey,
      cacheUseStatus: "diagnostic-only",
      analysisSkippedReason: "cache-hit-not-used",
      analyzeTriggerBlockedReason: "cache-hit-not-used"
    });
  }

  // ── Periodic console songId promotion check ──

  function checkConsoleSongIdPromotion() {
    let candidateId = null;
    try { candidateId = root.__LL_CONSOLE_SONG_ID_CANDIDATE; } catch (_) {}
    if (!candidateId || candidateId === lastPromotedConsoleSongId) return;

    const currentLyrics = Lyrics.getLastCapturedLyrics?.();
    if (!currentLyrics || !currentLyrics.length) return;
    const fingerprint = Lyrics.fingerprintCapturedLyrics?.(currentLyrics);
    if (!fingerprint) return;

    lastPromotedConsoleSongId = candidateId;
    tryPromoteCapturedKeyFromConsoleSongId(candidateId, fingerprint);
  }

  // ── Console songId → canonical promotion ──

  function tryPromoteCapturedKeyFromConsoleSongId(candidateId, fingerprint) {
    if (!candidateId || !fingerprint) return;
    const existingCanonical = lyricsFingerprintToCanonicalKey.get(fingerprint);
    if (!existingCanonical || typeof existingCanonical !== "string") return;
    if (!existingCanonical.startsWith("captured:")) return;

    // Compute what the songId-based key would be
    const currentLyrics = Lyrics.getLastCapturedLyrics?.();
    if (!currentLyrics || !currentLyrics.length) return;
    const lyricsHash = Lyrics.lyricsHash(Lyrics.preprocessLyricLines(currentLyrics));
    const newRawKey = Cache.buildCacheKey({
      songId: candidateId,
      lyricsHash,
      apiEndpoint: settings.apiEndpoint,
      modelName: settings.modelName,
      promptVersion: Api.PROMPT_VERSION
    });

    // Only promote if the captured key is the currently settled one (cards exist)
    if (lastSettledAnalyzeKey === existingCanonical && lastSettledAnalyzeStatus === "success") {
      promoteCanonicalKey(fingerprint, newRawKey);
      diagnostics?.updateState?.({
        keyAliasReason: "captured-key-promoted-from-console-song-id"
      });
      if (diagnostics?.enabled?.()) {
        console.log("[LyricLens:songid]", "promoted captured key from console candidate", {
          from: existingCanonical,
          to: newRawKey,
          candidate: candidateId
        });
      }
    }
  }

  async function handleSettingsSave(nextSettings) {
    const previousSettings = settings;
    const mergedSettings = Settings.normalizeSettings({ ...settings, ...nextSettings });
    const analysisKeys = [
      "apiEndpoint", "apiKey", "modelName", "autoAnalyze", "analyzeTimeoutMs",
      "maxAnalysisLines", "analyzeMaxTokens", "analyzeTemperature", "fallbackOnTimeout",
      "fallbackMaxLines", "fallbackMaxTokens", "fallbackTimeoutMs", "cardGenerationMode",
      "responseFormatMode", "modelThinkingMode"
    ];
    const analysisSettingsChanged = analysisKeys.some((key) => previousSettings?.[key] !== mergedSettings[key]);
    const enabledChanged = previousSettings?.enabled !== mergedSettings.enabled;
    settings = await Settings.writeSettings(mergedSettings);
    panel?.setSettings(settings);
    if (enabledChanged) applyEnabledState();
    diagnostics?.updateState?.({
      lastError: null,
      pluginEnabled: settings.enabled !== false,
      settingsChangeAnalyzeTriggered: analysisSettingsChanged && settings.autoAnalyze === true && settings.enabled !== false
    });
    if (analysisSettingsChanged && settings.autoAnalyze === true && settings.enabled !== false && currentSongId && !suppressedSongId) {
      retryCurrentSong(currentSongId);
    }
    return settings;
  }

  // Master enable/disable. Called from handleSettingsSave when the
  // master switch flips. Hides/shows the overlay and aborts any
  // in-flight request on disable; on re-enable triggers a fresh
  // analyze for the current song so the user sees output immediately.
  function applyEnabledState() {
    const enabled = settings.enabled !== false;
    panel?.setHidden?.(!enabled);
    if (!enabled) {
      abortActiveRequest({ reason: "plugin-disabled" });
    } else if (currentSongId && !suppressedSongId) {
      retryCurrentSong(currentSongId);
    }
  }

  // ----- Update channel (Stage 1 #2) -------------------------------
  //
  // Backed by src/updater.js + the Cloudflare Worker at
  // lyriclens.yoru-and-akari.dev. Bootstrap fires one silent check
  // when settings.autoCheckUpdate is on; the result drives a badge
  // on the gear icon. User explicitly clicks "更新到 vX.X.X" in the
  // About tab to install — we never auto-install. Restart is also
  // user-driven via a button.

  async function triggerUpdateCheck(options = {}) {
    const Updater = LL.Updater;
    if (!Updater) return;
    const silent = options.silent === true;
    panel?.setUpdateState?.({ status: "checking", error: null });
    const current = Updater.readPluginVersion();
    try {
      const result = await Updater.checkForUpdate(current);
      const patch = {
        status: result.state,
        current,
        latest: result.latest || "",
        payload: result.payload || null,
        error: result.error || null,
        lastCheckedAt: Date.now()
      };
      panel?.setUpdateState?.(patch);
      diagnostics?.updateState?.({
        updateCheckStatus: result.state,
        updateCheckLatest: result.latest || null,
        updateCheckError: result.error || null,
        updateCheckAt: patch.lastCheckedAt,
        updateCheckTrigger: silent ? "auto" : "manual"
      });
    } catch (err) {
      panel?.setUpdateState?.({
        status: "error",
        error: err?.message || String(err),
        lastCheckedAt: Date.now()
      });
      Utils?.warn?.("checkForUpdate 抛出异常", err);
    }
  }

  async function triggerUpdateInstall(payload) {
    const Updater = LL.Updater;
    if (!Updater) return;
    panel?.setUpdateState?.({
      installing: true,
      installStage: null,
      installError: null,
      installedNeedsRestart: false
    });
    const result = await Updater.downloadAndInstall(payload, {
      onProgress: (stage) => {
        panel?.setUpdateState?.({ installStage: stage });
      }
    });
    if (result.ok) {
      panel?.setUpdateState?.({
        installing: false,
        installStage: "write-done",
        installedNeedsRestart: true
      });
      diagnostics?.updateState?.({
        updateInstallResult: "ok",
        updateInstallBytes: result.sizeBytes,
        updateInstallAt: Date.now()
      });
    } else {
      panel?.setUpdateState?.({
        installing: false,
        installError: result.error || "未知错误"
      });
      diagnostics?.updateState?.({
        updateInstallResult: "error",
        updateInstallError: result.error,
        updateInstallAt: Date.now()
      });
      Utils?.warn?.("downloadAndInstall 失败", result.error);
    }
  }

  function triggerRestart() {
    const Updater = LL.Updater;
    if (!Updater) return;
    const result = Updater.requestRestart();
    if (!result.ok) {
      panel?.setUpdateState?.({
        installError: `重启失败：${result.error}（请手动重启 NCM）`
      });
    }
  }

  function scheduleStartupUpdateCheck() {
    if (settings.autoCheckUpdate === false) return;
    // Defer 6s after bootstrap so we don't compete with NCM's own
    // startup network traffic or song-change analyze pipeline.
    setTimeout(() => {
      triggerUpdateCheck({ silent: true }).catch(() => {});
    }, 6000);
  }

  // Builds the DOM for BetterNCM's native plugin-config page. Kept
  // intentionally minimal: a master enable/disable toggle plus a
  // pointer to the overlay's gear icon for the rest of the settings —
  // porting every form field here would duplicate UI for no real win.
  // The plugin tile in BetterNCM's plugin manager only becomes
  // clickable when this is registered, which is the other reason it
  // exists.
  function buildNativeConfigPage() {
    const doc = root.document;
    const container = doc.createElement("div");
    container.style.cssText = "padding:20px 22px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:inherit;max-width:520px;";

    const meta = root.plugin || {};
    const title = doc.createElement("div");
    title.style.cssText = "font-size:18px;font-weight:600;margin-bottom:4px;";
    title.textContent = meta.name || "LyricLens";
    container.appendChild(title);

    const subtitle = doc.createElement("div");
    subtitle.style.cssText = "font-size:12px;opacity:0.6;margin-bottom:20px;";
    subtitle.textContent = meta.version ? "v" + meta.version : "";
    if (subtitle.textContent) container.appendChild(subtitle);

    const toggleRow = doc.createElement("label");
    toggleRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid rgba(127,127,127,0.3);border-radius:8px;cursor:pointer;user-select:none;margin-bottom:16px;";

    const toggleText = doc.createElement("div");
    const toggleLabel = doc.createElement("div");
    toggleLabel.textContent = "启用 LyricLens";
    toggleLabel.style.cssText = "font-size:14px;font-weight:500;";
    const toggleHint = doc.createElement("div");
    toggleHint.textContent = "关闭后悬浮窗隐藏、不再分析歌词，但插件仍在后台等待开启。";
    toggleHint.style.cssText = "font-size:12px;opacity:0.65;margin-top:2px;line-height:1.5;";
    toggleText.appendChild(toggleLabel);
    toggleText.appendChild(toggleHint);
    toggleRow.appendChild(toggleText);

    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = settings.enabled !== false;
    checkbox.style.cssText = "width:18px;height:18px;cursor:pointer;flex-shrink:0;";
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked;
      checkbox.disabled = true;
      try {
        await handleSettingsSave({ enabled: next });
      } catch (err) {
        Utils.warn("native-config 保存 enabled 失败", err);
        checkbox.checked = settings.enabled !== false;
      } finally {
        checkbox.disabled = false;
      }
    });
    toggleRow.appendChild(checkbox);
    container.appendChild(toggleRow);

    // Update card — mirrors the overlay's About tab so the native
    // BetterNCM config page is usable for "is there a new version?"
    // without having to launch a song first.
    const updateCard = doc.createElement("div");
    updateCard.style.cssText = "padding:14px;border:1px solid rgba(127,127,127,0.3);border-radius:8px;margin-bottom:16px;";
    const updateHead = doc.createElement("div");
    updateHead.style.cssText = "font-size:13px;font-weight:600;margin-bottom:8px;";
    updateHead.textContent = "更新";
    updateCard.appendChild(updateHead);

    const updateStatusEl = doc.createElement("div");
    updateStatusEl.style.cssText = "font-size:12px;opacity:0.75;margin-bottom:10px;line-height:1.5;";
    const currentVersion = LL.Updater?.readPluginVersion?.() || meta.version || "0.0.0";
    updateStatusEl.textContent = `当前 v${currentVersion}，点击下方按钮检查最新版`;
    updateCard.appendChild(updateStatusEl);

    const updateActions = doc.createElement("div");
    updateActions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    const checkButton = doc.createElement("button");
    checkButton.type = "button";
    checkButton.textContent = "检查更新";
    checkButton.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid rgba(127,127,127,0.4);background:transparent;color:inherit;cursor:pointer;font-size:13px;";
    checkButton.addEventListener("click", async () => {
      checkButton.disabled = true;
      updateStatusEl.textContent = "正在检查...";
      try {
        const result = await LL.Updater?.checkForUpdate?.(currentVersion);
        if (!result) {
          updateStatusEl.textContent = "Updater 未加载";
          return;
        }
        if (result.state === "update-available") {
          updateStatusEl.innerHTML = "";
          const t1 = doc.createElement("div");
          t1.textContent = `发现新版本 v${result.latest}（当前 v${result.current}）`;
          t1.style.cssText = "color:#f06a20;font-weight:600;margin-bottom:4px;";
          updateStatusEl.appendChild(t1);
          const t2 = doc.createElement("div");
          t2.textContent = "前往悬浮窗右上角齿轮 → 关于 标签查看 changelog 并安装";
          updateStatusEl.appendChild(t2);
        } else if (result.state === "current") {
          updateStatusEl.textContent = `已是最新版本 v${result.latest}`;
        } else if (result.state === "ahead") {
          updateStatusEl.textContent = `本地 v${result.current} 比线上 v${result.latest} 更新`;
        } else {
          updateStatusEl.textContent = `检查失败：${result.error || "未知错误"}`;
        }
      } catch (err) {
        updateStatusEl.textContent = `检查异常：${err?.message || err}`;
      } finally {
        checkButton.disabled = false;
      }
    });
    updateActions.appendChild(checkButton);

    const openSiteButton = doc.createElement("a");
    openSiteButton.href = "https://lyriclens.yoru-and-akari.dev";
    openSiteButton.target = "_blank";
    openSiteButton.rel = "noopener";
    openSiteButton.textContent = "访问插件主页";
    openSiteButton.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid rgba(127,127,127,0.4);background:transparent;color:inherit;cursor:pointer;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;";
    updateActions.appendChild(openSiteButton);
    updateCard.appendChild(updateActions);
    container.appendChild(updateCard);

    const pointer = doc.createElement("div");
    pointer.style.cssText = "padding:12px 14px;border:1px solid rgba(127,127,127,0.3);border-radius:8px;font-size:13px;line-height:1.6;opacity:0.85;";
    const pointerHead = doc.createElement("div");
    pointerHead.textContent = "想调整 API、外观、分析参数？";
    pointerHead.style.cssText = "margin-bottom:4px;";
    const pointerBody = doc.createElement("div");
    pointerBody.textContent = "点击网易云内 LyricLens 悬浮窗右上角的齿轮图标，在那里展开完整设置面板。";
    pointer.appendChild(pointerHead);
    pointer.appendChild(pointerBody);
    container.appendChild(pointer);

    return container;
  }

  function closeCurrentSong(songId) {
    suppressedSongId = songId || currentSongId;
    abortActiveRequest({ reason: "close-song" });
    Utils.log("当前歌曲浮层已关闭", suppressedSongId);
  }

  function restoreCurrentSong(songId) {
    const target = songId || currentSongId;
    if (!target) return;
    const wasSuppressed = suppressedSongId === target;
    if (wasSuppressed) suppressedSongId = null;
    Utils.log("当前歌曲浮层已恢复", { songId: target, wasSuppressed });
    if (wasSuppressed && currentSongId === target) {
      // X muted analysis; restore should re-trigger it.
      analyzeSong(target, { forceRefresh: false, trigger: "restore" });
    }
  }

  function abortActiveRequest(options = {}) {
    const { silentDiagnostics = false, reason = null } = options;
    const abortedKey = inFlightAnalyzeKey;
    if (activeController) {
      try {
        activeController.abort();
      } catch (_) {}
    }
    if (!silentDiagnostics && abortedKey) {
      diagnostics?.updateState?.({
        apiStatus: "aborted",
        inFlightAnalyzeKey: null,
        abortReason: reason || "new-request",
        abortedAnalyzeKey: abortedKey
      });
    } else if (silentDiagnostics) {
      diagnostics?.updateState?.({ inFlightAnalyzeKey: null });
    }
    activeController = null;
    inFlightAnalyzeKey = null;
    activeRequestId += 1;
  }

  // Reset analysis state without touching the capture buffer or currentSongId.
  // Used when handleCapturePayload detects a content-level song change
  // (NCM builds where PlayState/PlayProgress events don't fire never reach
  // handleSongChange; the only reliable signal is "the lyrics text changed").
  // Caller will continue with the new capture, so we deliberately do NOT
  // call Lyrics.clearCapturedLyrics() or restart the DOM observer.
  function softResetForNewLyrics({ reason } = {}) {
    const prevAnalysisLines = currentAnalysis?.lines;
    const analysisSig = buildLyricsTextSignature(prevAnalysisLines);
    const prevHash = Array.isArray(prevAnalysisLines) && prevAnalysisLines.length
      ? (Lyrics.lyricsHash?.(prevAnalysisLines) || null)
      : null;
    previousSongLyricsSignature = analysisSig || null;
    previousSongLyricsHash = prevHash || null;
    songChangeAt = Date.now();
    // Reset wall-clock anchor — the new song's playback time starts fresh.
    // NOTE: keep lastTrustedTimeMs intact (don't null it) so the next read
    // can distinguish "AMLL pushed a new value for the new song" (value
    // changed → real anchor) from "AMLL is still frozen on the previous
    // song's tail" (value unchanged → use songChangeAt-based extrapolation).
    playbackBaseMs = 0;
    playbackBaseWallClock = 0;
    currentAnalysis = null;
    lastLineIndex = null;
    currentAnalyzeKey = null;
    displayedAnalyzeKey = null;
    currentCardOrdinal = 0;
    lastSettledAnalyzeKey = null;
    lastSettledAnalyzeStatus = null;
    lastSettledAt = 0;
    lyricsFingerprintToCanonicalKey.clear();
    keyAliasMap.clear();
    canonicalToProvisionalKeys.clear();
    clearWatchdog();
    stopPlaybackSyncLoop();
    clearAutoFollowSuppressTimer();
    lastPromotedConsoleSongId = null;
    abortActiveRequest({ reason: reason || "soft-reset" });
    // Belt-and-suspenders: even though abortActiveRequest clears
    // inFlightAnalyzeKey, observed dumps show G1 ("same-inflight-canonical-key")
    // can still trip after a slider-duration soft-reset — a real race in some
    // path between the in-flight Promise chain and the canonical-key alias
    // rebind (main.js:1739) seems to leak the in-flight key. Clearing here
    // unconditionally guarantees the next analyzeSong won't be ghost-blocked.
    inFlightAnalyzeKey = null;
    if (panel?.setAutoFollow) panel.setAutoFollow(true);
    panel?.resetForAnalyze?.({
      analyzeKey: null,
      reason: reason || "soft-reset",
      message: "正在分析当前歌词..."
    });
    diagnostics?.updateState?.({
      lastSongChangeAt: Date.now(),
      lastPanelResetReason: reason || "soft-reset",
      cardCount: 0,
      currentCardIndex: null,
      displayedAnalyzeKey: null,
      displayedCardCount: 0,
      apiStatus: "idle",
      analyzeTriggerStatus: "pending",
      softResetCount: (diagnostics?.getState?.()?.softResetCount || 0) + 1,
      lastSoftResetReason: reason || "soft-reset",
      lastSoftResetAt: Date.now()
    });
  }

  function handleSongChange(songId) {
    if (!songId) return;
    if (settings.enabled === false) {
      // Keep currentSongId up to date so resumption analyzes the right
      // song, but skip all the reset/analyze plumbing.
      currentSongId = songId;
      return;
    }
    // Snapshot whether this call is a real song change BEFORE the reset
    // block clears currentAnalyzeKey — the diagnostics update at the end of
    // this function needs to know, and the old code read currentAnalyzeKey
    // after it had already been nulled so lastPanelResetReason was always null.
    const songChanged = currentSongId !== songId;
    if (songChanged) {
      // Snapshot the previous song's lyrics text signature AND a precise
      // FNV-1a hash over its preprocessed lines so we can reject stale
      // captures from amll-state / console (which lag NCM's songId flip).
      // We keep two fingerprints because formatting between capture paths
      // and analysis paths sometimes disagrees: signature is loose and
      // tolerates format drift, hash is exact and catches the rest.
      // Prefer the analyzed lines; fall back to the last captured lines
      // when the previous song never reached setAnalysis.
      const prevAnalysisLines = currentAnalysis?.lines;
      const analysisSig = buildLyricsTextSignature(prevAnalysisLines);
      let prevHash = Array.isArray(prevAnalysisLines) && prevAnalysisLines.length
        ? (Lyrics.lyricsHash?.(prevAnalysisLines) || null)
        : null;
      let captureSigFallback = null;
      if (!analysisSig || !prevHash) {
        try {
          const prevCaptured = Lyrics.getLastCapturedLyrics?.();
          if (Array.isArray(prevCaptured) && prevCaptured.length) {
            if (!analysisSig) captureSigFallback = buildLyricsTextSignature(prevCaptured);
            if (!prevHash) prevHash = buildPreprocessedLyricsHash(prevCaptured);
          }
        } catch (_) {}
      }
      previousSongLyricsSignature = analysisSig || captureSigFallback || null;
      previousSongLyricsHash = prevHash || null;
      songChangeAt = Date.now();
      console.log("[LyricLens:song-change]", { from: currentSongId, to: songId, hasPrevSig: Boolean(previousSongLyricsSignature) });
      suppressedSongId = null;
      currentAnalysis = null;
      lastLineIndex = null;
      currentAnalyzeKey = null;
      displayedAnalyzeKey = null;
      currentCardOrdinal = 0;
      lastSettledAnalyzeKey = null;
      lastSettledAnalyzeStatus = null;
      lastSettledAt = 0;
      // Reset wall-clock anchor on song change. Keep lastTrustedTimeMs
      // so the next read can detect whether AMLL pushed a new value for
      // the new song (real anchor) vs left it frozen (use songChangeAt).
      playbackBaseMs = 0;
      playbackBaseWallClock = 0;
      lyricsFingerprintToCanonicalKey.clear();
      Lyrics.clearCapturedLyrics?.();
      try {
        root.__LL_CONSOLE_SONG_ID_CANDIDATE = null;
        root.__LL_CONSOLE_SONG_ID_CANDIDATE_AT = 0;
      } catch (_) {}
      keyAliasMap.clear();
      canonicalToProvisionalKeys.clear();
      clearWatchdog();
      stopPlaybackSyncLoop();
      clearAutoFollowSuppressTimer();
      lastPromotedConsoleSongId = null;
      // Cleanup and restart DOM observer for new song
      if (domObserver?.cleanup) { domObserver.cleanup(); domObserver = null; }
      abortActiveRequest({ reason: "song-change" });
      // Same belt-and-suspenders as softResetForNewLyrics: guarantee no
      // ghost in-flight key survives into the new song's first analyze.
      inFlightAnalyzeKey = null;
      // Restart DOM observer without seeding from current DOM. Reasoning:
      // when NCM updates the lyrics DOM faster than the amll-state mutable
      // global (which happens on a re-play of a recently played song),
      // seeding with current DOM means the observer's baseline equals the
      // NEW song's lyrics and it never fires again. Letting the first
      // extract deliver unconditionally is safe — stale captures will be
      // filtered by the previousSongLyricsSignature reject in analyzeSong.
      try {
        domObserver = Capture.createDomLyricsObserver?.(root, (payload) => {
          if (payload && payload.lines && payload.lines.length) {
            handleCapturePayload(payload);
          }
        });
        if (domObserver?.start) domObserver.start();
      } catch (_) {}
      // Reset autoFollow to default true on song change
      if (panel?.setAutoFollow) panel.setAutoFollow(true);
      panel?.setSongId(songId);
      panel?.resetForAnalyze?.({ analyzeKey: null, reason: "song-change", message: "正在分析当前歌词..." });
    }
    currentSongId = songId;
    diagnostics?.updateState?.({
      songId,
      language: null,
      lyricsSource: "none",
      cardCount: 0,
      currentCardIndex: null,
      displayedAnalyzeKey: null,
      displayedCardCount: 0,
      lastSongChangeAt: Date.now(),
      lastPanelResetReason: songChanged ? "song-change" : null,
      apiStatus: "idle",
      lastError: null,
      analysisSkippedReason: null,
      analyzeTriggerBlockedReason: null,
      captureStatus: "waiting-for-lyrics",
      captureSource: null,
      activeCaptureSource: null,
      activeCaptureLineCount: 0,
      activeCaptureScore: 0,
      analyzeTriggerStatus: "blocked-no-lyrics",
      lastSettledAnalyzeKey: null,
      lastSettledAnalyzeStatus: null,
      lastSettledAt: 0,
      cacheHit: false,
      cacheKey: null,
      cacheUseStatus: "not-checked",
      autoFollowSuppressedUntil: null,
      lastManualNavigationAt: null,
      autoFollowRestoreReason: "song-change"
    });
    analyzeSong(songId, { forceRefresh: false, trigger: "playstate" });
  }

  async function retryCurrentSong(songId) {
    const targetSongId = songId || currentSongId || Sync.getCurrentSongId();
    suppressedSongId = null;
    lastSettledAnalyzeKey = null;
    lastSettledAnalyzeStatus = null;
    lastSettledAt = 0;
    lyricsFingerprintToCanonicalKey.clear();
    keyAliasMap.clear();
    canonicalToProvisionalKeys.clear();
    if (targetSongId) panel?.setSongId(targetSongId);
    diagnostics?.updateState?.({
      forceRefreshReason: "manual-retry",
      lastRetryAt: Date.now()
    });
    const captured = Lyrics.getLastCapturedLyrics?.();
    if (!targetSongId && (!captured || !captured.length)) return;
    await analyzeSong(targetSongId || null, {
      forceRefresh: true,
      capturePayload: captured && captured.length ? captured : null,
      captureSource: captured && captured.length ? "manual-retry" : null,
      captureFingerprint: captured && captured.length ? Lyrics.fingerprintCapturedLyrics?.(captured) : null,
      trigger: "manual-retry"
    });
  }

  async function analyzeSong(songId, options = {}) {
    const {
      forceRefresh = false,
      capturePayload = null,
      captureSource = null,
      captureFingerprint = null,
      trigger = "playstate"
    } = options;
    const isFallback = String(trigger).endsWith("+fallback");
    const cardGenerationMode = settings.cardGenerationMode === "selected" ? "selected" : "per-line";
    const maxLines = isFallback && cardGenerationMode !== "per-line"
      ? settings.fallbackMaxLines
      : settings.maxAnalysisLines;
    const batchSize = PER_LINE_BATCH_SIZE;
    const maxTokens = isFallback ? settings.fallbackMaxTokens : settings.analyzeMaxTokens;
    const timeoutMs = isFallback ? settings.fallbackTimeoutMs : settings.analyzeTimeoutMs;
    const temperature = settings.analyzeTemperature;

    // ── Phase 0: prechecks + cacheKey (no abort yet) ──

    if (songId && suppressedSongId === songId) {
      panel?.hide();
      diagnostics?.updateState?.({ analysisSkippedReason: "suppressed", analyzeTriggerBlockedReason: "suppressed" });
      return;
    }

    if (!settings.autoAnalyze) {
      Utils.log("自动拆解已关闭，跳过", songId);
      diagnostics?.updateState?.({ apiStatus: "auto-disabled", analysisSkippedReason: "auto-analyze-off", analyzeTriggerBlockedReason: "auto-analyze-off" });
      panel?.hide();
      return;
    }

    let lyricResult = null;
    if (capturePayload && Array.isArray(capturePayload) && capturePayload.length) {
      const normalized = Lyrics.normalizeLyricPayload(capturePayload);
      if (normalized.length) {
        lyricResult = {
          source: captureSource || "runtime-capture",
          lines: normalized,
          payload: capturePayload
        };
      }
    }
    if (!lyricResult) {
      const captureResult = await Capture.waitForCapture?.(root, {
        songId: songId || null,
        maxWaitMs: 12000,
        pollMs: 400,
        signal: activeController?.signal,
        // Reject captures that still hold the previous song's lyrics. Keeps
        // waitForCapture polling until amll-state / console source catches up
        // to the new song, instead of returning the stale result on the first
        // poll. Uses both loose signature (catches format drift between
        // capture and analysis paths) and precise hash (catches anything
        // signature missed). Window matches PREVIOUS_SONG_LYRICS_REJECT_MS.
        isStaleLines: (lines) => {
          if (!previousSongLyricsSignature && !previousSongLyricsHash) return false;
          if (Date.now() - songChangeAt >= PREVIOUS_SONG_LYRICS_REJECT_MS) return false;
          if (!Array.isArray(lines) || !lines.length) return false;
          const candidate = lines.map((l) => ({
            text: l.original ?? l.text,
            startTime: l.startMs,
            endTime: l.endMs
          }));
          const candidateSig = buildLyricsTextSignature(candidate);
          if (candidateSig && candidateSig === previousSongLyricsSignature) return true;
          const candidateHash = buildPreprocessedLyricsHash(candidate);
          if (candidateHash && candidateHash === previousSongLyricsHash) return true;
          return false;
        }
      });
      if (captureResult) {
        if (captureResult.source === "cache") {
          recordCacheFallbackNotUsed(captureResult);
        } else {
          // Build lyricResult from unified capture payload
          const captureLines = captureResult.lines || [];
          if (captureLines.length) {
            const rawPayload = captureLines.map((l) => ({
              index: l.lineIndex,
              text: l.original,
              startTime: l.startMs,
              endTime: l.endMs,
              referenceTranslation: l.translation || undefined,
              romanLyric: l.romanLyric || undefined
            }));
            const normalized = Lyrics.normalizeLyricPayload(rawPayload);
            if (normalized.length) {
              lyricResult = {
                source: captureResult.source || "capture-pipeline",
                lines: normalized,
                payload: rawPayload
              };
              diagnostics?.updateState?.({
                captureStatus: "captured-valid-lines",
                captureSource: captureResult.source || null
              });
            }
          }
        }
      }
      // ── Last-resort: query NCM's own lyric API ──
      // Triggered when every in-process capture source comes up empty AND
      // we have a real numeric songId. This rescues the scenario Yoru hit
      // with "One Last Kiss": AMLL's TTML pipeline relies on a third-party
      // GitHub mirror (mirror.ghproxy.com) which went dark, so AMLL's React
      // state stayed empty, console-fallback had nothing to scrape, and the
      // DOM observer found a wrapper with no lines. Going to NCM's own
      // backend directly bypasses the broken external dependency entirely —
      // we're inside the NCM renderer, so the request carries NCM's session
      // cookie and is rate-limited the same way as any other in-app call.
      if (!lyricResult) {
        const ncmSongId = Sync.normalizeSongId?.(songId);
        if (ncmSongId && NcmLyricApi?.fetchLyricsForSongId) {
          diagnostics?.updateState?.({
            ncmLyricApiAttemptedAt: Date.now(),
            ncmLyricApiSongId: ncmSongId
          });
          try {
            const apiResult = await NcmLyricApi.fetchLyricsForSongId(ncmSongId, {
              signal: activeController?.signal
            });
            if (apiResult?.lrc) {
              const parsedLines = Lyrics.normalizeLyricPayload?.(apiResult.lrc) || [];
              if (parsedLines.length) {
                Utils.log("NCM 歌词 API 命中", { songId: ncmSongId, lines: parsedLines.length });
                lyricResult = {
                  source: "ncm-lyric-api",
                  lines: parsedLines,
                  // payload doubles as the source for fingerprinting / cache key
                  // downstream — same shape as a capture-pipeline payload so the
                  // existing fingerprint code works unchanged.
                  payload: parsedLines
                };
                diagnostics?.updateState?.({
                  captureStatus: "captured-valid-lines",
                  captureSource: "ncm-lyric-api",
                  lastCaptureSource: "ncm-lyric-api",
                  lastCapturedAt: Date.now(),
                  ncmLyricApiOutcome: "success",
                  ncmLyricApiLineCount: parsedLines.length
                });
              } else {
                diagnostics?.updateState?.({ ncmLyricApiOutcome: "parsed-empty" });
              }
            } else {
              diagnostics?.updateState?.({ ncmLyricApiOutcome: "no-lyrics" });
            }
          } catch (err) {
            Utils.warn("NCM 歌词 API 调用失败", err);
            diagnostics?.updateState?.({
              ncmLyricApiOutcome: "error",
              ncmLyricApiError: String(err?.message || err).slice(0, 120)
            });
          }
        } else if (!ncmSongId) {
          diagnostics?.updateState?.({ ncmLyricApiOutcome: "no-song-id" });
        }
      }
      if (!lyricResult) {
        // Final attempt: check cache for any cards matching current songId
        const cacheFallback = Capture.readCacheFallback?.(root, {
          songId: songId || null,
          lyricsFingerprint: null,
          lyricsHash: null
        });
        if (cacheFallback) {
          recordCacheFallbackNotUsed(cacheFallback);
        }
        const afterCacheState = diagnostics?.getState?.() || {};
        const blockedReason = afterCacheState.cacheHit && afterCacheState.cacheUseStatus === "diagnostic-only"
          ? "cache-hit-not-used"
          : "no-capture-source";
        diagnostics?.updateState?.({
          captureStatus: "capture-failed",
          captureSource: null,
          analyzeTriggerStatus: "blocked-no-lyrics",
          analyzeTriggerBlockedReason: blockedReason
        });
        Utils.log("歌词获取失败，静默降级", songId);
        diagnostics?.updateState?.({
          lyricsSource: "none",
          apiStatus: blockedReason === "cache-hit-not-used" ? "cache-hit-not-used" : "lyrics-unavailable",
          panelStatus: blockedReason === "cache-hit-not-used" ? "blocked-no-lyrics" : null
        });
        panel?.hide();
        return;
      }
    }
    // Mark capture success
    if (!(capturePayload && lyricResult)) {
      diagnostics?.updateState?.({
        captureStatus: "captured-valid-lines",
        analyzeTriggerStatus: "running"
      });
    }

    const preprocessReport = Lyrics.preprocessLyricLinesWithReport
      ? Lyrics.preprocessLyricLinesWithReport(lyricResult.lines, maxLines)
      : {
          lines: Lyrics.preprocessLyricLines(lyricResult.lines, maxLines),
          rawCount: Array.isArray(lyricResult.lines) ? lyricResult.lines.length : 0,
          sentCount: 0,
          droppedCount: 0
        };
    // `lines` and `language` are `let` (not `const`) so the stale-capture
    // rescue below can swap in the NCM API's authoritative copy without
    // recomputing the whole analyze pipeline.
    let lines = preprocessReport.lines;
    diagnostics?.updateState?.({
      rawLyricLineCount: preprocessReport.rawCount,
      sentLyricLineCount: preprocessReport.sentCount,
      droppedLyricLineCount: preprocessReport.droppedCount
    });
    if (!lines.length) {
      Utils.log("歌词为空或无有效原文行，静默跳过", lyricResult.source);
      diagnostics?.updateState?.({
        lyricsSource: lyricResult.source,
        apiStatus: "no-valid-lyrics",
        analysisSkippedReason: "no-valid-lines",
        analyzeTriggerBlockedReason: "no-valid-lines"
      });
      panel?.hide();
      return;
    }

    let language = Detect.detectLanguage(lines.map((line) => line.text));
    Utils.log("歌词来源", lyricResult.source);
    Utils.log("语言检测结果", language);
    diagnostics?.updateState?.({ language, lyricsSource: lyricResult.source });

    // ── Stale-capture rescue via NCM API ──
    // language="other" with a real numeric songId is suspicious: AMLL's
    // React state can hold the previous song's lyrics when NCM's
    // PlayState/PlayProgress events are dead, so the capture pipeline
    // happily pulls Chinese lyrics while NCM actually plays Japanese.
    // Ask NCM's own backend; if THAT returns en/ja content, trust it
    // and replace lyricResult/lines/language wholesale.
    //
    // Skipped when:
    //   - the capture source already IS the NCM API (would re-fetch the
    //     same thing and likely get the same result)
    //   - no normalizable songId is available
    if (language === "other"
        && lyricResult.source !== "ncm-lyric-api"
        && !String(lyricResult.source || "").endsWith("other-lang-rescue")) {
      const ncmSongId = Sync.normalizeSongId?.(songId);
      if (ncmSongId && NcmLyricApi?.fetchLyricsForSongId) {
        diagnostics?.updateState?.({
          otherLangRescueAttemptedAt: Date.now(),
          otherLangRescueSongId: ncmSongId,
          otherLangRescueCaptureSource: lyricResult.source
        });
        try {
          const apiResult = await NcmLyricApi.fetchLyricsForSongId(ncmSongId, {
            signal: activeController?.signal
          });
          if (apiResult?.lrc) {
            const apiNormalized = Lyrics.normalizeLyricPayload?.(apiResult.lrc) || [];
            const apiReport = Lyrics.preprocessLyricLinesWithReport
              ? Lyrics.preprocessLyricLinesWithReport(apiNormalized, maxLines)
              : {
                  lines: Lyrics.preprocessLyricLines(apiNormalized, maxLines),
                  rawCount: apiNormalized.length,
                  sentCount: 0,
                  droppedCount: 0
                };
            const apiLines = apiReport.lines || [];
            if (apiLines.length) {
              const apiLanguage = Detect.detectLanguage(apiLines.map((l) => l.text));
              if (apiLanguage !== "other") {
                Utils.log("AMLL state 内容与 songId 不一致，切到 NCM API 歌词", {
                  fromSource: lyricResult.source,
                  fromLang: language,
                  toLang: apiLanguage,
                  apiLineCount: apiLines.length
                });
                lyricResult = {
                  source: "ncm-lyric-api+other-lang-rescue",
                  lines: apiNormalized,
                  payload: apiNormalized
                };
                lines = apiLines;
                language = apiLanguage;
                diagnostics?.updateState?.({
                  language,
                  lyricsSource: lyricResult.source,
                  captureStatus: "captured-valid-lines",
                  captureSource: lyricResult.source,
                  lastCaptureSource: lyricResult.source,
                  lastCapturedAt: Date.now(),
                  otherLangRescueOutcome: "rescued",
                  otherLangRescueLineCount: apiLines.length,
                  otherLangRescueLanguage: apiLanguage,
                  rawLyricLineCount: apiReport.rawCount,
                  sentLyricLineCount: apiReport.sentCount,
                  droppedLyricLineCount: apiReport.droppedCount
                });
              } else {
                diagnostics?.updateState?.({
                  otherLangRescueOutcome: "still-other",
                  otherLangRescueLanguage: apiLanguage
                });
              }
            } else {
              diagnostics?.updateState?.({ otherLangRescueOutcome: "empty-after-preprocess" });
            }
          } else {
            diagnostics?.updateState?.({ otherLangRescueOutcome: "no-lyrics" });
          }
        } catch (err) {
          Utils.warn("NCM 歌词 API 二次验证失败", err);
          diagnostics?.updateState?.({
            otherLangRescueOutcome: "error",
            otherLangRescueError: String(err?.message || err).slice(0, 120)
          });
        }
      } else if (!ncmSongId) {
        diagnostics?.updateState?.({ otherLangRescueOutcome: "no-song-id" });
      }
    }

    if (language === "other") {
      diagnostics?.updateState?.({ apiStatus: "skipped-other-language", analysisSkippedReason: "language-other", analyzeTriggerBlockedReason: "language-other" });
      panel?.hide();
      return;
    }

    if (!Settings.isApiConfigured(settings)) {
      diagnostics?.updateState?.({ apiStatus: "not-configured", analysisSkippedReason: "api-not-configured", analyzeTriggerBlockedReason: "api-not-configured" });
      panel?.showConfig(settings);
      return;
    }

    const lyricsHash = Lyrics.lyricsHash(lines);
    const currentLyricsSignature = buildLyricsTextSignature(lines);
    if (!forceRefresh
        && (previousSongLyricsSignature || previousSongLyricsHash)
        && Date.now() - songChangeAt < PREVIOUS_SONG_LYRICS_REJECT_MS) {
      const sigMatch = Boolean(currentLyricsSignature) && currentLyricsSignature === previousSongLyricsSignature;
      const hashMatch = Boolean(lyricsHash) && lyricsHash === previousSongLyricsHash;
      if (sigMatch || hashMatch) {
        console.log("[LyricLens:stale-reject]", {
          source: lyricResult.source,
          songId,
          by: sigMatch && hashMatch ? "sig+hash" : (sigMatch ? "sig" : "hash"),
          sigPreview: currentLyricsSignature ? currentLyricsSignature.slice(0, 80) : null
        });
        diagnostics?.updateState?.({
          analysisSkippedReason: "previous-song-lyrics-stale",
          analyzeTriggerBlockedReason: "previous-song-lyrics-stale",
          analyzeTriggerStatus: "blocked-stale-lyrics",
          staleLyricsRejectedAt: Date.now(),
          staleLyricsRejectedSource: lyricResult.source,
          staleLyricsRejectedBy: sigMatch && hashMatch ? "sig+hash" : (sigMatch ? "sig" : "hash"),
          staleLyricsPrevSigSample: previousSongLyricsSignature ? previousSongLyricsSignature.slice(0, 100) : null,
          staleLyricsCandidateSigSample: currentLyricsSignature ? currentLyricsSignature.slice(0, 100) : null,
          staleLyricsPrevHash: previousSongLyricsHash || null,
          staleLyricsCandidateHash: lyricsHash || null
        });
        return;
      }
    }
    const fingerprint = captureFingerprint || (capturePayload ? Lyrics.fingerprintCapturedLyrics?.(capturePayload) : null);
    // Belt-and-suspenders: normalize songId to pure digits (strips track-/song- prefix)
    const safeSongId = Sync.normalizeSongId?.(songId) || songId || null;
    const cacheKeySongId = safeSongId
      ? safeSongId
      : (fingerprint ? `captured:${fingerprint}` : `lyrics:${lyricsHash}`);
    const rawKey = Cache.buildCacheKey({
      songId: cacheKeySongId,
      lyricsHash,
      apiEndpoint: settings.apiEndpoint,
      modelName: settings.modelName,
      promptVersion: Api.PROMPT_VERSION
    });

    diagnostics?.updateState?.({
      lastAnalyzeTrigger: trigger,
      lastAnalyzeKey: rawKey,
      rawAnalyzeKey: rawKey,
      analysisSkippedReason: null,
      analyzeTriggerBlockedReason: null,
      promotionReason: safeSongId ? "song-id-key-selected" : "song-id-unavailable",
      cacheHit: false,
      cacheKey: null,
      cacheUseStatus: "not-checked",
      ...(isFallback ? {} : { fallbackReason: null, fallbackOutcome: null })
    });

    const canonicalKey = fingerprint
      ? resolveCanonicalAnalyzeKey(rawKey, fingerprint, songId)
      : rawKey;

    diagnostics?.updateState?.({
      canonicalAnalyzeKey: canonicalKey,
      currentAnalyzeKey: canonicalKey,
      cardGenerationMode,
      expectedCardCount: cardGenerationMode === "per-line" ? lines.length : null
    });

    // ── Phase 1: dedup gating ──

    // G1: same in-flight canonical key → skip, don't abort
    if (!forceRefresh && inFlightAnalyzeKey === canonicalKey) {
      Utils.log("已有相同分析在执行中，跳过", canonicalKey);
      recordDuplicateAnalyzeSkip("same-inflight-canonical-key", canonicalKey);
      return;
    }

    // G2: same failed settled canonical key → skip, don't reset loading
    if (!forceRefresh && lastSettledAnalyzeKey === canonicalKey && FAILED_SETTLED_STATUSES.has(lastSettledAnalyzeStatus)) {
      Utils.log("相同分析键已处于失败终端状态，跳过", canonicalKey, lastSettledAnalyzeStatus);
      recordDuplicateAnalyzeSkip("same-settled-canonical-key", canonicalKey);
      return;
    }

    // G3: settled success + canonical cache/cards → serve directly
    if (!forceRefresh && lastSettledAnalyzeKey === canonicalKey && lastSettledAnalyzeStatus === "success") {
      const currentAnalysisKey = resolveAliasKey(currentAnalysis?.analyzeKey);
      const hasCurrentCards =
        currentAnalysis?.cards?.length &&
        (currentAnalysisKey === canonicalKey || displayedAnalyzeKey === canonicalKey);
      if (hasCurrentCards) {
        Utils.log("settled success 卡片仍在内存，跳过", canonicalKey);
        lastAnalyzedKey = canonicalKey;
        currentAnalysis.analyzeKey = canonicalKey;
        displayedAnalyzeKey = canonicalKey;
        currentAnalyzeKey = canonicalKey;
        recordDuplicateAnalyzeSkip("same-settled-success-present", canonicalKey, {
          canonicalAnalyzeKey: canonicalKey,
          currentAnalyzeKey: canonicalKey,
          displayedAnalyzeKey: canonicalKey,
          cardCount: currentAnalysis.cards.length,
          displayedCardCount: currentAnalysis.cards.length,
          panelStatus: diagnostics?.getState?.()?.panelStatus || "success",
          cacheHit: Cache.defaultCache.has(canonicalKey),
          cacheKey: Cache.defaultCache.has(canonicalKey) ? canonicalKey : null,
          cacheUseStatus: Cache.defaultCache.has(canonicalKey) ? "hit-not-used-current-success" : "not-checked"
        });
        return;
      }
      if (Cache.defaultCache.has(canonicalKey)) {
        Utils.log("settled success 缓存命中但不自动显示", canonicalKey);
        recordDuplicateAnalyzeSkip("same-settled-success-cache-not-used", canonicalKey, {
          cacheHit: true,
          cacheKey: canonicalKey,
          cacheUseStatus: "diagnostic-only"
        });
        return;
      }
      Utils.log("settled success 但无可用卡片，允许重新分析", canonicalKey);
    }

    // G4: forceRefresh clears settled state for this canonical key
    if (forceRefresh && lastSettledAnalyzeKey === canonicalKey) {
      Utils.log("forceRefresh 清除当前 canonical key 的 settled 状态", canonicalKey);
      lastSettledAnalyzeKey = null;
      lastSettledAnalyzeStatus = null;
      lastSettledAt = 0;
    }

    // G5: cache hit for non-settled case → serve cards from cache, skip API.
    // Without this, every song-switch re-runs the API even when we already
    // analyzed these exact lyrics this session — or in a prior session,
    // since the cache is persisted to localStorage.
    if (!forceRefresh && Cache.defaultCache.has(canonicalKey)) {
      const cached = Cache.defaultCache.get(canonicalKey);
      if (Array.isArray(cached) && cached.length > 0) {
        const sortedCards = sortCards(cached, lines);
        const coverage = validateCardCoverage(sortedCards, lines, cardGenerationMode);
        const status = coverage.partialCardGeneration ? "success-with-missing" : "success";
        Utils.log("内存缓存命中，直接使用", canonicalKey, { cards: sortedCards.length });
        // Make sure any prior in-flight (from the song we just switched off)
        // is aborted so its delayed completion can't overwrite us.
        abortActiveRequest({ reason: "served-from-cache", silentDiagnostics: true });
        clearWatchdog();
        inFlightAnalyzeKey = null;
        lastAnalyzedKey = canonicalKey;
        currentAnalyzeKey = canonicalKey;
        settleAnalyzeKey(canonicalKey, "success");
        diagnostics?.updateState?.({
          apiStatus: status,
          analyzeTriggerStatus: "success",
          cardCount: sortedCards.length,
          cacheHit: true,
          cacheKey: canonicalKey,
          cacheUseStatus: "served-from-cache",
          inFlightAnalyzeKey: null,
          lastError: null,
          panelStatus: status,
          expectedCardCount: coverage.expectedCardCount,
          actualCardCount: coverage.actualCardCount,
          missingCardLineIndexes: coverage.missingCardLineIndexes,
          partialCardGeneration: coverage.partialCardGeneration,
          analyzeMergedCardCount: sortedCards.length,
          canonicalAnalyzeKey: canonicalKey,
          currentAnalyzeKey: canonicalKey,
          panelLastRenderReason: "cache-hit",
          panelLastRenderedAt: Date.now()
        });
        setAnalysis({ songId: cacheKeySongId, lyricsHash, language, lines, cards: sortedCards, analyzeKey: canonicalKey });
        lastLyricsHash = lyricsHash;
        return;
      }
      Utils.log("内存缓存命中但值无效，重新请求", canonicalKey);
      Cache.defaultCache.delete(canonicalKey);
      diagnostics?.updateState?.({
        cacheHit: true,
        cacheKey: canonicalKey,
        cacheUseStatus: "hit-empty-value-refetch"
      });
    }

    // ── Phase 2: confirmed new canonical request → abort old ──

    const requestId = activeRequestId + 1;
    activeRequestId = requestId;
    abortActiveRequest({ reason: "new-analyze-key" });
    activeRequestId = requestId;
    activeController = new AbortController();

    // ── Phase 3: clear old key's display ──

    if (currentAnalyzeKey !== canonicalKey) {
      currentAnalyzeKey = canonicalKey;
      clearDisplayedCards(canonicalKey, "analyze-key-changed");
    } else if (!displayedAnalyzeKey || displayedAnalyzeKey !== canonicalKey) {
      diagnostics?.updateState?.({ currentAnalyzeKey: canonicalKey });
    }

    // ── Phase 4: start request ──

    inFlightAnalyzeKey = canonicalKey;
    diagnostics?.updateState?.({
      inFlightAnalyzeKey: canonicalKey,
      apiStatus: "requesting",
      analyzeTriggerStatus: "running",
      lastError: null,
      panelStatus: "loading",
      panelTextSample: isFallback ? "完整分析超时，正在尝试小样本分析..." : "正在拆解歌词...",
      panelLoadingStartedAt: Date.now(),
      actualCardCount: null,
      missingCardLineIndexes: [],
      analyzeBatchCount: null,
      analyzeMergedCardCount: null,
      partialCardGeneration: false
    });
    panel?.showLoading(isFallback ? "完整分析超时，正在尝试小样本分析..." : "正在拆解歌词...");
    startWatchdog(canonicalKey, {
      batchCount: countAnalysisBatches(lines, batchSize, cardGenerationMode),
      concurrency: countAnalysisConcurrency(lines, batchSize, cardGenerationMode),
      requestTimeoutMs: timeoutMs
    });
    Utils.log("API 请求开始", { endpoint: settings.apiEndpoint, model: settings.modelName, songId: cacheKeySongId, trigger, canonicalKey });

    const initialCurrentMs = playbackHasRealTime && Number.isFinite(lastProgressMs)
      ? lastProgressMs
      : (readTrustedPlaybackSnapshot()?.timeMs ?? null);
    const playbackState = { currentMs: initialCurrentMs };
    analysisPlaybackState = playbackState;
    try {
      const analysisReport = await requestCardsForLines({
        lines,
        language,
        timeoutMs,
        maxTokens,
        temperature,
        batchSize,
        isFallback,
        cardGenerationMode,
        signal: activeController.signal,
        currentMs: initialCurrentMs,
        playbackState,
        onPartialBatch: ({ cards: partialCards, batchIndex, totalBatches, batchOriginalIndex }) => {
          if (!isActive(requestId, songId)) return;
          if (inFlightAnalyzeKey !== canonicalKey) return;
          if (!Array.isArray(partialCards) || !partialCards.length) return;
          const sortedPartial = sortCards(partialCards, lines);
          const finalCanonicalKeyForPartial = resolveAliasKey(canonicalKey);
          diagnostics?.updateState?.({
            partialBatchIndex: batchIndex,
            partialBatchOriginalIndex: batchOriginalIndex,
            partialTotalBatches: totalBatches,
            partialCardsRenderedAt: Date.now(),
            partialCardCount: sortedPartial.length,
            panelStatus: "streaming",
            panelLastRenderReason: "partial-batch",
            panelTextSample: `已生成 ${sortedPartial.length} / ${lines.length} 张卡片`
          });
          setAnalysis({
            songId: cacheKeySongId,
            lyricsHash,
            language,
            lines,
            cards: sortedPartial,
            analyzeKey: finalCanonicalKeyForPartial,
            partial: true
          });
        }
      });
      if (!isActive(requestId, songId)) {
        inFlightAnalyzeKey = null;
        diagnostics?.updateState?.({ inFlightAnalyzeKey: null });
        return;
      }
      const report = analysisReport.report;
      const cards = sortCards(analysisReport.cards, lines);
      const coverage = validateCardCoverage(cards, lines, cardGenerationMode);
      const finalCanonicalKey = resolveAliasKey(canonicalKey);
      if (finalCanonicalKey !== canonicalKey) {
        diagnostics?.updateState?.({
          canonicalAnalyzeKey: finalCanonicalKey,
          currentAnalyzeKey: finalCanonicalKey,
          analyzeKeyAliasFrom: canonicalKey,
          analyzeKeyAliasTo: finalCanonicalKey
        });
      }
      Cache.defaultCache.set(finalCanonicalKey, cards);
      lastAnalyzedKey = finalCanonicalKey;
      inFlightAnalyzeKey = null;
      Utils.log("API 请求成功", { cards: cards.length, parsed: report.parsedCount, canonicalKey: finalCanonicalKey });
      clearWatchdog();
      if (cards.length > 0) {
        const status = coverage.partialCardGeneration ? "success-with-missing" : "success";
        settleAnalyzeKey(finalCanonicalKey, "success");
        diagnostics?.updateState?.({
          apiStatus: status,
          analyzeTriggerStatus: "success",
          cardCount: cards.length,
          lastParsedCardsCount: report.parsedCount,
          lastNormalizedCardsCount: report.normalizedCount,
          cardDropReasons: report.dropReasons,
          inFlightAnalyzeKey: null,
          fallbackOutcome: isFallback ? "success" : null,
          lastError: null,
          panelStatus: status,
          expectedCardCount: coverage.expectedCardCount,
          actualCardCount: coverage.actualCardCount,
          missingCardLineIndexes: coverage.missingCardLineIndexes,
          partialCardGeneration: coverage.partialCardGeneration,
          analyzeMergedCardCount: cards.length,
          canonicalAnalyzeKey: finalCanonicalKey,
          currentAnalyzeKey: finalCanonicalKey
        });
        setAnalysis({ songId: cacheKeySongId, lyricsHash, language, lines, cards, analyzeKey: finalCanonicalKey });
      } else {
        settleAnalyzeKey(finalCanonicalKey, "no-cards");
        diagnostics?.updateState?.({
          apiStatus: "no-cards",
          cardCount: 0,
          lastParsedCardsCount: report.parsedCount,
          lastNormalizedCardsCount: report.normalizedCount,
          cardDropReasons: report.dropReasons,
          inFlightAnalyzeKey: null,
          fallbackOutcome: isFallback ? "success" : null,
          lastError: "normalize 后无可用卡片",
          panelStatus: "no-cards",
          panelTextSample: "没有生成可用卡片",
          expectedCardCount: coverage.expectedCardCount,
          actualCardCount: coverage.actualCardCount,
          missingCardLineIndexes: coverage.missingCardLineIndexes,
          partialCardGeneration: coverage.partialCardGeneration,
          analyzeMergedCardCount: cards.length,
          canonicalAnalyzeKey: finalCanonicalKey,
          currentAnalyzeKey: finalCanonicalKey
        });
        clearDisplayedCards(finalCanonicalKey, "no-cards", "没有生成可用卡片");
        panel?.showError?.("没有生成可用卡片");
      }
      lastLyricsHash = lyricsHash;
    } catch (err) {
      inFlightAnalyzeKey = null;
      clearWatchdog();
      if (!isActive(requestId, songId)) {
        diagnostics?.updateState?.({ inFlightAnalyzeKey: null });
        return;
      }
      if (err?.name === "AbortError") {
        Utils.log("API 请求已取消", songId);
        diagnostics?.updateState?.({ apiStatus: "aborted", inFlightAnalyzeKey: null });
        return;
      }
      const finalCanonicalKey = resolveAliasKey(canonicalKey);
      if (err?.name === "TimeoutError") {
        Utils.warn("API 请求超时", err);
        settleAnalyzeKey(finalCanonicalKey, "timeout");
        clearDisplayedCards(finalCanonicalKey, "timeout", "当前歌词分析超时");
        diagnostics?.updateState?.({
          apiStatus: "timeout",
          lastError: "请求超时",
          inFlightAnalyzeKey: null,
          fallbackOutcome: isFallback ? "timeout" : null,
          panelStatus: "timeout",
          panelTextSample: "当前歌词分析超时，可稍后重试",
          panelLastRenderReason: isFallback ? "fallback-timeout" : "timeout"
        });
        if (settings.fallbackOnTimeout === true && !isFallback) {
          diagnostics?.updateState?.({
            apiStatus: "retrying-small-sample",
            fallbackReason: "primary-timeout",
            fallbackOutcome: null
          });
          await analyzeSong(songId, {
            forceRefresh: true,
            capturePayload: capturePayload || lyricResult.payload,
            captureSource: captureSource || lyricResult.source,
            captureFingerprint,
            trigger: `${trigger}+fallback`
          });
          return;
        }
        panel?.showError("请求超时，点击重试");
        return;
      }
      if (err?.name === "NetworkError") {
        Utils.warn("API 网络错误", err.message);
        settleAnalyzeKey(finalCanonicalKey, "error");
        clearDisplayedCards(finalCanonicalKey, "error", "网络连接失败，请检查网络后重试");
        diagnostics?.updateState?.({
          apiStatus: "network-error",
          lastError: err.originalMessage || err.message || "网络错误",
          inFlightAnalyzeKey: null,
          fallbackOutcome: isFallback ? "failed" : null,
          panelStatus: "error",
          panelTextSample: "网络连接失败，请检查网络后重试"
        });
        panel?.showError("网络连接失败，请检查网络后重试");
        return;
      }
      if (err?.name === "ApiError") {
        const status = err.status;
        if (status === 429) {
          settleAnalyzeKey(finalCanonicalKey, "rate-limited");
          clearDisplayedCards(finalCanonicalKey, "rate-limited", "请求限流或额度不足");
          diagnostics?.updateState?.({
            apiStatus: "rate-limited",
            lastError: "请求限流或额度不足",
            inFlightAnalyzeKey: null,
            panelStatus: "rate-limited",
            panelTextSample: "请求限流或额度不足"
          });
          panel?.showError("请求限流或额度不足");
          return;
        }
        if (status === 400 || status === 404) {
          settleAnalyzeKey(finalCanonicalKey, "error");
          clearDisplayedCards(finalCanonicalKey, "error", "模型或请求参数不可用");
          diagnostics?.updateState?.({
            apiStatus: "error",
            lastError: "模型或请求参数不可用",
            inFlightAnalyzeKey: null,
            panelStatus: "error",
            panelTextSample: "模型或请求参数不可用"
          });
          panel?.showError("模型或请求参数不可用");
          return;
        }
        if (status === 401 || status === 403) {
          settleAnalyzeKey(finalCanonicalKey, "error");
          clearDisplayedCards(finalCanonicalKey, "error", "密钥或权限问题");
          diagnostics?.updateState?.({
            apiStatus: "error",
            lastError: "密钥或权限问题",
            inFlightAnalyzeKey: null,
            panelStatus: "error",
            panelTextSample: "密钥或权限问题"
          });
          panel?.showError("密钥或权限问题");
          return;
        }
      }
      if (err?.name === "ApiParseError") {
        Utils.warn("API 返回内容解析失败", err);
        settleAnalyzeKey(finalCanonicalKey, "parse-error");
        const isTruncated = err.finishReasonWasLength || err.stage === "truncated-content";
        const errorTextSample = isTruncated
          ? "模型输出太长被截断，点击重试"
          : "API 返回格式无法解析";
        clearDisplayedCards(finalCanonicalKey, "parse-error", errorTextSample);
        diagnostics?.updateState?.({
          apiStatus: "parse-error",
          lastError: `parse-error[${err.stage || "parse"}]: ${err.message || ""}`,
          lastParsedContentSample: err.contentSample || null,
          lastResponseTextSample: err.responseTextSample || null,
          fallbackOutcome: isFallback ? "failed" : null,
          inFlightAnalyzeKey: null,
          panelStatus: "parse-error",
          panelTextSample: errorTextSample,
          parseFailureReason: isTruncated ? "finish_reason_length" : (err.stage || "content-json"),
          finishReasonWasLength: Boolean(err.finishReasonWasLength),
          extractedJsonStrategy: err.extractedJsonStrategy || null,
          rawContentLength: err.rawContentLength || null
        });
        panel?.showError("解析失败，点击重试");
        return;
      }
      Utils.warn("API 请求失败", err);
      settleAnalyzeKey(finalCanonicalKey, "error");
      clearDisplayedCards(finalCanonicalKey, "error", "拆解失败，点击重试");
      diagnostics?.updateState?.({
        apiStatus: "error",
        lastError: err.message || String(err),
        fallbackOutcome: isFallback ? "failed" : null,
        inFlightAnalyzeKey: null,
        panelStatus: "error",
        panelTextSample: "拆解失败，点击重试"
      });
      panel?.showError("拆解失败，点击重试");
    } finally {
      if (analysisPlaybackState === playbackState) analysisPlaybackState = null;
    }
  }

  // ── Key canonicalization ──

  function resolveAliasKey(key) {
    if (!key) return key;
    let current = key;
    const seen = new Set();
    while (keyAliasMap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = keyAliasMap.get(current);
    }
    return current;
  }

  function recordDuplicateAnalyzeSkip(reason, canonicalKey, extra = {}) {
    const state = diagnostics?.getState?.() || {};
    diagnostics?.updateState?.({
      analysisSkippedReason: reason,
      analyzeTriggerStatus: "skipped-duplicate",
      analyzeTriggerBlockedReason: reason,
      skippedDuplicateAnalyzeCount: (state.skippedDuplicateAnalyzeCount || 0) + 1,
      lastDuplicateCaptureKey: canonicalKey || null,
      lastDuplicateCaptureAt: Date.now(),
      ...extra
    });
  }

  function resolveCanonicalAnalyzeKey(rawKey, fingerprint, songId) {
    if (keyAliasMap.has(rawKey)) {
      return resolveAliasKey(rawKey);
    }
    const existingCanonical = lyricsFingerprintToCanonicalKey.get(fingerprint);
    if (existingCanonical) {
      if (songId && typeof existingCanonical === "string" && existingCanonical.startsWith("captured:")) {
        promoteCanonicalKey(fingerprint, rawKey);
        return rawKey;
      }
      if (existingCanonical !== rawKey) {
        keyAliasMap.set(rawKey, existingCanonical);
        if (!canonicalToProvisionalKeys.has(existingCanonical)) {
          canonicalToProvisionalKeys.set(existingCanonical, new Set());
        }
        canonicalToProvisionalKeys.get(existingCanonical).add(rawKey);
        diagnostics?.updateState?.({
          rawAnalyzeKey: rawKey,
          canonicalAnalyzeKey: existingCanonical,
          analyzeKeyAliasFrom: rawKey,
          analyzeKeyAliasTo: existingCanonical,
          keyAliasReason: "same-lyrics-key-alias",
          promotionReason: "same-lyrics-key-alias",
          lastKeyAliasAt: Date.now()
        });
      }
      return existingCanonical;
    }
    lyricsFingerprintToCanonicalKey.set(fingerprint, rawKey);
    return rawKey;
  }

  function promoteCanonicalKey(fingerprint, newCanonicalKey) {
    const oldCanonical = lyricsFingerprintToCanonicalKey.get(fingerprint);
    if (!oldCanonical || oldCanonical === newCanonicalKey) return;
    keyAliasMap.delete(newCanonicalKey);
    keyAliasMap.set(oldCanonical, newCanonicalKey);
    if (inFlightAnalyzeKey === oldCanonical) inFlightAnalyzeKey = newCanonicalKey;
    if (lastAnalyzedKey === oldCanonical) lastAnalyzedKey = newCanonicalKey;
    if (lastSettledAnalyzeKey === oldCanonical) lastSettledAnalyzeKey = newCanonicalKey;
    if (currentAnalyzeKey === oldCanonical) currentAnalyzeKey = newCanonicalKey;
    if (displayedAnalyzeKey === oldCanonical) displayedAnalyzeKey = newCanonicalKey;
    if (currentAnalysis?.analyzeKey === oldCanonical) currentAnalysis.analyzeKey = newCanonicalKey;
    if (Cache.defaultCache.has(oldCanonical)) {
      Cache.defaultCache.set(newCanonicalKey, Cache.defaultCache.get(oldCanonical));
      Cache.defaultCache.delete(oldCanonical);
    }
    if (canonicalToProvisionalKeys.has(oldCanonical)) {
      canonicalToProvisionalKeys.set(newCanonicalKey, canonicalToProvisionalKeys.get(oldCanonical));
      canonicalToProvisionalKeys.delete(oldCanonical);
    }
    canonicalToProvisionalKeys.set(newCanonicalKey, (canonicalToProvisionalKeys.get(newCanonicalKey) || new Set()).add(oldCanonical));
    lyricsFingerprintToCanonicalKey.set(fingerprint, newCanonicalKey);
    diagnostics?.updateState?.({
      analyzeKeyAliasFrom: oldCanonical,
      analyzeKeyAliasTo: newCanonicalKey,
      keyAliasReason: "captured-key-promoted-to-song-key",
      promotionReason: "captured-key-promoted-to-song-key",
      lastKeyAliasAt: Date.now(),
      canonicalAnalyzeKey: newCanonicalKey
    });
    Utils.log("canonical key promoted", { from: oldCanonical, to: newCanonicalKey });
  }

  // ── Terminal state helpers ──

  function settleAnalyzeKey(key, status) {
    if (!key || !TERMINAL_STATUSES.has(status)) return;
    lastSettledAnalyzeKey = key;
    lastSettledAnalyzeStatus = status;
    lastSettledAt = Date.now();
    clearWatchdog();
    diagnostics?.updateState?.({
      lastSettledAnalyzeKey: key,
      lastSettledAnalyzeStatus: status,
      lastSettledAt
    });
  }

  function startWatchdog(key, options = {}) {
    clearWatchdog();
    const batchCount = Math.max(1, Math.round(Number(options.batchCount) || 1));
    const concurrency = Math.max(1, Math.round(Number(options.concurrency) || 1));
    const waveCount = Math.max(1, Math.ceil(batchCount / concurrency));
    const requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs)) && Number(options.requestTimeoutMs) > 0
      ? Math.round(Number(options.requestTimeoutMs))
      : (settings.analyzeTimeoutMs || 60000);
    const maxWait = (requestTimeoutMs * waveCount) + 5000;
    const startedAt = Date.now();
    diagnostics?.updateState?.({
      panelLoadingStartedAt: startedAt,
      loadingWatchdogBatchCount: batchCount,
      loadingWatchdogConcurrency: concurrency,
      loadingWatchdogWaveCount: waveCount,
      loadingWatchdogRequestTimeoutMs: requestTimeoutMs,
      loadingWatchdogMaxWaitMs: maxWait,
      loadingWatchdogTriggered: false
    });
    watchdogTimer = setInterval(() => {
      if (inFlightAnalyzeKey !== key) {
        clearWatchdog();
        return;
      }
      if (Date.now() - startedAt < maxWait) return;
      clearWatchdog();
      settleAnalyzeKey(key, "error");
      diagnostics?.updateState?.({
        panelStatus: "error",
        panelTextSample: "分析没有正常结束，请重试",
        panelLastRenderReason: "loading-watchdog-timeout",
        loadingWatchdogTriggered: true,
        apiStatus: "error",
        lastError: "loading watchdog timeout"
      });
      panel?.showError("分析没有正常结束，请重试");
      inFlightAnalyzeKey = null;
      abortActiveRequest({ silentDiagnostics: true, reason: "watchdog" });
    }, 500);
    if (watchdogTimer.unref) watchdogTimer.unref();
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  async function waitForLyrics(songId, signal) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 6000) {
      if (signal?.aborted) return null;
      if (songId && currentSongId && songId !== currentSongId) return null;
      const result = Lyrics.getCurrentLyricsFromGlobals() || Lyrics.tryGetLyricsFromNcmRuntime() || Lyrics.getCapturedLyrics();
      if (result?.lines?.length) {
        const hash = Lyrics.lyricsHash(Lyrics.preprocessLyricLines(result.lines));
        if (!lastLyricsHash || hash !== lastLyricsHash || Date.now() - startedAt > 1500) {
          return result;
        }
      }
      await delay(500);
    }
    Utils.log("歌词获取失败，静默降级", songId);
    diagnostics?.updateState?.({ lyricsSource: "none", apiStatus: "lyrics-unavailable" });
    panel?.hide();
    return null;
  }

  function sortCards(cards, lines) {
    const order = new Map(lines.map((line, index) => [line.index, index]));
    return cards.slice().sort((a, b) => (order.get(a.index) ?? 9999) - (order.get(b.index) ?? 9999));
  }

  function normalizeBatchSize(batchSize) {
    return Number.isFinite(Number(batchSize)) && Number(batchSize) > 0
      ? Math.max(1, Math.round(Number(batchSize)))
      : PER_LINE_BATCH_SIZE;
  }

  function countAnalysisBatches(lines, batchSize, cardGenerationMode) {
    if (cardGenerationMode !== "per-line") return 1;
    const lineCount = Array.isArray(lines) ? lines.length : 0;
    return Math.max(1, Math.ceil(lineCount / normalizeBatchSize(batchSize)));
  }

  function countAnalysisConcurrency(lines, batchSize, cardGenerationMode) {
    const batchCount = countAnalysisBatches(lines, batchSize, cardGenerationMode);
    return cardGenerationMode === "per-line"
      ? Math.max(1, Math.min(PER_LINE_BATCH_CONCURRENCY, batchCount))
      : 1;
  }

  function chunkLines(lines, batchSize) {
    const chunks = [];
    for (let i = 0; i < lines.length; i += batchSize) {
      chunks.push(lines.slice(i, i + batchSize));
    }
    return chunks;
  }

  function mergeDropReasons(reports) {
    const merged = {};
    for (const report of reports) {
      const reasons = report?.dropReasons || {};
      for (const key of Object.keys(reasons)) {
        merged[key] = (merged[key] || 0) + Number(reasons[key] || 0);
      }
    }
    return Object.keys(merged).length ? merged : null;
  }

  function findStartBatchIndex(batches, currentMs) {
    if (!Number.isFinite(Number(currentMs)) || !batches.length) return 0;
    const timeMs = Number(currentMs);
    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      if (!batch.length) continue;
      const firstStart = Number(batch[0]?.startTime);
      if (Number.isFinite(firstStart) && timeMs < firstStart) {
        return Math.max(0, i - 1);
      }
    }
    return batches.length - 1;
  }

  function orderBatchesByPlaybackTime(batches, currentMs) {
    const indexed = batches.map((batch, originalIndex) => ({ batch, originalIndex }));
    if (indexed.length <= 1) return indexed;
    const startIndex = findStartBatchIndex(batches, currentMs);
    if (startIndex <= 0 || startIndex >= indexed.length) return indexed;
    return [...indexed.slice(startIndex), ...indexed.slice(0, startIndex)];
  }

  async function requestCardsForLines({ lines, language, timeoutMs, maxTokens, temperature, batchSize, isFallback, cardGenerationMode, signal, currentMs, playbackState, onPartialBatch }) {
    const effectiveBatchSize = normalizeBatchSize(batchSize);
    const rawBatches = cardGenerationMode === "per-line"
      ? chunkLines(lines, effectiveBatchSize)
      : [lines];
    const orderedBatches = cardGenerationMode === "per-line"
      ? orderBatchesByPlaybackTime(rawBatches, currentMs)
      : rawBatches.map((batch, originalIndex) => ({ batch, originalIndex }));
    const reports = [];
    const mergedCards = [];
    const concurrency = cardGenerationMode === "per-line"
      ? Math.min(PER_LINE_BATCH_CONCURRENCY, orderedBatches.length)
      : 1;

    diagnostics?.updateState?.({
      analyzeBatchCount: orderedBatches.length,
      analyzeBatchIndex: null,
      analyzeBatchSize: null,
      analyzeMergedCardCount: 0,
      analyzeBatchConcurrency: concurrency,
      analyzeStartedBatchCount: 0,
      analyzeCompletedBatchCount: 0,
      analyzeFirstBatchOriginalIndex: orderedBatches[0]?.originalIndex ?? 0,
      analyzeBatchOrder: orderedBatches.map((item) => item.originalIndex)
    });

    const batchController = new AbortController();
    const relayAbort = () => batchController.abort();
    if (signal) {
      if (signal.aborted) batchController.abort();
      else signal.addEventListener?.("abort", relayAbort, { once: true });
    }
    let nextBatchIndex = 0;
    let startedBatchCount = 0;
    let completedBatchCount = 0;
    const batchResults = new Array(orderedBatches.length);

    async function requestOneBatch(i) {
      const { batch, originalIndex } = orderedBatches[i];
      const formattedLyrics = Lyrics.formatLinesForPrompt(batch, { detailed: cardGenerationMode === "per-line" });
      startedBatchCount += 1;
      // Initialize slot before the request so streamed cards can accumulate.
      batchResults[i] = batchResults[i] || { report: null, cards: [], originalIndex };
      const slot = batchResults[i];
      diagnostics?.updateState?.({
        analyzeBatchIndex: i + 1,
        analyzeBatchSize: batch.length,
        analyzeBatchOriginalIndex: originalIndex,
        analyzeStartedBatchCount: startedBatchCount
      });

      function emitCumulativePartial(reason) {
        if (typeof onPartialBatch !== "function") return;
        const cumulative = batchResults.flatMap((result) => result?.cards || []);
        if (!cumulative.length) return;
        try {
          onPartialBatch({
            cards: cumulative,
            batchIndex: i,
            totalBatches: orderedBatches.length,
            batchOriginalIndex: originalIndex,
            reason
          });
        } catch (err) {
          Utils.warn?.("onPartialBatch 回调失败", err);
        }
      }

      // Streaming per-card handler — runs per card as the model emits them.
      function handleStreamCard(rawCard) {
        if (cardGenerationMode !== "per-line") return;
        if (!rawCard || typeof rawCard !== "object") return;
        const singleReport = Api.normalizeCardsWithReport
          ? Api.normalizeCardsWithReport({ cards: [rawCard] }, batch)
          : { cards: Api.normalizeCards({ cards: [rawCard] }, batch) };
        if (!singleReport.cards.length) return;
        const newCard = singleReport.cards[0];
        const newIdx = newCard.lineIndex ?? newCard.index;
        if (slot.cards.some((c) => (c.lineIndex ?? c.index) === newIdx)) return;
        slot.cards.push(newCard);
        emitCumulativePartial("stream-card");
      }

      const parsed = await Api.requestAnalysis({
        apiEndpoint: settings.apiEndpoint.trim(),
        apiKey: settings.apiKey.trim(),
        modelName: settings.modelName.trim(),
        language,
        formattedLyrics,
        timeoutMs,
        maxTokens,
        temperature,
        thinkingMode: settings.modelThinkingMode,
        responseFormatMode: settings.responseFormatMode,
        isFallback,
        cardGenerationMode,
        signal: batchController.signal,
        onStreamCard: cardGenerationMode === "per-line" ? handleStreamCard : undefined
      });
      const report = Api.normalizeCardsWithReport
        ? Api.normalizeCardsWithReport(parsed, batch)
        : { cards: Api.normalizeCards(parsed, batch), parsedCount: 0, normalizedCount: 0, dropReasons: null };
      slot.report = report;
      // Final reconciliation: replace any streamed-card view with the
      // authoritative normalized set (picks up cards the stream parser
      // may have missed due to JSON edge cases, drops any spurious ones).
      slot.cards = report.cards;
      completedBatchCount += 1;
      const partialCards = batchResults.flatMap((result) => result?.cards || []);
      diagnostics?.updateState?.({
        analyzeBatchIndex: i + 1,
        analyzeBatchOriginalIndex: originalIndex,
        analyzeCompletedBatchCount: completedBatchCount,
        analyzeMergedCardCount: partialCards.length
      });
      if (typeof onPartialBatch === "function" && completedBatchCount < orderedBatches.length) {
        try {
          onPartialBatch({
            cards: partialCards,
            batchIndex: i,
            totalBatches: orderedBatches.length,
            batchOriginalIndex: originalIndex,
            reason: "batch-complete"
          });
        } catch (err) {
          Utils.warn?.("onPartialBatch 回调失败", err);
        }
      }
    }

    let lastReprioritizedAtMs = null;
    let reprioritizeCount = 0;

    function scoreBatchForTime(item, targetMs) {
      const batch = item?.batch;
      if (!Array.isArray(batch) || !batch.length) return Infinity;
      const firstStart = Number(batch[0]?.startTime);
      if (!Number.isFinite(firstStart)) return Infinity;
      const lastLine = batch[batch.length - 1];
      const lastEnd = Number(lastLine?.endTime ?? lastLine?.startTime);
      if (Number.isFinite(lastEnd) && targetMs >= firstStart && targetMs <= lastEnd + 1000) return 0;
      return Math.abs(firstStart - targetMs);
    }

    function reprioritizeRemaining(startIndex) {
      if (cardGenerationMode !== "per-line") return;
      if (!playbackState || !Number.isFinite(Number(playbackState.currentMs))) return;
      if (startIndex >= orderedBatches.length - 1) return;
      const targetMs = Number(playbackState.currentMs);
      if (lastReprioritizedAtMs !== null && Math.abs(targetMs - lastReprioritizedAtMs) < 1000) return;

      let bestIdx = startIndex;
      let bestScore = scoreBatchForTime(orderedBatches[startIndex], targetMs);
      for (let j = startIndex + 1; j < orderedBatches.length; j += 1) {
        const score = scoreBatchForTime(orderedBatches[j], targetMs);
        if (score < bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }
      lastReprioritizedAtMs = targetMs;
      if (bestIdx === startIndex) return;
      const swappedOut = orderedBatches[startIndex];
      const swappedIn = orderedBatches[bestIdx];
      orderedBatches[startIndex] = swappedIn;
      orderedBatches[bestIdx] = swappedOut;
      reprioritizeCount += 1;
      diagnostics?.updateState?.({
        analyzeReprioritizeCount: reprioritizeCount,
        analyzeReprioritizeLastAt: Date.now(),
        analyzeReprioritizeCurrentMs: targetMs,
        analyzeReprioritizeFromBatch: swappedOut.originalIndex,
        analyzeReprioritizeToBatch: swappedIn.originalIndex,
        analyzeBatchOrder: orderedBatches.map((item) => item.originalIndex)
      });
    }

    async function worker() {
      while (nextBatchIndex < orderedBatches.length) {
        if (batchController.signal.aborted) return;
        reprioritizeRemaining(nextBatchIndex);
        const i = nextBatchIndex;
        nextBatchIndex += 1;
        await requestOneBatch(i);
      }
    }

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } catch (err) {
      batchController.abort();
      throw err;
    } finally {
      if (signal) signal.removeEventListener?.("abort", relayAbort);
    }

    for (const result of batchResults) {
      if (!result) continue;
      reports.push(result.report);
      mergedCards.push(...result.cards);
    }

    return {
      cards: mergedCards,
      report: {
        cards: mergedCards,
        parsedCount: reports.reduce((sum, report) => sum + Number(report.parsedCount || 0), 0),
        normalizedCount: mergedCards.length,
        dropReasons: mergeDropReasons(reports),
        droppedSamples: reports.flatMap((report) => report.droppedSamples || []).slice(0, 6)
      }
    };
  }

  function validateCardCoverage(cards, lines, cardGenerationMode) {
    if (cardGenerationMode !== "per-line") {
      return {
        expectedCardCount: null,
        actualCardCount: cards.length,
        missingCardLineIndexes: [],
        partialCardGeneration: false
      };
    }
    const cardIndexes = new Set(cards.map((card) => card.lineIndex ?? card.index));
    const missing = lines
      .map((line) => line.index)
      .filter((index) => !cardIndexes.has(index));
    return {
      expectedCardCount: lines.length,
      actualCardCount: cards.length,
      missingCardLineIndexes: missing,
      partialCardGeneration: missing.length > 0
    };
  }

  function clearDisplayedCards(analyzeKey, reason, sampleText = "正在分析当前歌词...") {
    displayedAnalyzeKey = null;
    currentCardOrdinal = 0;
    lastLineIndex = null;
    diagnostics?.updateState?.({
      currentAnalyzeKey: analyzeKey || null,
      displayedAnalyzeKey: null,
      displayedCardCount: 0,
      currentCardIndex: 0,
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
      lastPanelResetReason: reason,
      staleCardsCleared: true,
      panelLastRenderReason: reason === "analyze-key-changed" ? "analyzing" : reason,
      panelLastRenderedAt: Date.now(),
      panelTextSample: sampleText
    });
    if (reason === "analyze-key-changed") {
      panel?.resetForAnalyze?.({ analyzeKey, reason, message: sampleText });
    }
  }

  function cardText(card) {
    return String(card?.original || card?.line || "").slice(0, 200) || null;
  }

  function cardDiagnostics(cards, ordinal) {
    const current = cards?.[ordinal] || null;
    const previous = cards?.[ordinal - 1] || null;
    const next = cards?.[ordinal + 1] || null;
    return {
      currentCardLineIndex: current?.lineIndex ?? current?.index ?? null,
      currentCardStartMs: current?.startMs ?? current?.startTime ?? null,
      currentCardEndMs: current?.endMs ?? current?.endTime ?? null,
      currentCardOriginal: cardText(current),
      previousCardLineIndex: previous?.lineIndex ?? previous?.index ?? null,
      previousCardOriginal: cardText(previous),
      previousCardStartMs: previous?.startMs ?? previous?.startTime ?? null,
      nextCardLineIndex: next?.lineIndex ?? next?.index ?? null,
      nextCardOriginal: cardText(next),
      nextCardStartMs: next?.startMs ?? next?.startTime ?? null
    };
  }

  function setAnalysis({ songId, lyricsHash, language, lines, cards, analyzeKey }) {
    const cardsByIndex = new Map(cards.map((card) => [card.index, card]));
    // Remember which lyric LINE we were showing — not the ordinal, which is
    // unstable while streaming inserts more cards. Without this, streaming
    // partials cause panel to flicker between unrelated lyric lines because
    // each new card with a smaller lineIndex becomes the new cards[0].
    const prevCards = currentAnalysis?.cards;
    const prevDisplayedLineIndex = Array.isArray(prevCards) && prevCards[currentCardOrdinal]
      ? (prevCards[currentCardOrdinal].lineIndex ?? prevCards[currentCardOrdinal].index ?? null)
      : null;
    const prevDisplayedAnalyzeKey = currentAnalysis?.analyzeKey;
    currentAnalysis = { songId, lyricsHash, language, lines, cards, cardsByIndex, analyzeKey };
    displayedAnalyzeKey = analyzeKey || null;
    currentAnalyzeKey = analyzeKey || currentAnalyzeKey;

    const snapshot = readPlaybackTimeSnapshot();
    if (snapshot && Sync.selectCardByPlaybackTime) {
      // Playback time available — pick by time as before.
      const idx = Sync.selectCardByPlaybackTime(snapshot.timeMs, cards);
      currentCardOrdinal = Number.isInteger(idx) ? idx : 0;
    } else if (prevDisplayedLineIndex != null && prevDisplayedAnalyzeKey === analyzeKey) {
      // No playback time AND same analysis (i.e. this is a streaming
      // partial update for the same song) — re-find the line we were on
      // so the panel stays anchored. If the prior line isn't in the new
      // card set, fall back to 0.
      const found = cards.findIndex((c) => (c.lineIndex ?? c.index) === prevDisplayedLineIndex);
      currentCardOrdinal = found >= 0 ? found : 0;
    } else {
      currentCardOrdinal = 0;
    }
    const currentCard = cards[currentCardOrdinal] || null;
    diagnostics?.updateState?.({
      cardCount: cards.length,
      displayedAnalyzeKey,
      displayedCardCount: cards.length,
      currentCardIndex: currentCardOrdinal,
      ...cardDiagnostics(cards, currentCardOrdinal),
      panelLastRenderReason: "analyze-success",
      panelLastRenderedAt: Date.now(),
      panelTextSample: currentCard ? [currentCard.line || currentCard.original, currentCard.translation].filter(Boolean).join(" / ").slice(0, 200) : ""
    });
    panel?.setCardsState?.({
      analyzeKey,
      cards,
      language,
      analysis: currentAnalysis,
      initialIndex: currentCardOrdinal,
      currentMs: Number.isFinite(lastProgressMs) && playbackHasRealTime ? lastProgressMs : null,
      reason: "analyze-success"
    });
    if (!panel?.setCardsState) {
      renderCurrentProgress("analyze-success");
    }
    startPlaybackSyncLoop();
  }

  function mergeTimeSourceDiagnostics(candidates, failureReason) {
    if (!diagnostics?.updateState) return;
    const current = diagnostics.getState ? diagnostics.getState() : {};
    const merged = Array.isArray(current.timeSourceCandidates)
      ? current.timeSourceCandidates.slice()
      : [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!candidate?.name) continue;
      const next = {
        name: candidate.name,
        status: candidate.status,
        trusted: candidate.trusted === true,
        ...(candidate.reason ? { reason: candidate.reason } : {}),
        ...(candidate.source ? { source: candidate.source } : {})
      };
      const index = merged.findIndex((item) => item?.name === next.name);
      if (index >= 0) merged[index] = next;
      else merged.push(next);
    }
    diagnostics.updateState({
      timeSourceCandidates: merged,
      timeSourceFailureReason: failureReason ?? null
    });
  }

  function appendFailureReason(base, reason) {
    if (!reason) return base || null;
    if (!base) return reason;
    const parts = String(base).split(";").filter(Boolean);
    return parts.includes(reason) ? base : base + ";" + reason;
  }

  function playProgressRegisteredWithoutEvents() {
    const state = diagnostics?.getState?.() || {};
    if (Number(state.playProgressEventCount || 0) > 0) return false;
    return Array.isArray(state.timeSourceCandidates) && state.timeSourceCandidates.some((candidate) => (
      candidate?.name === "PlayProgress" &&
      candidate?.status === "registered" &&
      candidate?.trusted === true
    ));
  }

  function readTrustedPlaybackSnapshot() {
    if (!Sync.readTrustedPlaybackTime) return null;
    const result = Sync.readTrustedPlaybackTime(root);
    let failureReason = result?.failureReason || null;
    if ((result?.timeMs === null || result?.timeMs === undefined) && playProgressRegisteredWithoutEvents()) {
      failureReason = appendFailureReason(failureReason, "playprogress-registered-no-events");
    }
    mergeTimeSourceDiagnostics(result?.candidates, failureReason);
    if (result?.timeMs !== null && result?.timeMs !== undefined && Number.isFinite(Number(result.timeMs))) {
      return {
        timeMs: Number(result.timeMs),
        status: "trusted-time-source",
        source: result.source || "trusted-progress-getter",
        reliable: result.reliable === true
      };
    }
    return null;
  }

  function handleProgress(timeMs, progressArgs) {
    // ── Synthesize song-change from PlayProgress trackId ──
    // NCM (under certain BetterNCM channels) doesn't fire PlayState events for
    // song changes, but it does pass a trackId (e.g. "1806096519_VPY7L3") as
    // the first PlayProgress arg. Detect the change here so handleSongChange
    // runs even when PlayState is dead.
    if (Array.isArray(progressArgs) && progressArgs.length) {
      const firstArg = progressArgs[0];
      if (typeof firstArg === "string" && firstArg !== lastProgressRawTrackMarker) {
        lastProgressRawTrackMarker = firstArg;
        const extracted = Sync.extractSongIdFromConsoleString?.(firstArg);
        if (extracted && extracted !== currentSongId) {
          console.log("[LyricLens:song-change-from-progress]", { from: currentSongId, to: extracted, rawArg: firstArg });
          handleSongChange(extracted);
        }
      }
    }
    lastProgressMs = timeMs;
    playbackHasRealTime = true;
    lastProgressEventAt = Date.now();
    playbackBaseWallClock = Date.now();
    playbackBaseMs = timeMs;
    // Also reset the trusted-time freeze tracker so wall-clock fallback
    // anchors here.
    lastTrustedTimeMs = timeMs;
    lastTrustedTimeChangedAt = Date.now();
    if (analysisPlaybackState) analysisPlaybackState.currentMs = timeMs;
    // Determine sync quality: PlayProgress is firing, but is PlayState also available?
    const playStateEvents = diagnostics?.getState?.()?.playStateEventCount || 0;
    // Promote PlayProgress candidate to "live" so diagnostics reflect that real-time
    // pushes are actually flowing (vs. just being registered).
    mergeTimeSourceDiagnostics(
      [{ name: "PlayProgress", status: "live", trusted: true, source: "PlayProgress(push)" }],
      null
    );
    // Only clear paused flag if we weren't explicitly paused by a PlayState event
    if (!playbackPaused) {
      const syncStatus = playStateEvents > 0 ? "real-time-source" : "real-time-no-playstate";
      diagnostics?.updateState?.({
        playbackCurrentMs: timeMs,
        playbackEstimatedMs: null,
        playbackSyncStatus: syncStatus,
        playbackPaused: false,
        timeSourceFailureReason: null
      });
    } else {
      // Keep paused state but update the real progress for future resume baseline
      diagnostics?.updateState?.({
        playbackCurrentMs: timeMs,
        playbackEstimatedMs: null,
        playbackSyncStatus: "paused",
        playbackPaused: true,
        timeSourceFailureReason: null
      });
    }
    if (!currentAnalysis || suppressedSongId === currentAnalysis.songId) return;
    // Check for console songId candidate promotion
    checkConsoleSongIdPromotion();
    syncPlaybackToTime(timeMs, "playback-sync", "real-time-source");
  }

  function renderCurrentProgress(reason = "playback-sync") {
    if (!currentAnalysis || suppressedSongId === currentAnalysis.songId) return;
    const card = currentAnalysis.cards[currentCardOrdinal] || null;
    if (!card) {
      diagnostics?.updateState?.({ currentCardIndex: null });
      panel?.hide();
      return;
    }
    diagnostics?.updateState?.({
      currentCardIndex: currentCardOrdinal,
      ...cardDiagnostics(currentAnalysis.cards, currentCardOrdinal),
      panelLastRenderReason: reason,
      panelLastRenderedAt: Date.now(),
      panelTextSample: [card.original || card.line, card.translation].filter(Boolean).join(" / ").slice(0, 200)
    });
    if (panel?.renderCardAt) {
      panel.renderCardAt(currentCardOrdinal, reason);
    } else {
      panel?.showCard(currentAnalysis, card.index);
    }
  }

  function selectOrdinalForCurrentTime(cards) {
    const snapshot = readPlaybackTimeSnapshot();
    if (snapshot && Sync.selectCardByPlaybackTime) {
      const index = Sync.selectCardByPlaybackTime(snapshot.timeMs, cards);
      return Number.isInteger(index) ? index : 0;
    }
    return 0;
  }

  function readPlaybackTimeSnapshot() {
    if (playbackPaused && playbackHasRealTime) {
      return { timeMs: playbackBaseMs, status: "paused" };
    }
    const now = Date.now();
    const trustedSnapshot = readTrustedPlaybackSnapshot();
    // ── Fresh-song-change distrust window ──
    // Right after a song change, the NCM progress slider DOM may be
    // mid-remount and Sync falls back to the AMLL CSS var, which is
    // frozen on the previous song's tail. Anchoring there picks the
    // wrong card; the next tick gets the real slider value and snaps
    // back to card 0 — the user sees cards bounce between the last and
    // first card. Refuse unreliable sources for the first few seconds
    // and extrapolate from songChangeAt (always starts at 0 for a new
    // song). When the slider DOM settles, its reliable=true value wins
    // and the trusted branch below takes over normally.
    if (trustedSnapshot
        && trustedSnapshot.reliable === false
        && songChangeAt > 0
        && (now - songChangeAt) < TRUSTED_TIME_DISTRUST_AFTER_SONG_CHANGE_MS) {
      return {
        timeMs: Math.max(0, now - songChangeAt),
        status: "wall-clock-from-song-change-fresh"
      };
    }
    if (trustedSnapshot && Number.isFinite(Number(trustedSnapshot.timeMs))) {
      const t = Number(trustedSnapshot.timeMs);
      // Heuristic pause detection: AMLL writes --amll-player-time=0 when
      // playback is paused, when a song is loading, or during song
      // transitions. NCM's PlayState events are dead in this build so we
      // can't detect pause directly — we infer it from the CSS var
      // dropping to 0 after we've seen a positive anchor. Freeze cards
      // at the last anchored position; if playback truly resumes, AMLL
      // will push a fresh positive value and we'll re-anchor.
      const hadPositiveAnchor = lastTrustedTimeMs != null && lastTrustedTimeMs > 0;
      if (t === 0 && hadPositiveAnchor) {
        return { timeMs: playbackBaseMs, status: "paused-inferred" };
      }
      // Compare against the value remembered from BEFORE the last song
      // change. If it's different now, AMLL pushed a new real value
      // (either because the song is playing normally and the var is
      // ticking, or because NCM seeded AMLL with the resume position
      // even though AMLL can't actually tick). Either way: trust it
      // as a wall-clock anchor.
      // If it equals the prev-song frozen tail, AMLL never updated for
      // this song — fall through to the wall-clock-from-songChangeAt
      // path so we at least extrapolate from 0 instead of anchoring on
      // a wildly wrong value.
      if (lastTrustedTimeMs !== t) {
        lastTrustedTimeMs = t;
        lastTrustedTimeChangedAt = now;
        playbackBaseMs = t;
        playbackBaseWallClock = now;
        diagnostics?.updateState?.({ timeSourceFailureReason: null });
        return trustedSnapshot;
      }
      const frozenForMs = now - lastTrustedTimeChangedAt;
      diagnostics?.updateState?.({
        trustedFrozenForMs: frozenForMs,
        trustedAnchorBaseMs: playbackBaseMs,
        trustedAnchorWallClock: playbackBaseWallClock
      });
      if (frozenForMs < TRUSTED_TIME_STALE_MS) return trustedSnapshot;
      // Ground-truth source (NCM progress slider) frozen past the stale
      // window = playback is paused or mid-seek, NOT a laggy feed. The
      // slider advances every ~1s while playing, so a longer stall can
      // only mean a stopped playhead. Hold the card at the frozen position
      // instead of extrapolating forward (which is what makes cards keep
      // scrolling through a pause). A resume or seek changes the value and
      // re-anchors on the very next tick via the branch above.
      if (trustedSnapshot.reliable) {
        return { timeMs: playbackBaseMs, status: "paused-inferred" };
      }
      // The pause-infer path only makes sense when we actually anchored
      // on this song. Without an anchor (playbackBaseWallClock === 0)
      // the song is still in the "AMLL has the previous song's frozen
      // tail" state, so freezing on baseMs=0 would be wrong — fall
      // through to the songChangeAt extrapolation below.
      if (frozenForMs >= TRUSTED_TIME_PAUSE_INFER_MS && playbackBaseWallClock > 0) {
        return { timeMs: playbackBaseMs, status: "paused-inferred" };
      }
      // Trusted time frozen briefly (or longer but without any real
      // anchor) — wall-clock fallback from the anchor if we have one.
      if (playbackBaseWallClock > 0) {
        return {
          timeMs: playbackBaseMs + (now - playbackBaseWallClock),
          status: "wall-clock-estimated"
        };
      }
      // No prior anchor exists at all — extrapolate from song change.
      // Best-effort: assumes the user started the song from the beginning.
      if (songChangeAt > 0) {
        return {
          timeMs: Math.max(0, now - songChangeAt),
          status: "wall-clock-estimated"
        };
      }
      return trustedSnapshot;
    }
    if (playbackHasRealTime && playbackBaseWallClock > 0) {
      diagnostics?.updateState?.({ timeSourceFailureReason: null });
      return {
        timeMs: playbackBaseMs + (now - playbackBaseWallClock),
        status: "wall-clock-estimated"
      };
    }
    if (playbackHasRealTime) {
      diagnostics?.updateState?.({ timeSourceFailureReason: null });
      return { timeMs: playbackBaseMs, status: "real-time-source" };
    }
    return null;
  }

  function syncPlaybackToTime(timeMs, reason = "playback-sync", status = "trusted-time-source") {
    if (!currentAnalysis?.cards?.length || !Sync.selectCardByPlaybackTime || !Number.isFinite(Number(timeMs))) {
      const trustedSnapshot = readTrustedPlaybackSnapshot();
      diagnostics?.updateState?.({
        playbackSyncStatus: "no-time-source",
        playbackCurrentMs: null,
        playbackEstimatedMs: null,
        playbackTimerActive: Boolean(playbackSyncTimer),
        lastPlaybackSyncAt: Date.now(),
        timeSourceFailureReason: trustedSnapshot ? null : (diagnostics?.getState?.()?.timeSourceFailureReason || "no-trusted-playback-time")
      });
      return;
    }
    if (panel?.getAutoFollow && panel.getAutoFollow() === false) {
      diagnostics?.updateState?.({
        playbackSyncStatus: "disabled",
        playbackCurrentMs: timeMs,
        playbackEstimatedMs: null,
        playbackTimerActive: Boolean(playbackSyncTimer),
        lastPlaybackSyncAt: Date.now()
      });
      return;
    }
    const nextOrdinal = Sync.selectCardByPlaybackTime(timeMs, currentAnalysis.cards);
    const playStateEvents = diagnostics?.getState?.()?.playStateEventCount || 0;
    const effectiveStatus = status === "real-time-source" && playStateEvents === 0
      ? "real-time-no-playstate"
      : status;
    diagnostics?.updateState?.({
      playbackSyncEnabled: true,
      playbackSyncStatus: effectiveStatus,
      playbackCurrentMs: timeMs,
      playbackEstimatedMs: null,
      playbackTimerActive: Boolean(playbackSyncTimer),
      lastPlaybackSyncAt: Date.now()
    });
    if (typeof panel?.syncToPlayback === "function") {
      const syncedOrdinal = panel.syncToPlayback(timeMs, reason);
      if (Number.isInteger(syncedOrdinal)) currentCardOrdinal = syncedOrdinal;
      return;
    }
    if (nextOrdinal === null || nextOrdinal === currentCardOrdinal) return;
    currentCardOrdinal = nextOrdinal;
    renderCurrentProgress(reason);
  }

  function startPlaybackSyncLoop() {
    if (playbackSyncTimer) return;
    const initialSnapshot = readPlaybackTimeSnapshot();
    diagnostics?.updateState?.({
      playbackSyncEnabled: true,
      playbackTimerActive: true,
      playbackSyncStatus: initialSnapshot ? initialSnapshot.status : "no-time-source",
      playbackCurrentMs: initialSnapshot ? initialSnapshot.timeMs : null,
      playbackEstimatedMs: null
    });
    playbackSyncTimer = setInterval(() => {
      if (!currentAnalysis?.cards?.length) {
        diagnostics?.updateState?.({
          playbackSyncStatus: "no-time-source",
          playbackTimerActive: Boolean(playbackSyncTimer),
          lastPlaybackSyncAt: Date.now(),
          timeSourceFailureReason: diagnostics?.getState?.()?.timeSourceFailureReason || "no-active-analysis"
        });
        return;
      }
      if (playbackPaused) {
        diagnostics?.updateState?.({
          playbackSyncStatus: "paused",
          playbackTimerActive: true,
          lastPlaybackSyncAt: Date.now()
        });
        return;
      }
      const snapshot = readPlaybackTimeSnapshot();
      if (!snapshot) {
        diagnostics?.updateState?.({
          playbackSyncStatus: "no-time-source",
          playbackCurrentMs: null,
          playbackEstimatedMs: null,
          playbackTimerActive: Boolean(playbackSyncTimer),
          lastPlaybackSyncAt: Date.now(),
          timeSourceFailureReason: diagnostics?.getState?.()?.timeSourceFailureReason || "no-trusted-playback-time"
        });
        return;
      }
      syncPlaybackToTime(snapshot.timeMs, "playback-sync", snapshot.status);
    }, PLAYBACK_SYNC_INTERVAL_MS);
    playbackSyncTimer.unref?.();
  }

  function stopPlaybackSyncLoop() {
    if (playbackSyncTimer) clearInterval(playbackSyncTimer);
    playbackSyncTimer = null;
    playbackBaseWallClock = 0;
    playbackBaseMs = 0;
    playbackHasRealTime = false;
    lastProgressEventAt = 0;
    playbackPaused = false;
    clearAutoFollowSuppressTimer();
    diagnostics?.updateState?.({
      playbackSyncEnabled: false,
      playbackSyncStatus: "disabled",
      playbackCurrentMs: null,
      playbackEstimatedMs: null,
      playbackTimerActive: false,
      lastPlaybackSyncAt: Date.now(),
      autoFollowSuppressedUntil: null
    });
  }

  function isActive(requestId, songId) {
    if (requestId !== activeRequestId) return false;
    if (songId && currentSongId && songId !== currentSongId) return false;
    return true;
  }

  // Reach the BetterNCM `plugin` global. AMLL / InfLinkrs / PluginMarket
  // all use the bare identifier `plugin` (not `globalThis.plugin`), and
  // their tiles are clickable while ours isn't — strong evidence that
  // BetterNCM injects `plugin` as a script-scoped free variable (likely
  // via `new Function('plugin', code)`), so `root.plugin` is undefined.
  // `typeof` is the only safe check for a possibly-undeclared name; once
  // we have a binding we can read its properties normally.
  let pluginGlobal = null;
  try {
    if (typeof plugin !== "undefined" && plugin) pluginGlobal = plugin;
  } catch (_) { /* ReferenceError swallowed; pluginGlobal stays null */ }
  if (!pluginGlobal && root.plugin) pluginGlobal = root.plugin;
  LL.pluginGlobal = pluginGlobal;

  // Register the native config page synchronously at module top level.
  // BetterNCM's plugin manager checks for onConfig at list-render time,
  // which happens before any onLoad callback fires; registering inside
  // bootstrap() leaves the tile inert. buildNativeConfigPage is a
  // hoisted function declaration so referencing it here is safe.
  if (pluginGlobal && typeof pluginGlobal.onConfig === "function") {
    try {
      pluginGlobal.onConfig(buildNativeConfigPage);
    } catch (err) {
      console.warn("[LyricLens]", "plugin.onConfig 注册失败", err);
    }
  }

  if (pluginGlobal && typeof pluginGlobal.onLoad === "function") {
    pluginGlobal.onLoad(bootstrap);
  } else if (root.document?.readyState === "loading") {
    root.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

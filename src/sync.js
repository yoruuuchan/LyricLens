(function initLyricLensSync(root) {
  "use strict";

  function normalizeProgressMs(argsLike) {
    const args = Array.from(argsLike || []);
    if (args.length > 1) {
      const secondArg = readProgressTimeFromValue(args[1]);
      if (secondArg !== null) return secondArg;
    }
    for (const arg of args) {
      const timeMs = readProgressTimeFromValue(arg);
      if (timeMs !== null) return timeMs;
    }
    return null;
  }

  function normalizeProgressNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.round(numeric > 3600 ? numeric : numeric * 1000);
  }

  function normalizeProgressMilliseconds(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.round(numeric));
  }

  function mergeTimeSourceCandidate(diagnostics, candidate, failureReason) {
    if (!diagnostics?.updateState || !candidate?.name) return;
    const current = diagnostics.getState ? diagnostics.getState() : {};
    const candidates = Array.isArray(current.timeSourceCandidates)
      ? current.timeSourceCandidates.slice()
      : [];
    const nextCandidate = {
      name: candidate.name,
      status: candidate.status,
      trusted: candidate.trusted === true,
      ...(candidate.reason ? { reason: candidate.reason } : {}),
      ...(candidate.source ? { source: candidate.source } : {})
    };
    const index = candidates.findIndex((item) => item?.name === nextCandidate.name);
    if (index >= 0) candidates[index] = nextCandidate;
    else candidates.push(nextCandidate);
    diagnostics.updateState({
      timeSourceCandidates: candidates,
      timeSourceFailureReason: failureReason ?? null
    });
  }

  function getCurrentPlaybackMs(context = root) {
    let media = null;
    try {
      media = context?.document?.querySelector?.("audio");
    } catch (_) {
      return null;
    }
    const currentTime = Number(media?.currentTime);
    if (!Number.isFinite(currentTime)) return null;
    return Math.max(0, Math.round(currentTime * 1000));
  }

  function normalizeCssTimeMs(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const numeric = Number(raw.endsWith("ms") ? raw.slice(0, -2).trim() : raw);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.round(numeric));
  }

  // Cache for the AMLL player-time element. Walking the whole DOM every
  // sync tick (~1Hz) would be wasteful, so we remember the node and only
  // re-scan when it's detached or stops carrying the CSS var.
  let amllPlayerTimeElementCache = null;

  function findAmllPlayerTimeElement(context) {
    const doc = context?.document;
    if (!doc) return null;
    // Validate the cached node first; if it's still in the tree AND still
    // exposes the var, reuse it. This is the fast path.
    if (amllPlayerTimeElementCache) {
      try {
        const stillAttached = doc.contains?.(amllPlayerTimeElementCache);
        if (stillAttached) {
          const v = amllPlayerTimeElementCache.style?.getPropertyValue?.("--amll-player-time");
          if (v) return amllPlayerTimeElementCache;
        }
      } catch (_) {}
      amllPlayerTimeElementCache = null;
    }
    // Fast attribute selector first.
    try {
      const direct = doc.querySelector?.('[style*="--amll-player-time"]');
      if (direct) {
        amllPlayerTimeElementCache = direct;
        return direct;
      }
    } catch (_) {}
    // Fallback: walk all elements once. Some NCM/AMLL builds set the var
    // through CSSStyleDeclaration in a way that doesn't show up in the
    // serialized `style` attribute, breaking the [style*=...] selector.
    try {
      const all = doc.querySelectorAll?.("*");
      if (all) {
        for (const el of all) {
          const v = el.style?.getPropertyValue?.("--amll-player-time");
          if (v) {
            amllPlayerTimeElementCache = el;
            return el;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function readAmllPlayerCssTime(context = root) {
    const candidate = {
      name: "AMLL.player-css-time",
      status: "not-found",
      trusted: true,
      source: "--amll-player-time"
    };
    let element = null;
    try {
      element = findAmllPlayerTimeElement(context);
    } catch (err) {
      candidate.status = "failed";
      candidate.reason = String(err?.message || err).slice(0, 120);
      return { timeMs: null, candidate };
    }
    if (!element) return { timeMs: null, candidate };

    const direct = element.style?.getPropertyValue?.("--amll-player-time");
    const computed = direct || context?.getComputedStyle?.(element)?.getPropertyValue?.("--amll-player-time");
    const timeMs = normalizeCssTimeMs(computed);
    if (timeMs === null) {
      candidate.status = "invalid-value";
      candidate.reason = String(computed ?? "").slice(0, 120) || "empty-css-value";
      return { timeMs: null, candidate };
    }
    candidate.status = "available";
    return { timeMs, candidate };
  }

  function amllCssTimeFailureReason(candidate) {
    if (!candidate) return null;
    if (candidate.status === "not-found") return "amll-player-css-time-not-found";
    if (candidate.status === "invalid-value") return "amll-player-css-time-invalid";
    if (candidate.status === "failed") return "amll-player-css-time-failed";
    return null;
  }

  const TRUSTED_PROGRESS_GETTERS = [
    "getPlayingProgress",
    "getProgress",
    "getCurrentTime",
    "getPosition"
  ];

  function readProgressTimeFromValue(value) {
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
      return normalizeProgressNumber(value);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
      try {
        return readProgressTimeFromValue(JSON.parse(trimmed));
      } catch (_) {
        return null;
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = readProgressTimeFromValue(item);
        if (normalized !== null) return normalized;
      }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    const millisecondFields = [
      "timeMs",
      "currentMs",
      "positionMs",
      "progressMs",
      "currentTimeMs"
    ];
    for (const field of millisecondFields) {
      if (!(field in value)) continue;
      const normalized = normalizeProgressMilliseconds(value[field]);
      if (normalized !== null) return normalized;
    }
    const fields = [
      "time",
      "currentTime",
      "position",
      "progress"
    ];
    for (const field of fields) {
      if (!(field in value)) continue;
      const normalized = normalizeProgressNumber(value[field]);
      if (normalized !== null) return normalized;
    }
    const nestedFields = ["data", "detail", "payload", "state", "body"];
    for (const field of nestedFields) {
      if (!(field in value)) continue;
      const normalized = readProgressTimeFromValue(value[field]);
      if (normalized !== null) return normalized;
    }
    return null;
  }

  function recordProgressEvent(diagnostics, args, timeMs) {
    if (!diagnostics?.updateState) return;
    const accepted = timeMs !== null && Number.isFinite(Number(timeMs));
    diagnostics.updateState({
      playProgressAcceptedMs: accepted ? Number(timeMs) : null,
      playProgressRejectedReason: accepted ? null : "no-progress-ms-in-event",
      playProgressLastEventAt: Date.now()
    });
    if (!accepted) {
      mergeTimeSourceCandidate(
        diagnostics,
        { name: "PlayProgress", status: "invalid-value", trusted: true, reason: "no-progress-ms-in-event" },
        "playprogress-event-missing-ms"
      );
    }
  }

  function readTrustedPlaybackTime(context = root) {
    const ncm = context?.betterncm?.ncm;
    const candidates = [];
    let ncmFailureReason = null;
    if (!ncm || typeof ncm !== "object") {
      candidates.push({ name: "betterncm.ncm", status: "not-available", trusted: true });
      ncmFailureReason = "trusted-ncm-progress-unavailable";
    } else {
      for (const name of TRUSTED_PROGRESS_GETTERS) {
        const fn = ncm[name];
        if (typeof fn !== "function") {
          candidates.push({ name: `betterncm.ncm.${name}`, status: "not-available", trusted: true });
          continue;
        }
        try {
          const value = fn.call(ncm);
          const timeMs = readProgressTimeFromValue(value);
          if (timeMs !== null) {
            candidates.push({ name: `betterncm.ncm.${name}`, status: "available", trusted: true });
            return {
              timeMs,
              source: `betterncm.ncm.${name}`,
              candidates,
              failureReason: null
            };
          }
          candidates.push({ name: `betterncm.ncm.${name}`, status: "invalid-value", trusted: true });
        } catch (err) {
          candidates.push({
            name: `betterncm.ncm.${name}`,
            status: "failed",
            trusted: true,
            reason: String(err?.message || err).slice(0, 120)
          });
        }
      }
      ncmFailureReason = "trusted-progress-getter-unavailable";
    }

    const amllCssTime = readAmllPlayerCssTime(context);
    candidates.push(amllCssTime.candidate);
    if (amllCssTime.timeMs !== null) {
      return {
        timeMs: amllCssTime.timeMs,
        source: "AMLL.player-css-time",
        candidates,
        failureReason: null
      };
    }
    const amllFailureReason = amllCssTimeFailureReason(amllCssTime.candidate);

    // Observe <audio>.currentTime for diagnostics only — it is NOT a trusted source.
    // The DOM <audio> may not correspond to the song NCM thinks is playing
    // (preview, ad, stale node, multi-instance, etc.), so it must never drive
    // playbackCurrentMs, currentCardIndex, or batch ordering.
    const audioMs = getCurrentPlaybackMs(context);
    candidates.push({
      name: "dom-audio",
      status: audioMs !== null ? "observed" : "not-found",
      trusted: false,
      source: "audio.currentTime"
    });

    return {
      timeMs: null,
      source: null,
      candidates,
      failureReason: [ncmFailureReason, amllFailureReason].filter(Boolean).join(";") || "no-trusted-playback-time"
    };
  }

  function findCurrentLineIndex(lines, timeMs) {
    if (!Array.isArray(lines) || !Number.isFinite(timeMs)) return null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const start = Number(line.startTime);
      if (!Number.isFinite(start) || timeMs < start) continue;
      const end = Number.isFinite(Number(line.endTime)) ? Number(line.endTime) : Number(lines[i + 1]?.startTime);
      if (!Number.isFinite(end) || timeMs < end) return line.index;
    }
    return null;
  }

  function readCardStartMs(card) {
    const value = Number(card?.startMs ?? card?.startTime);
    return Number.isFinite(value) ? value : null;
  }

  function readCardEndMs(card, nextCard) {
    const ownEnd = Number(card?.endMs ?? card?.endTime);
    if (Number.isFinite(ownEnd)) return ownEnd;
    const nextStart = readCardStartMs(nextCard);
    return Number.isFinite(nextStart) ? nextStart : null;
  }

  function selectCardByPlaybackTime(currentMs, cards) {
    if (!Array.isArray(cards) || !cards.length || !Number.isFinite(Number(currentMs))) return null;
    const timeMs = Number(currentMs);
    let firstTimedIndex = null;
    let nearestStartedIndex = null;

    for (let i = 0; i < cards.length; i += 1) {
      const start = readCardStartMs(cards[i]);
      if (!Number.isFinite(start)) continue;
      if (firstTimedIndex === null) firstTimedIndex = i;
      if (timeMs < start) {
        return nearestStartedIndex === null ? firstTimedIndex : nearestStartedIndex;
      }
      const end = readCardEndMs(cards[i], cards[i + 1]);
      // If this is the last card and has no endMs, it covers to Infinity (end of song)
      if (!Number.isFinite(end) && i === cards.length - 1) return i;
      if (!Number.isFinite(end) || timeMs < end) return i;
      nearestStartedIndex = i;
    }

    return nearestStartedIndex ?? firstTimedIndex ?? 0;
  }

  // ── songId extraction ──
  // Returns a pure numeric string (e.g. "1806096519") or null.
  // Handles: plain digits, track-/song- prefix, pipe/underscore separators,
  // id=/songId: notation, and nested object shapes.

  const SONG_ID_FROM_STRING_RE = /(?:^|[|_\s])(?:track-|song-)?(\d{4,16})(?:[|_\s]|$)/;
  const SONG_ID_KV_RE = /(?:^|[|_\s])(?:id|songId|trackId|musicId)[=:]\s*(\d{4,16})(?:[|_\s]|$)/i;

  function extractDigits(input) {
    const text = String(input ?? "");
    const match = text.match(/(\d{4,16})/);
    return match ? match[1] : null;
  }

  function extractSongIdFromString(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    // Explicit track- / song- prefix
    const stripped = text.replace(/^(?:track|song)[-:]\s*/i, "");
    // Pipe-separated or underscore-separated: first segment might be the id
    const firstSegment = stripped.split(/[|_]/)[0].trim();
    // Check if first segment is a pure digit
    if (/^\d{4,16}$/.test(firstSegment)) return firstSegment;
    // Try id= / songId: / etc.
    const kvMatch = text.match(SONG_ID_KV_RE);
    if (kvMatch) return kvMatch[1];
    // Try the contextual regex
    const ctxMatch = text.match(SONG_ID_FROM_STRING_RE);
    if (ctxMatch) return ctxMatch[1];
    // Last resort: extract first digit run of length 4-16
    return extractDigits(text);
  }

  function extractSongIdFromObject(value) {
    if (!value || typeof value !== "object") return null;
    // Direct numeric/string fields
    const directKeys = ["id", "songId", "trackId", "musicId"];
    for (const key of directKeys) {
      const candidate = value[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) return String(Math.trunc(candidate));
      if (typeof candidate === "string") {
        const extracted = extractSongIdFromString(candidate);
        if (extracted) return extracted;
      }
    }
    // Boolean playing/paused — not songId, skip
    // Nested containers
    const containerKeys = ["data", "song", "track"];
    for (const key of containerKeys) {
      const nested = value[key];
      if (nested && typeof nested === "object") {
        const id = extractSongIdFromObject(nested);
        if (id) return id;
      }
    }
    return null;
  }

  function extractSongId(value) {
    let strategy = null;
    let id = null;
    if (typeof value === "string") {
      id = extractSongIdFromString(value);
      strategy = id ? "string" : null;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      id = String(Math.trunc(value));
      strategy = "number";
    } else if (value && typeof value === "object") {
      id = extractSongIdFromObject(value);
      strategy = id ? "object" : null;
    }
    return { id, strategy };
  }

  function extractSongIdOnly(value) {
    return extractSongId(value).id;
  }

  function extractSongIdFromArgs(argsLike) {
    const args = Array.from(argsLike || []);
    for (const arg of args) {
      const { id } = extractSongId(arg);
      if (id) return id;
    }
    return null;
  }

  function extractSongIdWithStrategyFromArgs(argsLike) {
    const args = Array.from(argsLike || []);
    let bestCandidate = null;
    let bestStrategy = null;
    for (const arg of args) {
      const { id, strategy } = extractSongId(arg);
      if (!id) continue;
      // Prefer string-based extraction over object-based (more explicit)
      if (!bestCandidate || (strategy === "string" && bestStrategy !== "string")) {
        bestCandidate = id;
        bestStrategy = strategy;
      }
      if (strategy === "string") break; // string is most explicit, stop scanning
    }
    return { id: bestCandidate, strategy: bestStrategy };
  }

  // ── PlayState status extraction ──

  const PLAYBACK_ACTIVE_WORDS = /^(?:resume|play|playing)$/i;
  const PLAYBACK_PAUSE_WORDS = /^(?:pause|paused)$/i;
  const PLAYBACK_STOP_WORDS = /^(?:stop|stopped)$/i;

  function extractPlaybackStatusFromString(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    // Direct status words
    if (PLAYBACK_PAUSE_WORDS.test(text)) return "pause";
    if (PLAYBACK_ACTIVE_WORDS.test(text)) return "resume";
    if (PLAYBACK_STOP_WORDS.test(text)) return "stop";
    // Pipe-separated: "1806096519|pause|xxx" or "track-1806096519|resume|xxx"
    const segments = text.split("|");
    for (let i = 1; i < segments.length; i += 1) {
      const seg = segments[i].trim();
      if (PLAYBACK_PAUSE_WORDS.test(seg)) return "pause";
      if (PLAYBACK_ACTIVE_WORDS.test(seg)) return "resume";
      if (PLAYBACK_STOP_WORDS.test(seg)) return "stop";
    }
    return null;
  }

  function extractPlaybackStatusFromObject(value) {
    if (!value || typeof value !== "object") return null;
    // Explicit status/state/action fields
    const statusFields = ["status", "state", "action", "type", "playbackStatus"];
    for (const key of statusFields) {
      const field = value[key];
      if (typeof field === "string") {
        const status = extractPlaybackStatusFromString(field);
        if (status) return status;
      }
    }
    // Boolean flags
    if (value.paused === true) return "pause";
    if (value.playing === true) return "resume";
    if (value.stopped === true) return "stop";
    return null;
  }

  function extractPlaybackStatusFromArgs(args) {
    for (const arg of args) {
      if (typeof arg === "string") {
        const status = extractPlaybackStatusFromString(arg);
        if (status) return status;
      } else if (arg && typeof arg === "object") {
        const status = extractPlaybackStatusFromObject(arg);
        if (status) return status;
      }
    }
    return null;
  }

  // ── Console songId candidate extraction ──
  // Extracts songId from AMLL-style console strings like:
  //   "1893590234_XIAY0O"  "560144_ZDX1YM"  "1840862630_FD9D1U"
  //   "track-1893590234"    "song-1840862630"
  // Does NOT extract from decimals like "9950.134" or "5110.49"

  const CONSOLE_SONG_ID_RE = /(?:^|[\s|_])(?:track-|song-)?(\d{5,16})(?:_[A-Z0-9]+)?(?:[\s|]|$)/;
  const CONSOLE_DECIMAL_RE = /\.\d/;

  function extractSongIdFromConsoleString(value) {
    const text = String(value ?? "").trim();
    if (!text || CONSOLE_DECIMAL_RE.test(text)) return null;
    // Explicit track-/song- prefix
    const stripped = text.replace(/^(?:track|song)[-:]\s*/i, "");
    const firstSegment = stripped.split(/[_|]/)[0].trim();
    if (/^\d{5,16}$/.test(firstSegment)) return firstSegment;
    // Contextual match
    const match = text.match(CONSOLE_SONG_ID_RE);
    return match ? match[1] : null;
  }

  function extractSongIdFromConsoleArgs(argsLike) {
    const args = Array.from(argsLike || []);
    for (const arg of args) {
      if (typeof arg === "string") {
        const id = extractSongIdFromConsoleString(arg);
        if (id) return id;
      }
    }
    return null;
  }

  // ── Args summary (safe, no long lyrics) ──

  function summarizeArg(arg) {
    if (arg == null) return String(arg);
    const type = typeof arg;
    if (type === "string") {
      const text = String(arg);
      return text.length <= 120 ? text : `${text.slice(0, 120)}…(${text.length})`;
    }
    if (type === "number" || type === "boolean") return arg;
    if (Array.isArray(arg)) return `Array(${arg.length})`;
    if (type === "object") {
      const keys = Object.keys(arg).slice(0, 20);
      const summary = { _type: "object", _keys: keys };
      // Copy small common fields (id, status, state, etc.)
      const safeKeys = ["id", "songId", "trackId", "musicId", "status", "state", "action", "type", "playbackStatus", "playing", "paused", "stopped"];
      for (const key of safeKeys) {
        if (key in arg) {
          const v = arg[key];
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            summary[key] = v;
          }
        }
      }
      return summary;
    }
    return `${type}`;
  }

  function summarizePlayStateArgs(args) {
    return Array.from(args || []).map(summarizeArg);
  }

  // ── Normalized songId ──
  // Strips track-/song- prefix and _XXXX suffix.
  //   track-1824020871 → 1824020871
  //   song-1824020871 → 1824020871
  //   1824020871_XXXX → 1824020871
  // Returns the original string if already pure digits.

  const TRACK_PREFIX_RE = /^(?:track|song)[-:]\s*/i;
  const PURE_DIGITS_RE = /^\d{4,16}$/;

  function normalizeSongId(raw) {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    const stripped = text.replace(TRACK_PREFIX_RE, "");
    const firstSegment = stripped.split(/[|_]/)[0].trim();
    if (PURE_DIGITS_RE.test(firstSegment)) return firstSegment;
    return null;
  }

  // ── Main parsePlayStateArgs ──

  function parsePlayStateArgs(argsLike) {
    const args = Array.from(argsLike || []);
    const { id: songId, strategy: songIdExtractStrategy } = extractSongIdWithStrategyFromArgs(args);
    const rawSongIdCandidate = args.length ? summarizeArg(args[0]) : null;
    const playbackStatus = extractPlaybackStatusFromArgs(args);
    const playStateArgsSummary = summarizePlayStateArgs(args);

    // Track normalization: was a track- prefix stripped?
    let normalizedTrackIdFrom = null;
    let normalizedTrackIdTo = null;
    if (songId && rawSongIdCandidate != null) {
      const rawText = typeof rawSongIdCandidate === "string" ? rawSongIdCandidate : "";
      if (/^(?:track|song)[-:]/i.test(rawText)) {
        normalizedTrackIdFrom = rawText.slice(0, 80);
        normalizedTrackIdTo = songId;
      }
    }

    return {
      songId,
      playbackStatus,
      playStateStatus: playbackStatus || "received",
      rawSongIdCandidate,
      songIdExtractStrategy: songIdExtractStrategy || null,
      playStateArgsSummary,
      normalizedTrackIdFrom,
      normalizedTrackIdTo
    };
  }

  function recordPlayStateArgs(argsLike, diagnostics) {
    const parsed = parsePlayStateArgs(argsLike);
    diagnostics?.recordPlayStateArgs?.(argsLike, parsed);
    return parsed;
  }

  function getCurrentSongId() {
    const Diagnostics = root.LyricLens?.Diagnostics;
    if (Diagnostics?.safeGetPlaying) {
      const playing = Diagnostics.safeGetPlaying(root);
      const playingId = playing.ok ? extractSongIdOnly(playing.value) : null;
      if (playingId) return playingId;
      const song = Diagnostics.safeGetPlayingSong(root);
      if (song.ok) return extractSongIdOnly(song.value);
      return null;
    }
    const ncm = root.betterncm?.ncm;
    if (!ncm) return null;
    try {
      const playing = ncm.getPlaying?.();
      if (playing?.id) return playing.id;
    } catch (err) {
      console.warn("[LyricLens]", "betterncm.ncm.getPlaying 探测失败", err);
    }
    try {
      const song = ncm.getPlayingSong?.();
      return song?.id ?? song?.data?.id ?? null;
    } catch (err) {
      console.warn("[LyricLens]", "betterncm.ncm.getPlayingSong 探测失败", err);
      return null;
    }
  }

  function startSongMonitor(onSongChange, onPlayState, diagnostics) {
    let lastSongId = null;
    let stopped = false;

    function check() {
      if (stopped) return;
      const currentId = getCurrentSongId();
      if (!currentId || currentId === lastSongId) return;
      lastSongId = currentId;
      console.log("[LyricLens]", "当前 songId", currentId);
      onSongChange(currentId);
    }

    function handlePlayStateEvent(...args) {
      diagnostics?.updateState?.({
        playStateEventCount: (diagnostics?.getState?.()?.playStateEventCount || 0) + 1,
        playStateLastEventAt: Date.now()
      });
      if (diagnostics?.enabled?.()) {
        console.log("[LyricLens:playstate]", "event", summarizePlayStateArgs(args));
      }
      const parsed = recordPlayStateArgs(args, diagnostics);
      // Notify playback status changes (pause/resume/stop)
      if (typeof onPlayState === "function") {
        onPlayState(parsed);
      }
      const eventSongId = parsed.songId;
      if (eventSongId && eventSongId !== lastSongId) {
        lastSongId = eventSongId;
        console.log("[LyricLens]", "当前 songId", eventSongId);
        onSongChange(eventSongId);
      } else {
        setTimeout(check, 0);
      }
    }

    let listenerRegistered = false;
    let registerError = null;
    const eventCleanup = [];
    const Diagnostics = root.LyricLens?.Diagnostics;
    if (Diagnostics?.safeAppendRegisterCall) {
      const result = Diagnostics.safeAppendRegisterCall(root, "PlayState", "audioplayer", handlePlayStateEvent);
      listenerRegistered = result.ok;
      registerError = result.ok ? null : (result.error || "register returned not-ok");
      if (!result.ok) {
        diagnostics?.log?.("PlayState register failed", result);
        if (diagnostics?.enabled?.()) console.log("[LyricLens:playstate]", "listener register FAILED", result);
      } else if (diagnostics?.enabled?.()) {
        console.log("[LyricLens:playstate]", "listener registered");
      }
    } else {
      const appendRegisterCall = root.legacyNativeCmder?.appendRegisterCall;
      if (typeof appendRegisterCall === "function") {
        try {
          appendRegisterCall("PlayState", "audioplayer", handlePlayStateEvent);
          listenerRegistered = true;
          if (diagnostics?.enabled?.()) console.log("[LyricLens:playstate]", "listener registered via legacyNativeCmder");
        } catch (err) {
          registerError = String(err?.message || err);
          console.warn("[LyricLens]", "PlayState 监听不可用，使用 polling", err);
        }
      }
    }
    diagnostics?.updateState?.({
      playStateListenerRegistered: listenerRegistered,
      playStateEventCount: 0,
      playStateLastEventAt: null,
      playStateLastError: registerError || null
    });

    const interval = setInterval(check, 1000);
    check();
    return function stopSongMonitor() {
      stopped = true;
      clearInterval(interval);
      eventCleanup.forEach((cleanup) => cleanup());
    };
  }

  function startProgressListener(onProgress, diagnostics) {
    const Diagnostics = root.LyricLens?.Diagnostics;
    if (Diagnostics?.safeAppendRegisterCall) {
      const result = Diagnostics.safeAppendRegisterCall(root, "PlayProgress", "audioplayer", (...args) => {
        diagnostics?.recordPlayProgressArgs?.(args);
        const timeMs = normalizeProgressMs(args);
        recordProgressEvent(diagnostics, args, timeMs);
        if (timeMs !== null) onProgress(timeMs, args);
      });
      if (!result.ok) {
        mergeTimeSourceCandidate(
          diagnostics,
          { name: "PlayProgress", status: "failed", trusted: true, reason: result.error || "register failed" },
          `playprogress-register-failed:${result.error || "unknown"}`
        );
        diagnostics?.log?.("PlayProgress register failed", result);
        console.warn("[LyricLens]", "legacyNativeCmder.appendRegisterCall 不可用，无法监听播放进度");
      } else {
        mergeTimeSourceCandidate(
          diagnostics,
          { name: "PlayProgress", status: "registered", trusted: true },
          null
        );
      }
      return () => {};
    }
    const appendRegisterCall = root.legacyNativeCmder?.appendRegisterCall;
    if (typeof appendRegisterCall !== "function") {
      mergeTimeSourceCandidate(
        diagnostics,
        { name: "PlayProgress", status: "failed", trusted: true, reason: "legacyNativeCmder.appendRegisterCall unavailable" },
        "playprogress-register-failed:not available"
      );
      console.warn("[LyricLens]", "legacyNativeCmder.appendRegisterCall 不可用，无法监听播放进度");
      return () => {};
    }
    try {
      appendRegisterCall("PlayProgress", "audioplayer", (...args) => {
        diagnostics?.recordPlayProgressArgs?.(args);
        const timeMs = normalizeProgressMs(args);
        recordProgressEvent(diagnostics, args, timeMs);
        if (timeMs !== null) onProgress(timeMs, args);
      });
      mergeTimeSourceCandidate(
        diagnostics,
        { name: "PlayProgress", status: "registered", trusted: true },
        null
      );
      return () => {};
    } catch (err) {
      mergeTimeSourceCandidate(
        diagnostics,
        { name: "PlayProgress", status: "failed", trusted: true, reason: String(err?.message || err).slice(0, 120) },
        `playprogress-register-failed:${String(err?.message || err).slice(0, 120)}`
      );
      console.warn("[LyricLens]", "PlayProgress 监听注册失败", err);
      return () => {};
    }
  }

  // Hook console.warn to intercept AMLL's "音乐播放进度跳变" messages.
  // Format: "[AMLL] [WARN] 音乐播放进度跳变 <trackMarker> <prev> <const> <current>"
  // The last number is the current playback time in seconds. This is the
  // ONLY signal we have when AMLL fails to find TTML lyrics and stops
  // updating --amll-player-time (its normal CSS-var channel goes dark).
  function installAmllWarningProbe(onAmllProgress) {
    const target = root.console;
    if (!target || typeof target.warn !== "function") return () => {};
    const origWarn = target.warn;
    let installed = true;
    const wrapped = function amllWarnProbe(...args) {
      if (installed) {
        try {
          let text = "";
          for (let i = 0; i < args.length; i += 1) {
            const a = args[i];
            text += (typeof a === "string" ? a : (a == null ? "" : String(a))) + " ";
            if (text.length > 400) break;
          }
          const marker = text.indexOf("音乐播放进度跳变");
          if (marker >= 0 && text.includes("[AMLL]")) {
            const tail = text.slice(marker);
            const nums = tail.match(/-?\d+\.?\d*/g);
            if (nums && nums.length >= 2) {
              const sec = parseFloat(nums[nums.length - 1]);
              if (Number.isFinite(sec) && sec >= 0 && sec < 100000) {
                try { onAmllProgress(Math.round(sec * 1000), args); } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }
      return origWarn.apply(target, args);
    };
    target.warn = wrapped;
    return function uninstall() {
      installed = false;
      if (target.warn === wrapped) target.warn = origWarn;
    };
  }

  const api = {
    normalizeProgressMs,
    getCurrentPlaybackMs,
    readTrustedPlaybackTime,
    findCurrentLineIndex,
    selectCardByPlaybackTime,
    extractSongId,
    extractSongIdOnly,
    extractSongIdFromString,
    extractSongIdFromObject,
    extractSongIdFromArgs,
    extractSongIdWithStrategyFromArgs,
    extractPlaybackStatusFromString,
    extractPlaybackStatusFromObject,
    extractPlaybackStatusFromArgs,
    extractSongIdFromConsoleString,
    extractSongIdFromConsoleArgs,
    normalizeSongId,
    summarizeArg,
    summarizePlayStateArgs,
    parsePlayStateArgs,
    recordPlayStateArgs,
    getCurrentSongId,
    startSongMonitor,
    startProgressListener,
    installAmllWarningProbe
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Sync = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

const test = require("node:test");
const assert = require("node:assert/strict");

// Sync module needs a minimal globalThis shim to load
global.globalThis = global;
global.window = global;

const Sync = require("../src/sync");

// ── songId extraction tests ──

test("extractSongIdFromString: plain digits", () => {
  assert.equal(Sync.extractSongIdFromString("1806096519"), "1806096519");
});

test("extractSongIdFromString: track- prefix", () => {
  assert.equal(Sync.extractSongIdFromString("track-1806096519"), "1806096519");
});

test("extractSongIdFromString: track- prefix with pipe", () => {
  assert.equal(Sync.extractSongIdFromString("track-1806096519|resume|xxx"), "1806096519");
});

test("extractSongIdFromString: underscore separator", () => {
  assert.equal(Sync.extractSongIdFromString("1806096519_xxxxxx"), "1806096519");
});

test("extractSongIdFromString: pipe separator with status", () => {
  assert.equal(Sync.extractSongIdFromString("1806096519|resume|xxxx"), "1806096519");
});

test("extractSongIdFromString: song- prefix", () => {
  assert.equal(Sync.extractSongIdFromString("song-1806096519"), "1806096519");
});

test("extractSongIdFromString: id= notation", () => {
  assert.equal(Sync.extractSongIdFromString("id=1806096519"), "1806096519");
});

test("extractSongIdFromString: songId: notation", () => {
  assert.equal(Sync.extractSongIdFromString("songId:1806096519"), "1806096519");
});

test("extractSongIdFromString: no digits returns null", () => {
  assert.equal(Sync.extractSongIdFromString("not-a-song-id"), null);
});

// ── Object extraction ──

test("extractSongIdFromObject: direct id number", () => {
  assert.equal(Sync.extractSongIdFromObject({ id: 1806096519 }), "1806096519");
});

test("extractSongIdFromObject: direct id string", () => {
  assert.equal(Sync.extractSongIdFromObject({ id: "1806096519" }), "1806096519");
});

test("extractSongIdFromObject: songId field", () => {
  assert.equal(Sync.extractSongIdFromObject({ songId: 1806096519 }), "1806096519");
});

test("extractSongIdFromObject: trackId field", () => {
  assert.equal(Sync.extractSongIdFromObject({ trackId: 1806096519 }), "1806096519");
});

test("extractSongIdFromObject: musicId field", () => {
  assert.equal(Sync.extractSongIdFromObject({ musicId: 1806096519 }), "1806096519");
});

test("extractSongIdFromObject: nested data.id", () => {
  assert.equal(Sync.extractSongIdFromObject({ data: { id: 1806096519 } }), "1806096519");
});

test("extractSongIdFromObject: nested song.id", () => {
  assert.equal(Sync.extractSongIdFromObject({ song: { id: 1806096519 } }), "1806096519");
});

test("extractSongIdFromObject: nested track.id", () => {
  assert.equal(Sync.extractSongIdFromObject({ track: { id: 1806096519 } }), "1806096519");
});

test("extractSongIdFromObject: no valid id returns null", () => {
  assert.equal(Sync.extractSongIdFromObject({ playing: true, paused: false }), null);
});

// ── extractSongId (unified) returns { id, strategy } ──

test("extractSongId: string returns id + 'string' strategy", () => {
  const result = Sync.extractSongId("track-1806096519");
  assert.deepEqual(result, { id: "1806096519", strategy: "string" });
});

test("extractSongId: number returns id + 'number' strategy", () => {
  const result = Sync.extractSongId(1806096519);
  assert.deepEqual(result, { id: "1806096519", strategy: "number" });
});

test("extractSongId: object returns id + 'object' strategy", () => {
  const result = Sync.extractSongId({ songId: 514774419 });
  assert.deepEqual(result, { id: "514774419", strategy: "object" });
});

test("extractSongId: null value returns null id + null strategy", () => {
  const result = Sync.extractSongId(null);
  assert.deepEqual(result, { id: null, strategy: null });
});

// ── extractSongIdOnly ──

test("extractSongIdOnly returns just the id string", () => {
  assert.equal(Sync.extractSongIdOnly("track-1806096519"), "1806096519");
  assert.equal(Sync.extractSongIdOnly(1806096519), "1806096519");
  assert.equal(Sync.extractSongIdOnly({ id: "1806096519" }), "1806096519");
  assert.equal(Sync.extractSongIdOnly(null), null);
});

// ── PlayState status extraction ──

test("extractPlaybackStatusFromString: pause", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("pause"), "pause");
});

test("extractPlaybackStatusFromString: paused", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("paused"), "pause");
});

test("extractPlaybackStatusFromString: resume", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("resume"), "resume");
});

test("extractPlaybackStatusFromString: play", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("play"), "resume");
});

test("extractPlaybackStatusFromString: playing", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("playing"), "resume");
});

test("extractPlaybackStatusFromString: stop", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("stop"), "stop");
});

test("extractPlaybackStatusFromString: stopped", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("stopped"), "stop");
});

test("extractPlaybackStatusFromString: pipe-separated", () => {
  assert.equal(Sync.extractPlaybackStatusFromString("1806096519|pause|xxx"), "pause");
  assert.equal(Sync.extractPlaybackStatusFromString("track-1806096519|resume|xxx"), "resume");
});

// ── PlayState object status ──

test("extractPlaybackStatusFromObject: status field", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ status: "pause" }), "pause");
});

test("extractPlaybackStatusFromObject: action field", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ action: "resume" }), "resume");
});

test("extractPlaybackStatusFromObject: state field", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ state: "playing" }), "resume");
});

test("extractPlaybackStatusFromObject: type field", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ type: "stop" }), "stop");
});

test("extractPlaybackStatusFromObject: playbackStatus field", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ playbackStatus: "pause" }), "pause");
});

test("extractPlaybackStatusFromObject: boolean paused", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ paused: true }), "pause");
});

test("extractPlaybackStatusFromObject: boolean playing", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ playing: true }), "resume");
});

test("extractPlaybackStatusFromObject: boolean stopped", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ stopped: true }), "stop");
});

test("extractPlaybackStatusFromObject: no status returns null", () => {
  assert.equal(Sync.extractPlaybackStatusFromObject({ foo: "bar" }), null);
});

// ── parsePlayStateArgs: combined songId + status ──

test("parsePlayStateArgs: track-songId with pause", () => {
  const result = Sync.parsePlayStateArgs(["track-1806096519|pause"]);
  assert.equal(result.songId, "1806096519");
  assert.equal(result.playbackStatus, "pause");
  assert.equal(result.songIdExtractStrategy, "string");
});

test("parsePlayStateArgs: plain songId + resume string", () => {
  const result = Sync.parsePlayStateArgs(["1806096519", "resume"]);
  assert.equal(result.songId, "1806096519");
  assert.equal(result.playbackStatus, "resume");
});

test("parsePlayStateArgs: only pause", () => {
  const result = Sync.parsePlayStateArgs(["pause"]);
  assert.equal(result.songId, null);
  assert.equal(result.playbackStatus, "pause");
});

test("parsePlayStateArgs: object with id and status", () => {
  const result = Sync.parsePlayStateArgs([{ id: 1806096519, status: "playing" }]);
  assert.equal(result.songId, "1806096519");
  assert.equal(result.playbackStatus, "resume");
  assert.equal(result.songIdExtractStrategy, "object");
});

test("parsePlayStateArgs: summary does not contain long content", () => {
  const longString = "x".repeat(500);
  const result = Sync.parsePlayStateArgs([longString, { id: 1806096519 }]);
  // Summary should be an array with each arg summarized
  assert.ok(Array.isArray(result.playStateArgsSummary));
  // The long string should be truncated
  const firstSummary = result.playStateArgsSummary[0];
  assert.ok(typeof firstSummary === "string");
  assert.ok(firstSummary.length <= 130); // 120 + "…(N)" suffix
});

test("startProgressListener records PlayProgress as a trusted time source", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  let callback = null;
  const state = {};
  const diagnostics = {
    recordPlayProgressArgs(args) {
      state.lastArgs = Array.from(args);
    },
    updateState(partial) {
      Object.assign(state, partial);
    },
    getState() {
      return { ...state };
    },
    log() {}
  };
  globalThis.LyricLens = {
    Diagnostics: {
      safeAppendRegisterCall(_root, eventName, targetName, cb) {
        assert.equal(eventName, "PlayProgress");
        assert.equal(targetName, "audioplayer");
        callback = cb;
        return { ok: true };
      }
    }
  };

  try {
    const observed = [];
    const stop = Sync.startProgressListener((timeMs) => observed.push(timeMs), diagnostics);
    assert.equal(typeof stop, "function");
    assert.ok(Array.isArray(state.timeSourceCandidates));
    assert.deepEqual(state.timeSourceCandidates[0], {
      name: "PlayProgress",
      status: "registered",
      trusted: true
    });
    assert.equal(state.timeSourceFailureReason, null);

    callback("ignored", 12.5);
    assert.deepEqual(observed, [12500]);
    assert.deepEqual(state.lastArgs, ["ignored", 12.5]);
    assert.equal(state.playProgressAcceptedMs, 12500);
    assert.equal(state.playProgressRejectedReason, null);
    stop();
  } finally {
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("startProgressListener marks PlayProgress event without milliseconds as invalid", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  let callback = null;
  const state = {};
  const diagnostics = {
    recordPlayProgressArgs(args) {
      state.lastArgs = Array.from(args);
    },
    updateState(partial) {
      Object.assign(state, partial);
    },
    getState() {
      return { ...state };
    },
    log() {}
  };
  globalThis.LyricLens = {
    Diagnostics: {
      safeAppendRegisterCall(_root, _eventName, _targetName, cb) {
        callback = cb;
        return { ok: true };
      }
    }
  };

  try {
    const observed = [];
    Sync.startProgressListener((timeMs) => observed.push(timeMs), diagnostics);
    callback({ event: "tick", value: "unusable" });
    assert.deepEqual(observed, []);
    assert.equal(state.playProgressAcceptedMs, null);
    assert.equal(state.playProgressRejectedReason, "no-progress-ms-in-event");
    assert.equal(state.timeSourceFailureReason, "playprogress-event-missing-ms");
    assert.equal(state.timeSourceCandidates.some((item) => (
      item.name === "PlayProgress" &&
      item.status === "invalid-value" &&
      item.trusted === true
    )), true);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
  }
});

test("startProgressListener records no-time-source failure when PlayProgress cannot register", () => {
  const previous = { LyricLens: globalThis.LyricLens };
  const state = {};
  const diagnostics = {
    updateState(partial) {
      Object.assign(state, partial);
    },
    getState() {
      return { ...state };
    },
    log() {}
  };
  globalThis.LyricLens = {
    Diagnostics: {
      safeAppendRegisterCall() {
        return { ok: false, error: "not available" };
      }
    }
  };

  try {
    Sync.startProgressListener(() => {}, diagnostics);
    assert.equal(state.timeSourceCandidates.some((item) => (
      item.name === "PlayProgress" &&
      item.status === "failed" &&
      item.trusted === true
    )), true);
    assert.equal(state.timeSourceFailureReason, "playprogress-register-failed:not available");
  } finally {
    globalThis.LyricLens = previous.LyricLens;
  }
});

// ── selectCardByPlaybackTime: last card with no endMs ──

test("selectCardByPlaybackTime: last card without endMs is selected at its startMs", () => {
  const cards = [
    { index: 0, startMs: 0, endMs: 5000 },
    { index: 1, startMs: 5000, endMs: 10000 },
    { index: 2, startMs: 10000 } // last card, no endMs
  ];
  // At 10000, should be card index 2
  assert.equal(Sync.selectCardByPlaybackTime(10000, cards), 2);
  // At 30000, well past all cards, should still be the last card
  assert.equal(Sync.selectCardByPlaybackTime(30000, cards), 2);
});

test("selectCardByPlaybackTime: normal mid-card selection", () => {
  const cards = [
    { index: 0, startMs: 0, endMs: 5000 },
    { index: 1, startMs: 5000, endMs: 10000 },
    { index: 2, startMs: 10000, endMs: 15000 }
  ];
  assert.equal(Sync.selectCardByPlaybackTime(3000, cards), 0);
  assert.equal(Sync.selectCardByPlaybackTime(7000, cards), 1);
  assert.equal(Sync.selectCardByPlaybackTime(12000, cards), 2);
});

test("selectCardByPlaybackTime: before first card returns 0", () => {
  const cards = [
    { index: 5, startMs: 5000, endMs: 10000 }
  ];
  assert.equal(Sync.selectCardByPlaybackTime(0, cards), 0);
  assert.equal(Sync.selectCardByPlaybackTime(2000, cards), 0);
});

// ── Console songId candidate extraction ──

test("extractSongIdFromConsoleString: AMLL underscore format", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("1893590234_XIAY0O"), "1893590234");
  assert.equal(Sync.extractSongIdFromConsoleString("560144_ZDX1YM"), "560144");
  assert.equal(Sync.extractSongIdFromConsoleString("1840862630_FD9D1U"), "1840862630");
});

test("extractSongIdFromConsoleString: plain digits", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("1893590234"), "1893590234");
});

test("extractSongIdFromConsoleString: track- prefix", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("track-1893590234"), "1893590234");
});

test("extractSongIdFromConsoleString: song- prefix", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("song-1840862630"), "1840862630");
});

test("extractSongIdFromConsoleString: pipe-separated with id", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("1893590234|some text"), "1893590234");
});

test("extractSongIdFromConsoleString: decimal numbers NOT extracted", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("9950.134"), null);
  assert.equal(Sync.extractSongIdFromConsoleString("5110.49"), null);
  assert.equal(Sync.extractSongIdFromConsoleString("12.345678"), null);
});

test("extractSongIdFromConsoleString: short numbers (< 5 digits) NOT extracted", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("1234_XXXX"), null);
  assert.equal(Sync.extractSongIdFromConsoleString("9999"), null);
});

test("extractSongIdFromConsoleString: non-id strings return null", () => {
  assert.equal(Sync.extractSongIdFromConsoleString("Hello World"), null);
  assert.equal(Sync.extractSongIdFromConsoleString(""), null);
  assert.equal(Sync.extractSongIdFromConsoleString("N/A"), null);
});

test("extractSongIdFromConsoleArgs: extracts from mixed args", () => {
  assert.equal(Sync.extractSongIdFromConsoleArgs(["1893590234_XIAY0O", 123, null]), "1893590234");
  assert.equal(Sync.extractSongIdFromConsoleArgs(["some text", "1840862630_FD9D1U"]), "1840862630");
  assert.equal(Sync.extractSongIdFromConsoleArgs([9950.134, "Hello"]), null);
});

// ── normalizeSongId ──

test("normalizeSongId: track- prefix", () => {
  assert.equal(Sync.normalizeSongId("track-1824020871"), "1824020871");
});

test("normalizeSongId: song- prefix", () => {
  assert.equal(Sync.normalizeSongId("song-1824020871"), "1824020871");
});

test("normalizeSongId: underscore suffix", () => {
  assert.equal(Sync.normalizeSongId("1824020871_XXXX"), "1824020871");
  assert.equal(Sync.normalizeSongId("2736357168_NXA8NF"), "2736357168");
});

test("normalizeSongId: plain digits", () => {
  assert.equal(Sync.normalizeSongId("1824020871"), "1824020871");
  assert.equal(Sync.normalizeSongId("1806096519"), "1806096519");
});

test("normalizeSongId: track- with pipe separator", () => {
  assert.equal(Sync.normalizeSongId("track-1824020871|pause"), "1824020871");
});

test("normalizeSongId: null/empty returns null", () => {
  assert.equal(Sync.normalizeSongId(null), null);
  assert.equal(Sync.normalizeSongId(""), null);
  assert.equal(Sync.normalizeSongId("   "), null);
});

test("normalizeSongId: non-id strings return null", () => {
  assert.equal(Sync.normalizeSongId("Hello World"), null);
  assert.equal(Sync.normalizeSongId("not-a-song-id"), null);
});

test("normalizeSongId: short numbers (< 4 digits) return null", () => {
  assert.equal(Sync.normalizeSongId("123"), null);
  assert.equal(Sync.normalizeSongId("9999"), "9999");
});

test("normalizeSongId: track-2736357168_NXA8NF", () => {
  assert.equal(Sync.normalizeSongId("track-2736357168_NXA8NF"), "2736357168");
});

const test = require("node:test");
const assert = require("node:assert/strict");

// These tests verify the autoFollow coordination logic from panel.js's
// createPanelState module. Since it depends on DOM/storage, we test the
// pure logic paths that don't need DOM.

// Load the Sync's selectCardByPlaybackTime for testing
global.globalThis = global;
global.window = global;
const Sync = require("../src/sync");

// ── Helper: a minimal panelState-like test harness ──

function createTestHarness() {
  let cards = [];
  let currentCardIndex = 0;
  let autoFollow = true;
  let autoFollowSuppressTimer = null;
  const AUTO_FOLLOW_SUPPRESS_MS = 3000;
  const manualNavigationCalls = [];
  const autoFollowChangedCalls = [];

  function resetForSongChange() {
    cards = [];
    currentCardIndex = 0;
    autoFollow = true;
    if (autoFollowSuppressTimer) {
      clearTimeout(autoFollowSuppressTimer);
      autoFollowSuppressTimer = null;
    }
  }

  function setCards(newCards) {
    cards = newCards.slice();
    currentCardIndex = Sync.selectCardByPlaybackTime(0, cards) ?? 0;
  }

  function selectByPlaybackTime(timeMs) {
    if (!autoFollow || !cards.length) return;
    const nextIndex = Sync.selectCardByPlaybackTime(timeMs, cards);
    if (nextIndex !== null && nextIndex !== currentCardIndex) {
      currentCardIndex = nextIndex;
    }
  }

  function manualNavigate(ordinal) {
    // Simulate: user clicks prev/next
    if (autoFollowSuppressTimer) clearTimeout(autoFollowSuppressTimer);
    autoFollow = false;
    manualNavigationCalls.push({ ordinal, at: Date.now() });
    autoFollowSuppressTimer = setTimeout(() => {
      autoFollow = true;
      autoFollowSuppressTimer = null;
      autoFollowChangedCalls.push({ value: true, reason: "timer-expired" });
    }, AUTO_FOLLOW_SUPPRESS_MS);
    if (ordinal >= 0 && ordinal < cards.length) {
      currentCardIndex = ordinal;
    }
    return currentCardIndex;
  }

  function manualToggleFollow(value) {
    autoFollow = Boolean(value);
    if (autoFollowSuppressTimer) {
      clearTimeout(autoFollowSuppressTimer);
      autoFollowSuppressTimer = null;
    }
    autoFollowChangedCalls.push({ value: autoFollow, reason: "manual-toggle" });
    return autoFollow;
  }

  return {
    getAutoFollow: () => autoFollow,
    getCurrentIndex: () => currentCardIndex,
    getCards: () => cards,
    manualNavigate,
    manualToggleFollow,
    selectByPlaybackTime,
    setCards,
    resetForSongChange,
    manualNavigationCalls,
    autoFollowChangedCalls
  };
}

// ── Tests ──

test("autoFollow: playback sync moves card index", () => {
  const h = createTestHarness();
  h.setCards([
    { index: 0, startMs: 0 },
    { index: 1, startMs: 5000 },
    { index: 2, startMs: 10000 }
  ]);
  // At 0ms → card 0
  assert.equal(h.getCurrentIndex(), 0);
  // At 6000ms → card 1
  h.selectByPlaybackTime(6000);
  assert.equal(h.getCurrentIndex(), 1);
  // At 12000ms → card 2
  h.selectByPlaybackTime(12000);
  assert.equal(h.getCurrentIndex(), 2);
});

test("autoFollow: manual navigation disables autoFollow", () => {
  const h = createTestHarness();
  h.setCards([
    { index: 0, startMs: 0 },
    { index: 1, startMs: 5000 },
    { index: 2, startMs: 10000 }
  ]);
  // Move to card 2 manually
  h.manualNavigate(2);
  assert.equal(h.getCurrentIndex(), 2);
  assert.equal(h.getAutoFollow(), false);
  // Playback sync should NOT override
  h.selectByPlaybackTime(3000); // would be card 0
  assert.equal(h.getCurrentIndex(), 2); // still at manual position
});

test("autoFollow: timer restores autoFollow after 3s", (_, done) => {
  const h = createTestHarness();
  h.setCards([
    { index: 0, startMs: 0 },
    { index: 1, startMs: 5000 }
  ]);
  h.manualNavigate(1);
  assert.equal(h.getAutoFollow(), false);
  // After 3100ms, autoFollow should be restored
  setTimeout(() => {
    assert.equal(h.getAutoFollow(), true);
    assert.ok(h.autoFollowChangedCalls.some((call) => call.reason === "timer-expired"));
    done();
  }, 3100);
});

test("autoFollow: manual toggle immediately restores", () => {
  const h = createTestHarness();
  h.setCards([
    { index: 0, startMs: 0 },
    { index: 1, startMs: 5000 }
  ]);
  h.manualNavigate(1);
  assert.equal(h.getAutoFollow(), false);
  // User clicks "跟随" button
  h.manualToggleFollow(true);
  assert.equal(h.getAutoFollow(), true);
  assert.ok(h.autoFollowChangedCalls.some((call) => call.reason === "manual-toggle"));
});

test("autoFollow: song change resets autoFollow to true", () => {
  const h = createTestHarness();
  h.setCards([
    { index: 0, startMs: 0 },
    { index: 1, startMs: 5000 }
  ]);
  h.manualNavigate(1);
  assert.equal(h.getAutoFollow(), false);
  // Song changes
  h.resetForSongChange();
  assert.equal(h.getAutoFollow(), true);
  assert.equal(h.getCurrentIndex(), 0);
});

// ── selectCardByPlaybackTime: last card Infinity ──

test("selectCardByPlaybackTime: last card without endMs behaves as Infinity", () => {
  const cards = [
    { index: 10, startMs: 30000, endMs: 35000 },
    { index: 11, startMs: 35000, endMs: 42000 },
    { index: 12, startMs: 42000 }  // last card, no endMs
  ];
  // At 42000, should be card 12
  assert.equal(Sync.selectCardByPlaybackTime(42000, cards), 2);
  // At 60000 (well past), should still be card 12, not null
  assert.equal(Sync.selectCardByPlaybackTime(60000, cards), 2);
  // Before 42000, should be card 11
  assert.equal(Sync.selectCardByPlaybackTime(40000, cards), 1);
});

// ── Playback progress jump ──

test("selectCardByPlaybackTime: big jump selects correct card", () => {
  const cards = [
    { index: 0, startMs: 0, endMs: 10000 },
    { index: 1, startMs: 10000, endMs: 20000 },
    { index: 2, startMs: 20000, endMs: 30000 },
    { index: 3, startMs: 30000, endMs: 40000 }
  ];
  // Jump from 0 to 35000
  assert.equal(Sync.selectCardByPlaybackTime(35000, cards), 3);
  // Jump back to 5000
  assert.equal(Sync.selectCardByPlaybackTime(5000, cards), 0);
});
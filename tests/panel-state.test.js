const test = require("node:test");
const assert = require("node:assert/strict");

// sync.js must be loaded first so that root.LyricLens.Sync.selectCardByPlaybackTime exists
require("../src/sync");
const Panel = require("../src/panel");

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    dump() {
      return Object.fromEntries(data.entries());
    }
  };
}

function makeDiagnostics() {
  const updates = [];
  return {
    updates,
    updateState(partial) {
      updates.push(partial);
    },
    merged() {
      return Object.assign({}, ...updates);
    }
  };
}

function cards() {
  return [
    { index: 0, lineIndex: 0, line: "Good morning, Night City", translation: "早上好，夜之城", startMs: 0, endMs: 1000 },
    { index: 1, lineIndex: 1, line: "Wake up", translation: "醒醒", startMs: 1000, endMs: 2000 },
    { index: 2, lineIndex: 2, line: "One more day", translation: "又一天", startMs: 2000, endMs: null }
  ];
}

test("panel state replaces old cards on analyze success", () => {
  const diagnostics = makeDiagnostics();
  const state = Panel.createPanelState({ diagnostics });

  state.setCards({ analyzeKey: "song-a", cards: cards().slice(0, 1), reason: "analyze-success" });
  state.setCards({
    analyzeKey: "song-b",
    cards: [{ index: 7, line: "Second song", translation: "第二首", startMs: 0 }],
    reason: "analyze-success"
  });

  const snapshot = state.getState();
  assert.equal(snapshot.displayedAnalyzeKey, "song-b");
  assert.equal(snapshot.displayedCardCount, 1);
  assert.equal(snapshot.cards[0].line, "Second song");
  assert.equal(diagnostics.merged().panelTextSample.includes("Second song"), true);
});

test("panel state reset clears stale cards and enters loading", () => {
  const diagnostics = makeDiagnostics();
  const state = Panel.createPanelState({ diagnostics });
  state.setCards({ analyzeKey: "song-a", cards: cards(), reason: "analyze-success" });

  state.resetForAnalyze("song-b", "analyze-key-changed");

  const snapshot = state.getState();
  assert.equal(snapshot.currentAnalyzeKey, "song-b");
  assert.equal(snapshot.displayedAnalyzeKey, null);
  assert.equal(snapshot.displayedCardCount, 0);
  assert.equal(snapshot.currentCardIndex, 0);
  assert.equal(snapshot.mode, "loading");
  assert.equal(diagnostics.merged().staleCardsCleared, true);
  assert.match(diagnostics.merged().panelTextSample, /正在分析当前歌词/);
});

test("panel state initializes and renders current card without index overflow", () => {
  const diagnostics = makeDiagnostics();
  const state = Panel.createPanelState({ diagnostics });
  state.setCards({ analyzeKey: "song-a", cards: cards(), initialIndex: 99, reason: "analyze-success" });

  assert.equal(state.getState().currentCardIndex, 2);
  state.renderCurrentCard("manual-render");
  const merged = diagnostics.merged();
  assert.equal(merged.panelLastRenderReason, "manual-render");
  assert.equal(merged.currentCardIndex, 2);
  assert.match(merged.panelTextSample, /One more day/);
});

test("manual navigation clamps at both ends", () => {
  const state = Panel.createPanelState();
  state.setCards({ analyzeKey: "song-a", cards: cards(), reason: "analyze-success" });

  assert.equal(state.prevCard("manual-prev"), 0);
  assert.equal(state.nextCard("manual-next"), 1);
  assert.equal(state.prevCard("manual-prev"), 0);
  assert.equal(state.nextCard("manual-next"), 1);
  assert.equal(state.nextCard("manual-next"), 2);
  assert.equal(state.nextCard("manual-next"), 2);
});

test("autoFollow=false prevents playback sync from replacing manual index", () => {
  const diagnostics = makeDiagnostics();
  const state = Panel.createPanelState({ diagnostics });
  state.setCards({ analyzeKey: "song-a", cards: cards(), reason: "analyze-success" });
  state.nextCard("manual-next");
  state.setAutoFollow(false);

  state.syncToPlayback(2500, "playback-sync");

  assert.equal(state.getState().currentCardIndex, 1);
  assert.equal(diagnostics.merged().autoFollow, false);
});

test("autoFollow=true lets playback sync update card index", () => {
  const state = Panel.createPanelState();
  state.setCards({ analyzeKey: "song-a", cards: cards(), reason: "analyze-success" });

  state.syncToPlayback(2500, "playback-sync");

  assert.equal(state.getState().currentCardIndex, 2);
});

test("panel state persists autoFollow and collapsed flags", () => {
  const storage = makeStorage();
  const state = Panel.createPanelState({ storage });
  state.setAutoFollow(false);
  state.setCollapsed(true);

  const restored = Panel.createPanelState({ storage });
  assert.equal(restored.getState().autoFollow, false);
  assert.equal(restored.getState().panelCollapsed, true);
  assert.equal(storage.getItem("ll_panel_auto_follow"), "false");
  assert.equal(storage.getItem("ll_panel_collapsed"), "true");
});

test("panel bounds are clamped and persisted when moved or resized", () => {
  const storage = makeStorage();
  const diagnostics = makeDiagnostics();
  const state = Panel.createPanelState({
    storage,
    diagnostics,
    viewport: () => ({ width: 800, height: 600 })
  });

  state.moveTo(9999, -50);
  state.resizeTo(100, 100);

  const snapshot = state.getState();
  assert.equal(snapshot.panelBounds.width, 320);
  assert.equal(snapshot.panelBounds.height, 220);
  assert.equal(snapshot.panelBounds.x <= 480, true);
  assert.equal(snapshot.panelBounds.y >= 0, true);
  assert.equal(storage.getItem("ll_panel_width"), "320");
  assert.equal(storage.getItem("ll_panel_height"), "220");
  assert.equal(diagnostics.merged().panelResizable, true);
});

test("stored panel position outside viewport is clamped on restore", () => {
  const storage = makeStorage({
    ll_panel_x: "2000",
    ll_panel_y: "2000",
    ll_panel_width: "500",
    ll_panel_height: "300"
  });
  const state = Panel.createPanelState({
    storage,
    viewport: () => ({ width: 900, height: 700 })
  });

  const bounds = state.getState().panelBounds;
  assert.deepEqual(bounds, { x: 400, y: 400, width: 500, height: 300 });
});

test("missing stored panel bounds use the designed default size", () => {
  const storage = makeStorage();
  const state = Panel.createPanelState({
    storage,
    viewport: () => ({ width: 1280, height: 720 })
  });

  assert.equal(state.getState().panelBounds.width, 420);
  assert.equal(state.getState().panelBounds.height, 360);
});

test("shouldStartPanelDrag ignores controls and accepts titlebar background", () => {
  const controlTarget = {
    closest(selector) {
      return selector.includes("button") ? {} : null;
    }
  };
  const titleTarget = {
    closest() {
      return null;
    }
  };

  assert.equal(Panel.shouldStartPanelDrag({ button: 0, target: controlTarget }), false);
  assert.equal(Panel.shouldStartPanelDrag({ button: 0, target: titleTarget }), true);
  assert.equal(Panel.shouldStartPanelDrag({ button: 1, target: titleTarget }), false);
});

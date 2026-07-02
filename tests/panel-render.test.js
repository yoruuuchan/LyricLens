const test = require("node:test");
const assert = require("node:assert/strict");

function createFakeDocument() {
  class FakeClassList {
    constructor(node) {
      this.node = node;
      this.values = new Set();
    }
    syncFromClassName(className) {
      this.values = new Set(String(className || "").split(/\s+/).filter(Boolean));
    }
    syncToClassName() {
      this.node._className = Array.from(this.values).join(" ");
    }
    add(name) { this.values.add(name); this.syncToClassName(); }
    remove(name) { this.values.delete(name); this.syncToClassName(); }
    toggle(name, force) {
      const shouldHave = force === undefined ? !this.values.has(name) : Boolean(force);
      if (shouldHave) this.values.add(name); else this.values.delete(name);
      this.syncToClassName();
      return shouldHave;
    }
  }

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.dataset = {};
      this.style = { setProperty: (name, value) => { this.style[name] = value; } };
      this.eventListeners = {};
      this._className = "";
      this._textContent = "";
      this.classList = new FakeClassList(this);
    }
    get className() { return this._className; }
    set className(value) {
      this._className = String(value || "");
      this.classList.syncFromClassName(this._className);
    }
    get textContent() {
      return this._textContent + this.children.map((child) => child.textContent || "").join("");
    }
    set textContent(value) { this._textContent = String(value ?? ""); }
    set innerHTML(value) {
      this.children = [];
      this._textContent = String(value || "");
    }
    appendChild(child) {
      if (child.tagName === "FRAGMENT" || child._isFragment) {
        child.children.forEach((c) => { c.parentNode = this; this.children.push(c); });
        return child;
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") this.id = String(value);
    }
    addEventListener(type, handler) { this.eventListeners[type] = handler; }
    click() { this.eventListeners.click?.({ stopPropagation: () => {}, preventDefault: () => {} }); }
    contains(node) {
      let cur = node;
      while (cur) { if (cur === this) return true; cur = cur.parentNode; }
      return false;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const result = [];
      const selectors = String(selector).split(",").map((item) => item.trim());
      const matches = (node) => selectors.some((item) => {
        if (item === '[class*="ll-"]') {
          return node.className.includes("ll-");
        }
        if (item === '[class^="ll-"]' || item === '[class*=" ll-"]') {
          return node.className.startsWith("ll-") || node.className.includes(" ll-");
        }
        if (item.startsWith(".")) {
          return String(node.className).split(/\s+/).includes(item.slice(1));
        }
        return false;
      });
      const visit = (node) => {
        if (matches(node)) result.push(node);
        node.children.forEach(visit);
      };
      this.children.forEach(visit);
      return result;
    }
  }

  const fragmentFactory = () => {
    const frag = new FakeElement("fragment");
    frag._isFragment = true;
    return frag;
  };

  const document = {
    body: new FakeElement("body"),
    head: new FakeElement("head"),
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (namespaceURI, tagName) => {
      const element = new FakeElement(tagName);
      element.namespaceURI = namespaceURI;
      return element;
    },
    createDocumentFragment: fragmentFactory,
    querySelector(selector) {
      return this.body.querySelector(selector) || this.head.querySelector(selector);
    },
    querySelectorAll(selector) {
      return [...this.body.querySelectorAll(selector), ...this.head.querySelectorAll(selector)];
    }
  };
  return document;
}

test("panel.showCard renders the card and records panel diagnostics", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener
  };
  const document = createFakeDocument();
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  const updates = [];
  const diagState = { apiStatus: "success" };
  globalThis.LyricLens = {
    diagnostics: {
      updateState: (partial) => {
        Object.assign(diagState, partial);
        updates.push(partial);
      },
      getState: () => ({ ...diagState })
    },
    Settings: { normalizeSettings: (s) => s || {} },
    Card: null
  };

  delete require.cache[require.resolve("../src/card")];
  delete require.cache[require.resolve("../src/panel")];
  require("../src/card");
  const { createPanel } = require("../src/panel");

  try {
    const panel = createPanel({
      settings: {
        panelTheme: "light",
        panelFontSize: "large",
        panelOpacity: 0.9
      },
      isDebugEnabled: () => false,
      getDiagnosticState: () => globalThis.LyricLens.diagnostics.getState()
    });

    const card = {
      index: 3,
      line: "Stay with me",
      translation: "陪着我",
      highlights: [
        { phrase: "stay with", meaning: "陪着" }
      ]
    };
    const analysis = {
      songId: "song-1",
      language: "en",
      lines: [{ index: 3, text: "Stay with me", startTime: 1000 }],
      cards: [card],
      cardsByIndex: new Map([[3, card]])
    };

    panel.setSongId("song-1");
    panel.showCard(analysis, 3);

    const panelNode = document.querySelector(".ll-panel");
    assert.equal(panelNode.dataset.theme, "light");
    assert.equal(panelNode.dataset.fontSize, "large");
    assert.equal(panelNode.style["--ll-panel-opacity"], "0.9");
    assert.equal(panelNode.querySelectorAll(".ll-resize-handle").length, 8);
    const settingsIcon = panelNode.querySelector(".ll-settings-button").children[0];
    assert.equal(settingsIcon.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(settingsIcon.children[0].namespaceURI, "http://www.w3.org/2000/svg");

    assert.equal(diagState.panelMounted, true, "panel should be marked mounted");
    assert.equal(diagState.panelVisible, true, "panel should be marked visible");
    assert.ok(diagState.llDomCount > 0, "llDomCount must be > 0");
    assert.match(String(diagState.panelTextSample || ""), /Stay with me/, "sample should include card text");

    panel.hide();
    assert.equal(diagState.panelVisible, false, "hide should mark panel as not visible");
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    delete require.cache[require.resolve("../src/card")];
    delete require.cache[require.resolve("../src/panel")];
  }
});

test("background updates do not kick the user out of the open settings form", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener
  };
  const document = createFakeDocument();
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  const diagState = {};
  globalThis.LyricLens = {
    diagnostics: {
      updateState: (partial) => { Object.assign(diagState, partial); },
      getState: () => ({ ...diagState })
    },
    Settings: { normalizeSettings: (s) => s || {} },
    Card: null
  };

  delete require.cache[require.resolve("../src/card")];
  delete require.cache[require.resolve("../src/panel")];
  require("../src/card");
  const { createPanel } = require("../src/panel");

  try {
    const panel = createPanel({
      settings: { panelTheme: "light", panelFontSize: "standard", panelOpacity: 0.96 },
      isDebugEnabled: () => false,
      getDiagnosticState: () => ({})
    });

    // Render a card first so the panel is mounted and visible.
    const card = { index: 0, line: "Hello", translation: "你好", highlights: [] };
    const analysis = {
      songId: "song-1",
      language: "en",
      lines: [{ index: 0, text: "Hello", startTime: 1000 }],
      cards: [card],
      cardsByIndex: new Map([[0, card]])
    };
    panel.setSongId("song-1");
    panel.showCard(analysis, 0);

    // User opens settings by clicking the settings button.
    const panelNode = document.querySelector(".ll-panel");
    const settingsButton = panelNode.querySelector(".ll-settings-button");
    settingsButton.eventListeners.click?.();

    // Settings form is now visible.
    assert.ok(panelNode.querySelector(".ll-settings-form"), "settings form should be rendered after click");
    const formBefore = panelNode.querySelector(".ll-settings-form");

    // Simulate background data updates that previously kicked the user out:
    panel.setCardsState({
      analyzeKey: "key-1",
      cards: [card, { index: 1, line: "World", translation: "世界", highlights: [] }],
      language: "en",
      analysis,
      reason: "stream-card"
    });
    panel.renderCardAt(0, "playback-sync");
    panel.showLoading("正在分析当前歌词...");
    panel.resetForAnalyze({ analyzeKey: null, reason: "song-change", message: "正在分析当前歌词..." });

    // Settings form must still be in the DOM after all those background updates.
    const formAfter = panelNode.querySelector(".ll-settings-form");
    assert.ok(formAfter, "settings form must survive background updates");
    assert.equal(formAfter, formBefore, "settings form DOM node must be the same instance — no rebuild");
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    delete require.cache[require.resolve("../src/card")];
    delete require.cache[require.resolve("../src/panel")];
  }
});

test("AI settings render learning preferences and regenerate custom prompt from knowledge points", async () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener
  };
  const document = createFakeDocument();
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  globalThis.LyricLens = {
    diagnostics: {
      updateState: () => {},
      getState: () => ({})
    },
    Card: null
  };

  delete require.cache[require.resolve("../src/settings")];
  delete require.cache[require.resolve("../src/api")];
  delete require.cache[require.resolve("../src/card")];
  delete require.cache[require.resolve("../src/panel")];
  require("../src/settings");
  require("../src/api");
  require("../src/card");
  const { createPanel } = require("../src/panel");

  try {
    let savedSettings = null;
    const panel = createPanel({
      settings: {
        panelTheme: "light",
        panelFontSize: "standard",
        panelOpacity: 0.96,
        targetLanguage: "中文",
        knowledgePoints: ["vocabulary", "grammar", "culture", "pronunciation", "tone"],
        customPrompt: ""
      },
      isDebugEnabled: () => false,
      getDiagnosticState: () => ({}),
      onSettingsSave: async (settings) => {
        savedSettings = settings;
        return settings;
      }
    });

    const card = { index: 0, line: "Hello", translation: "你好", highlights: [] };
    const analysis = {
      songId: "song-1",
      language: "en",
      lines: [{ index: 0, text: "Hello", startTime: 1000 }],
      cards: [card],
      cardsByIndex: new Map([[0, card]])
    };
    panel.setSongId("song-1");
    panel.showCard(analysis, 0);

    const panelNode = document.querySelector(".ll-panel");
    panelNode.querySelector(".ll-settings-button").eventListeners.click?.();
    panelNode.querySelectorAll(".ll-settings-tab")[1].eventListeners.click?.();

    assert.match(panelNode.textContent, /学习偏好/);
    assert.match(panelNode.textContent, /自定义 Prompt/);
    assert.equal(panelNode.querySelectorAll(".ll-knowledge-checkbox").length, 5);

    const textarea = panelNode.querySelector(".ll-prompt-textarea");
    assert.match(textarea.value, /Vocabulary:/);

    const vocabulary = panelNode.querySelectorAll(".ll-knowledge-checkbox")[0];
    vocabulary.checked = false;
    vocabulary.eventListeners.change?.();

    assert.doesNotMatch(textarea.value, /Vocabulary:/);
    assert.match(textarea.value, /Grammar:/);

    await panelNode.querySelector(".ll-settings-form").eventListeners.submit?.({ preventDefault() {} });
    assert.deepEqual(savedSettings.knowledgePoints, ["grammar", "culture", "pronunciation", "tone"]);
    assert.equal(savedSettings.customPrompt, textarea.value);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    delete require.cache[require.resolve("../src/settings")];
    delete require.cache[require.resolve("../src/api")];
    delete require.cache[require.resolve("../src/card")];
    delete require.cache[require.resolve("../src/panel")];
  }
});

test("custom prompt disclosure keeps open state and settings scroll position", () => {
  const previous = {
    LyricLens: globalThis.LyricLens,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    requestAnimationFrame: globalThis.requestAnimationFrame
  };
  const document = createFakeDocument();
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = (callback) => callback();

  globalThis.LyricLens = {
    diagnostics: {
      updateState: () => {},
      getState: () => ({})
    },
    Card: null
  };

  delete require.cache[require.resolve("../src/settings")];
  delete require.cache[require.resolve("../src/api")];
  delete require.cache[require.resolve("../src/card")];
  delete require.cache[require.resolve("../src/panel")];
  require("../src/settings");
  require("../src/api");
  require("../src/card");
  const { createPanel } = require("../src/panel");

  try {
    const panel = createPanel({
      settings: {
        panelTheme: "light",
        panelFontSize: "standard",
        panelOpacity: 0.96,
        targetLanguage: "中文",
        knowledgePoints: ["vocabulary", "grammar"],
        customPrompt: ""
      },
      isDebugEnabled: () => false,
      getDiagnosticState: () => ({})
    });

    const card = { index: 0, line: "Hello", translation: "你好", highlights: [] };
    const analysis = {
      songId: "song-1",
      language: "en",
      lines: [{ index: 0, text: "Hello", startTime: 1000 }],
      cards: [card],
      cardsByIndex: new Map([[0, card]])
    };
    panel.setSongId("song-1");
    panel.showCard(analysis, 0);

    const panelNode = document.querySelector(".ll-panel");
    panelNode.querySelector(".ll-settings-button").eventListeners.click?.();
    panelNode.querySelectorAll(".ll-settings-tab")[1].eventListeners.click?.();

    const body = panelNode.querySelector(".ll-settings-body");
    body.scrollTop = 140;
    const summary = panelNode.querySelector(".ll-prompt-summary");
    summary.eventListeners.click?.({ preventDefault() {} });

    assert.equal(panelNode.querySelector(".ll-prompt-details").classList.values.has("ll-is-open"), true);
    assert.equal(summary.attributes["aria-expanded"], "true");
    assert.equal(body.scrollTop, 140);

    panel.setUpdateState({ status: "checking" });
    const renderedBody = panelNode.querySelector(".ll-settings-body");
    assert.equal(panelNode.querySelector(".ll-prompt-details").classList.values.has("ll-is-open"), true);
    assert.equal(panelNode.querySelector(".ll-prompt-content").hidden, false);
    assert.equal(renderedBody.scrollTop, 140);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    delete require.cache[require.resolve("../src/settings")];
    delete require.cache[require.resolve("../src/api")];
    delete require.cache[require.resolve("../src/card")];
    delete require.cache[require.resolve("../src/panel")];
  }
});

// ── Notebook view + star hydration ──────────────────────────────

function withPanelHarness(run) {
  const previous = {
    LyricLens: globalThis.LyricLens,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener
  };
  const document = createFakeDocument();
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.LyricLens = {
    Settings: { normalizeSettings: (s) => s || {} }
  };
  delete require.cache[require.resolve("../src/card")];
  delete require.cache[require.resolve("../src/panel")];
  require("../src/card");
  const { createPanel } = require("../src/panel");
  try {
    run({ document, createPanel });
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    delete require.cache[require.resolve("../src/card")];
    delete require.cache[require.resolve("../src/panel")];
  }
}

// Async twin of withPanelHarness for tests that need to drain promise
// chains before the fake document is torn down.
async function withPanelHarnessAsync(run) {
  const previous = {
    LyricLens: globalThis.LyricLens,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener
  };
  const document = createFakeDocument();
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.LyricLens = {
    Settings: { normalizeSettings: (s) => s || {} }
  };
  delete require.cache[require.resolve("../src/card")];
  delete require.cache[require.resolve("../src/panel")];
  require("../src/card");
  const { createPanel } = require("../src/panel");
  try {
    await run({ document, createPanel });
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    delete require.cache[require.resolve("../src/card")];
    delete require.cache[require.resolve("../src/panel")];
  }
}

function makeNotebookEntryFixture(overrides = {}) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    songKey: "brave shine|aimer|234",
    songTitle: "Brave Shine",
    songArtist: "Aimer",
    lineIndex: 3,
    lineText: "強く眩しい光が",
    card: {
      index: 3, lineIndex: 3,
      original: "強く眩しい光が", translation: "强烈而耀眼的光",
      points: [{ type: "vocabulary", text: "眩しい: 耀眼的" }],
      note: "", startMs: 30000, endMs: 34000
    },
    userNote: "",
    starredAt: 1751400000000,
    updatedAt: 1751400000000,
    source: "plugin",
    mastery: "new",
    lastReviewedAt: null,
    ...overrides
  };
}

function makeFakeNotebook(entries) {
  const calls = { unstar: [], updateUserNote: [], removeMany: [] };
  return {
    calls,
    isReady: () => true,
    getDiagnostics: () => ({ status: "ready", count: entries.length }),
    listEntries: () => entries.slice(),
    getById: (id) => entries.find((e) => e.id === id) || null,
    getByBusinessKey: (songKey, lineIndex) =>
      entries.find((e) => e.songKey === songKey && e.lineIndex === lineIndex) || null,
    masteryTag: (mastery, lastReviewedAt) =>
      mastery === "new" || lastReviewedAt === null
        ? { cls: "mastery-new", text: "新加 · 从未复习" }
        : { cls: `mastery-${mastery}`, text: `${mastery} · reviewed` },
    MASTERY_TOOLTIP: "复习进度来自安卓单词本 app（read-only，插件端不编辑）",
    unstar: (id) => { calls.unstar.push(id); return true; },
    updateUserNote: (id, note) => { calls.updateUserNote.push([id, note]); return null; },
    removeMany: (ids) => { calls.removeMany.push(ids); return ids.length; }
  };
}

test("notebook button opens the view with entries, mastery tag, note editor", () => {
  withPanelHarness(({ document, createPanel }) => {
    const entry = makeNotebookEntryFixture({ userNote: "已有备注" });
    const fakeNotebook = makeFakeNotebook([entry]);
    globalThis.LyricLens.Notebook = fakeNotebook;

    const panel = createPanel({ settings: {}, isDebugEnabled: () => false });
    const card = { index: 3, lineIndex: 3, original: "強く眩しい光が", translation: "强烈而耀眼的光", highlights: [] };
    panel.showCard({ language: "ja", cards: [card], cardsByIndex: new Map([[3, card]]) }, 3);

    const panelNode = document.querySelector(".ll-panel");
    panelNode.querySelector(".ll-notebook-button").eventListeners.click();

    assert.ok(panelNode.querySelector(".ll-notebook"), "notebook view rendered");
    assert.match(panelNode.querySelector(".ll-nb-count").textContent, /1 条收藏/);
    assert.match(panelNode.querySelector(".ll-nb-song").textContent, /Brave Shine · Aimer/);
    assert.match(panelNode.querySelector(".ll-nb-line").textContent, /強く眩しい光が/);
    assert.match(panelNode.querySelector(".ll-nb-user-note").textContent, /已有备注/);
    const mastery = panelNode.querySelector(".ll-nb-mastery");
    assert.ok(mastery.classList.values.has("mastery-new"));
    assert.match(mastery.textContent, /新加 · 从未复习/);

    // Note editor: open → type → save routes through the store.
    const editBtn = panelNode
      .querySelectorAll(".ll-ghost-button")
      .find((b) => b.textContent === "编辑备注");
    editBtn.eventListeners.click();
    const textarea = panelNode.querySelector(".ll-nb-textarea");
    assert.ok(textarea, "editor textarea rendered");
    textarea.value = "新写的备注";
    textarea.eventListeners.input();
    const saveBtn = panelNode
      .querySelectorAll(".ll-secondary-button")
      .find((b) => b.textContent === "保存备注");
    saveBtn.eventListeners.click();
    assert.deepEqual(fakeNotebook.calls.updateUserNote, [[entry.id, "新写的备注"]]);
  });
});

test("notebook batch selection deletes via the two-step armed button", () => {
  withPanelHarness(({ document, createPanel }) => {
    const a = makeNotebookEntryFixture();
    const b = makeNotebookEntryFixture({
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", lineIndex: 7, lineText: "第二句"
    });
    const fakeNotebook = makeFakeNotebook([a, b]);
    globalThis.LyricLens.Notebook = fakeNotebook;

    const panel = createPanel({ settings: {}, isDebugEnabled: () => false });
    panel.showCard({ language: "ja", cards: [], cardsByIndex: new Map([[0, {}]]) }, 0);
    const panelNode = document.querySelector(".ll-panel");
    panelNode.querySelector(".ll-notebook-button").eventListeners.click();

    // Enter select mode, select all, arm, confirm.
    panelNode.querySelectorAll(".ll-ghost-button").find((x) => x.textContent === "批量选择").eventListeners.click();
    assert.equal(panelNode.querySelectorAll(".ll-nb-check").length, 2);
    panelNode.querySelectorAll(".ll-ghost-button").find((x) => x.textContent === "全选").eventListeners.click();
    let del = panelNode.querySelector(".ll-nb-delete");
    assert.equal(del.textContent, "删除选中");
    del.eventListeners.click();
    del = panelNode.querySelector(".ll-nb-delete");
    assert.match(del.textContent, /确认删除 2 条？/);
    del.eventListeners.click();
    assert.equal(fakeNotebook.calls.removeMany.length, 1);
    assert.deepEqual(new Set(fakeNotebook.calls.removeMany[0]), new Set([a.id, b.id]));
  });
});

test("notebook view degrades gracefully when the store failed", () => {
  withPanelHarness(({ document, createPanel }) => {
    globalThis.LyricLens.Notebook = {
      isReady: () => false,
      getDiagnostics: () => ({ status: "failed:indexedDB 不可用", count: 0 })
    };
    const panel = createPanel({ settings: {}, isDebugEnabled: () => false });
    panel.showCard({ language: "ja", cards: [], cardsByIndex: new Map([[0, {}]]) }, 0);
    const panelNode = document.querySelector(".ll-panel");
    panelNode.querySelector(".ll-notebook-button").eventListeners.click();
    assert.match(panelNode.querySelector(".ll-notebook").textContent, /笔记本存储不可用/);
  });
});

test("notebook toolbar exports via the store and shows the result line", async () => {
  await withPanelHarnessAsync(async ({ document, createPanel }) => {
    const entry = makeNotebookEntryFixture();
    const fakeNotebook = makeFakeNotebook([entry]);
    const exportCalls = [];
    fakeNotebook.exportToFile = async (format) => {
      exportCalls.push(format);
      return { ok: true, path: "C:/betterncm/lyriclens-exports/x.json", count: 1 };
    };
    fakeNotebook.importFromText = () => ({ ok: true, summary: { imported: 0, merged: 0, skipped: 0, errors: [] } });
    globalThis.LyricLens.Notebook = fakeNotebook;

    const panel = createPanel({ settings: {}, isDebugEnabled: () => false });
    panel.showCard({ language: "ja", cards: [], cardsByIndex: new Map([[0, {}]]) }, 0);
    const panelNode = document.querySelector(".ll-panel");
    panelNode.querySelector(".ll-notebook-button").eventListeners.click();

    const findButton = (label) =>
      panelNode.querySelectorAll(".ll-ghost-button").find((b) => b.textContent === label);
    assert.ok(findButton("导出 JSON"), "export json button present");
    assert.ok(findButton("导出 Anki"), "export anki button present");
    assert.ok(findButton("导入"), "import button present");

    findButton("导出 JSON").eventListeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exportCalls, ["json"]);
    const status = panelNode.querySelector(".ll-nb-status");
    assert.match(status.textContent, /已导出 1 条 · C:\/betterncm/);
    assert.ok(!status.classList.values.has("ll-is-error"));

    // Import button creates a detached file input; clicking it in the
    // fake DOM (no change event) must be a no-op, not a crash.
    findButton("导入").eventListeners.click();

    // Export failure path renders the error style.
    fakeNotebook.exportToFile = async () => ({ ok: false, error: "disk full" });
    findButton("导出 Anki").eventListeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    const errorStatus = panelNode.querySelector(".ll-nb-status");
    assert.match(errorStatus.textContent, /导出失败：disk full/);
    assert.ok(errorStatus.classList.values.has("ll-is-error"));
  });
});

test("card star slot hydrates from the store and routes toggles with busy lock", async () => {
  await withPanelHarnessAsync(async ({ document, createPanel }) => {
    const entry = makeNotebookEntryFixture();
    globalThis.LyricLens.Notebook = makeFakeNotebook([entry]);

    const toggles = [];
    let resolveToggle;
    const panel = createPanel({
      settings: {},
      isDebugEnabled: () => false,
      getNotebookSongKey: () => "brave shine|aimer|234",
      onStarToggle: (card, lineIndex) => {
        toggles.push(lineIndex);
        return new Promise((resolve) => { resolveToggle = resolve; });
      }
    });
    const starred = { index: 3, lineIndex: 3, original: "強く眩しい光が", translation: "光", highlights: [] };
    const fresh = { index: 5, lineIndex: 5, original: "別の行", translation: "另一行", highlights: [] };
    panel.showCard({
      language: "ja",
      cards: [starred, fresh],
      cardsByIndex: new Map([[3, starred], [5, fresh]])
    }, 3);

    const panelNode = document.querySelector(".ll-panel");
    let btn = panelNode.querySelector(".ll-star-btn");
    assert.ok(btn, "star button hydrated on the current card");
    assert.ok(btn.classList.values.has("ll-is-on"), "line 3 is starred in the store");

    btn.eventListeners.click({ stopPropagation() {} });
    assert.deepEqual(toggles, [3]);
    // While the async toggle is in flight the re-rendered button is busy.
    btn = panelNode.querySelector(".ll-star-btn");
    assert.equal(btn.disabled, true);
    // Settle the toggle and drain the .catch/.finally chain before the
    // harness tears the fake document down — the finally re-renders.
    resolveToggle();
    await new Promise((resolve) => setImmediate(resolve));
    btn = panelNode.querySelector(".ll-star-btn");
    assert.equal(btn.disabled, false, "busy lock released after toggle settles");
  });
});

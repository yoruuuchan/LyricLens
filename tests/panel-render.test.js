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

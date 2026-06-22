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

    add(name) {
      this.values.add(name);
      this.syncToClassName();
    }

    remove(name) {
      this.values.delete(name);
      this.syncToClassName();
    }

    toggle(name, force) {
      const shouldHave = force === undefined ? !this.values.has(name) : Boolean(force);
      if (shouldHave) this.values.add(name);
      else this.values.delete(name);
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

    get className() {
      return this._className;
    }

    set className(value) {
      this._className = String(value || "");
      this.classList.syncFromClassName(this._className);
    }

    get textContent() {
      return this._textContent + this.children.map((child) => child.textContent || "").join("");
    }

    set textContent(value) {
      this._textContent = String(value ?? "");
    }

    set innerHTML(value) {
      this.children = [];
      this._textContent = String(value || "");
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") this.id = String(value);
    }

    addEventListener(type, handler) {
      this.eventListeners[type] = handler;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const result = [];
      const selectors = String(selector).split(",").map((item) => item.trim());
      const matches = (node) => selectors.some((item) => {
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

  const document = {
    body: new FakeElement("body"),
    head: new FakeElement("head"),
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (namespaceURI, tagName) => {
      const element = new FakeElement(tagName);
      element.namespaceURI = namespaceURI;
      return element;
    },
    createDocumentFragment: () => new FakeElement("fragment"),
    querySelector(selector) {
      return this.body.querySelector(selector) || this.head.querySelector(selector);
    },
    querySelectorAll(selector) {
      return [...this.body.querySelectorAll(selector), ...this.head.querySelectorAll(selector)];
    }
  };
  return document;
}

test("debug panel mounts a ll DOM and reports no lyrics when normal data is unavailable", () => {
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
    Card: {
      el(tagName, className, text) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
      },
      renderMessage(message, className = "ll-empty") {
        const node = document.createElement("div");
        node.className = className;
        node.textContent = message;
        return node;
      }
    },
    Settings: {
      normalizeSettings: (settings) => settings || {}
    }
  };
  delete require.cache[require.resolve("../src/panel")];
  const { createPanel } = require("../src/panel");

  try {
    const panel = createPanel({
      settings: {},
      isDebugEnabled: () => true,
      getDiagnosticState: () => ({
        loaded: true,
        songId: null,
        getPlayingStatus: "error: Cannot read property 'data' of null",
        getPlayingSongStatus: "null",
        lyricsSource: "none",
        language: null,
        apiStatus: "idle",
        lastError: "Cannot read property 'data' of null",
        cssStatus: "inline-injected"
      })
    });

    assert.equal(typeof panel.mountDebugPanel, "function");
    panel.mountDebugPanel();

    assert.equal(document.querySelectorAll('[class^="ll-"], [class*=" ll-"]').length > 0, true);
    assert.match(document.body.textContent, /LyricLens loaded/);
    assert.match(document.body.textContent, /未获取到歌词/);
    assert.match(document.body.textContent, /inline-injected/);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    delete require.cache[require.resolve("../src/panel")];
  }
});

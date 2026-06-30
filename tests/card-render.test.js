const test = require("node:test");
const assert = require("node:assert/strict");

function createMinimalDocument() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.className = "";
      this.children = [];
      this._text = "";
    }
    appendChild(child) {
      if (child && child._isFragment) {
        child.children.forEach((c) => this.children.push(c));
        return child;
      }
      this.children.push(child);
      return child;
    }
    set textContent(value) { this._text = String(value ?? ""); }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent || "").join("");
    }
  }
  class Fragment {
    constructor() { this.children = []; this._isFragment = true; }
    appendChild(child) { this.children.push(child); return child; }
    get textContent() { return this.children.map((c) => c.textContent || "").join(""); }
    get all() {
      const out = [];
      const visit = (node) => {
        out.push(node);
        (node.children || []).forEach(visit);
      };
      this.children.forEach(visit);
      return out;
    }
  }
  return {
    createElement: (tag) => new Node(tag),
    createDocumentFragment: () => new Fragment()
  };
}

test("renderCard renders typed points with their Chinese type label", () => {
  const previous = { LyricLens: globalThis.LyricLens, document: globalThis.document };
  globalThis.document = createMinimalDocument();
  globalThis.LyricLens = {};
  delete require.cache[require.resolve("../src/card")];
  const { renderCard } = require("../src/card");

  try {
    const fragment = renderCard({
      index: 0,
      line: "I have a dream",
      translation: "我有一个梦想",
      highlights: [
        { type: "vocabulary", text: "have a dream → 有梦想" },
        { type: "tone", text: "强调坚定的语气" }
      ]
    }, "en");

    const all = fragment.all;
    const labels = all.filter((n) => n.className === "ll-highlight-type").map((n) => n.textContent);
    assert.deepEqual(labels, ["词汇", "语感"]);
    const meanings = all.filter((n) => n.className === "ll-meaning").map((n) => n.textContent);
    assert.deepEqual(meanings, ["have a dream → 有梦想", "强调坚定的语气"]);

    // "general" type renders no badge.
    delete require.cache[require.resolve("../src/card")];
    const { renderCard: render2 } = require("../src/card");
    const fragment2 = render2({
      index: 0,
      line: "Hello",
      translation: "你好",
      highlights: [{ type: "general", text: "plain remark" }]
    }, "en");
    const labels2 = fragment2.all.filter((n) => n.className === "ll-highlight-type");
    assert.equal(labels2.length, 0);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    delete require.cache[require.resolve("../src/card")];
  }
});

test("renderCard hides the 学习点 section entirely when highlights is empty", () => {
  const previous = { LyricLens: globalThis.LyricLens, document: globalThis.document };
  globalThis.document = createMinimalDocument();
  globalThis.LyricLens = {};
  delete require.cache[require.resolve("../src/card")];
  const { renderCard } = require("../src/card");

  try {
    const fragment = renderCard({
      index: 0,
      line: "It's only love",
      translation: "这仅仅是爱",
      highlights: [],
      note: "重复上一句，加强情感表达。"
    }, "en");
    const text = fragment.textContent;
    assert.doesNotMatch(text, /学习点/);
    assert.doesNotMatch(text, /语气和情绪/);
    assert.match(text, /重复上一句/);
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    delete require.cache[require.resolve("../src/card")];
  }
});

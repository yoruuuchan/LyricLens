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

// ── Dictionary badge slots + hydration ──────────────────────────
//
// Richer DOM stub than createMinimalDocument: badge code needs dataset,
// innerHTML-clearing, title, and class-based querySelectorAll.

function createBadgeDocument() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.className = "";
      this.children = [];
      this._text = "";
      this.dataset = {};
      this.title = "";
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
    set innerHTML(value) {
      if (value === "") this.children = [];
      else throw new Error("stub innerHTML only supports clearing");
    }
    hasClass(cls) {
      return String(this.className || "").split(/\s+/).includes(cls);
    }
    querySelectorAll(selector) {
      const cls = String(selector).replace(/^\./, "");
      const out = [];
      const visit = (n) => {
        if (n.hasClass && n.hasClass(cls)) out.push(n);
        (n.children || []).forEach(visit);
      };
      (this.children || []).forEach(visit);
      return out;
    }
  }
  class Fragment {
    constructor() { this.children = []; this._isFragment = true; }
    appendChild(child) { this.children.push(child); return child; }
  }
  return {
    createElement: (tag) => new Node(tag),
    createDocumentFragment: () => new Fragment(),
    makeContainer: () => new Node("div")
  };
}

function withBadgeHarness(run) {
  const previous = { LyricLens: globalThis.LyricLens, document: globalThis.document };
  const doc = createBadgeDocument();
  globalThis.document = doc;
  globalThis.LyricLens = {};
  delete require.cache[require.resolve("../src/dicts")];
  delete require.cache[require.resolve("../src/card")];
  const Dicts = require("../src/dicts");
  const Card = require("../src/card");
  try {
    run({ doc, Dicts, Card });
  } finally {
    globalThis.LyricLens = previous.LyricLens;
    globalThis.document = previous.document;
    delete require.cache[require.resolve("../src/dicts")];
    delete require.cache[require.resolve("../src/card")];
  }
}

test("renderHighlight emits dict slots only for vocabulary/grammar points with a surface", () => {
  withBadgeHarness(({ doc, Card }) => {
    const container = doc.makeContainer();
    container.appendChild(Card.renderHighlight({
      type: "vocabulary", text: "亡霊：亡灵", surface: "亡霊", reading: "ぼうれい"
    }, "ja"));
    container.appendChild(Card.renderHighlight({
      type: "culture", text: "文化背景说明", surface: "leak" // culture never gets slots
    }, "ja"));
    container.appendChild(Card.renderHighlight({
      type: "vocabulary", text: "无 surface 不出 slot"
    }, "ja"));

    const jlptSlots = container.querySelectorAll(".ll-jlpt-slot");
    assert.equal(jlptSlots.length, 1);
    assert.equal(jlptSlots[0].dataset.surface, "亡霊");
    assert.equal(jlptSlots[0].dataset.reading, "ぼうれい");
    assert.equal(container.querySelectorAll(".ll-enexam-slot").length, 1);
    assert.equal(container.querySelectorAll(".ll-cefrj-slot").length, 1);
  });
});

test("hydrateDictBadges fills slots from ready stores and respects targetExam", () => {
  withBadgeHarness(({ doc, Dicts, Card }) => {
    Dicts._setStoreForTest("jlpt", new Map([
      ["亡霊", [{ level: "N1", reading: "ぼうれい", source: "bluskyo", confidence: "source" }]]
    ]));
    Dicts._setStoreForTest("enexam", new Map([["abandon", ["gaokao", "cet4", "kaoyan"]]]));
    Dicts._setStoreForTest("cefrj", new Map([["abandon", "B1"]]));

    const container = doc.makeContainer();
    container.appendChild(Card.renderHighlight({
      type: "vocabulary", text: "亡霊：亡灵", surface: "亡霊", reading: "ぼうれい"
    }, "ja"));
    container.appendChild(Card.renderHighlight({
      type: "vocabulary", text: "abandon：抛弃", surface: "abandon"
    }, "en"));

    Card.hydrateDictBadges(container, { targetExam: "cet4" });

    const badges = container.querySelectorAll(".ll-dict-badge");
    const texts = badges.map((b) => b.textContent);
    assert.ok(texts.includes("JLPT N1"), `expected JLPT badge in ${JSON.stringify(texts)}`);
    assert.ok(texts.includes("CET-4"), `expected exam badge in ${JSON.stringify(texts)}`);
    assert.ok(texts.includes("B1"), `expected CEFR badge in ${JSON.stringify(texts)}`);
    // 亡霊 is Japanese — misses the all-English enexam/cefrj key space.
    assert.equal(texts.length, 3);

    // Switching exam to one the word doesn't carry removes the pill on re-hydrate
    Card.hydrateDictBadges(container, { targetExam: "cet6" });
    const after = container.querySelectorAll(".ll-dict-badge").map((b) => b.textContent);
    assert.ok(!after.includes("CET-4"));
    assert.ok(!after.some((t) => t === "CET-6"));
    assert.ok(after.includes("JLPT N1") && after.includes("B1"));

    // off clears every exam pill, other badges untouched
    Card.hydrateDictBadges(container, { targetExam: "off" });
    const offTexts = container.querySelectorAll(".ll-dict-badge").map((b) => b.textContent);
    assert.deepEqual(offTexts.sort(), ["B1", "JLPT N1"]);
  });
});

test("hydrateDictBadges with unready stores renders no badges and is safe to re-run", () => {
  withBadgeHarness(({ doc, Card }) => {
    const container = doc.makeContainer();
    container.appendChild(Card.renderHighlight({
      type: "vocabulary", text: "abandon：抛弃", surface: "abandon"
    }, "en"));
    Card.hydrateDictBadges(container, { targetExam: "cet4" });
    assert.equal(container.querySelectorAll(".ll-dict-badge").length, 0);
    // Idempotent re-run after nothing changed
    Card.hydrateDictBadges(container, { targetExam: "cet4" });
    assert.equal(container.querySelectorAll(".ll-dict-badge").length, 0);
  });
});

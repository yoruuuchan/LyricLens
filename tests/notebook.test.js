const test = require("node:test");
const assert = require("node:assert/strict");

// Notebook logic + store tests. Merge/export/Anki cases mirror the
// desktop host's notebook.rs test semantics so the two implementations
// stay byte-compatible; store CRUD runs against a fake persistence
// (the IDB wrapper is swapped via _setPersistenceForTest).

function freshNotebook() {
  const previous = globalThis.LyricLens;
  globalThis.LyricLens = {};
  delete require.cache[require.resolve("../src/notebook")];
  const Notebook = require("../src/notebook");
  return {
    Notebook,
    restore: () => {
      globalThis.LyricLens = previous;
      delete require.cache[require.resolve("../src/notebook")];
    }
  };
}

function makeFakePersistence(seed = []) {
  const rows = new Map(seed.map((e) => [e.id, e]));
  return {
    rows,
    log: [],
    async loadAll() {
      return Array.from(rows.values());
    },
    async put(entry) {
      rows.set(entry.id, entry);
      this.log.push(["put", entry.id]);
    },
    async remove(id) {
      rows.delete(id);
      this.log.push(["remove", id]);
    }
  };
}

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function makeCard(overrides = {}) {
  return {
    index: 3,
    lineIndex: 3,
    original: "強く眩しい光が",
    translation: "强烈而耀眼的光",
    points: [{ type: "vocabulary", text: "眩しい: 耀眼的", surface: "眩しい", reading: "まぶしい" }],
    note: "LLM 补充",
    startMs: 30000,
    endMs: 34000,
    ...overrides
  };
}

function makeEntry(overrides = {}) {
  return {
    id: UUID_A,
    songKey: "brave shine|aimer|234",
    songTitle: "Brave Shine",
    songArtist: "Aimer",
    lineIndex: 3,
    lineText: "強く眩しい光が",
    card: makeCard(),
    userNote: "",
    starredAt: 1000,
    updatedAt: 2000,
    source: "plugin",
    mastery: "new",
    lastReviewedAt: null,
    ...overrides
  };
}

// ── makeSongKey / ids / iso ─────────────────────────────────────────

test("makeSongKey trims, lowercases, rounds duration to seconds", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    assert.equal(
      Notebook.makeSongKey("  Brave Shine ", " Aimer ", 234499),
      "brave shine|aimer|234"
    );
    assert.equal(Notebook.makeSongKey("A", "B", 234500), "a|b|235");
  } finally {
    restore();
  }
});

test("newEntryId emits hyphenated uuid v4 and unique values", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const a = Notebook.newEntryId();
    const b = Notebook.newEntryId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(a, b);
  } finally {
    restore();
  }
});

test("toIsoSeconds matches desktop's seconds-precision RFC3339", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    assert.equal(Notebook.toIsoSeconds(Date.UTC(2026, 6, 2, 12, 34, 56, 789)), "2026-07-02T12:34:56Z");
  } finally {
    restore();
  }
});

// ── validateEntry ───────────────────────────────────────────────────

test("validateEntry accepts a complete entry and rejects each broken field", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    assert.equal(Notebook.validateEntry(makeEntry()), null);
    assert.match(Notebook.validateEntry(makeEntry({ id: "nope" })), /id is not a valid uuid/);
    assert.equal(Notebook.validateEntry(makeEntry({ songKey: "  " })), "songKey is empty");
    assert.equal(Notebook.validateEntry(makeEntry({ songTitle: "" })), "songTitle is empty");
    assert.equal(Notebook.validateEntry(makeEntry({ songArtist: " " })), "songArtist is empty");
    assert.match(Notebook.validateEntry(makeEntry({ lineIndex: -1 })), /lineIndex must be >= 0/);
    assert.equal(Notebook.validateEntry(makeEntry({ lineText: "" })), "lineText is empty");
    assert.match(
      Notebook.validateEntry(makeEntry({ starredAt: 3000, updatedAt: 2000 })),
      /starredAt \(3000\) must be <= updatedAt \(2000\)/
    );
    assert.match(Notebook.validateEntry(makeEntry({ source: "android" })), /source must be/);
    assert.match(Notebook.validateEntry(makeEntry({ mastery: "bogus" })), /mastery must be one of/);
    assert.match(
      Notebook.validateEntry(makeEntry({ lastReviewedAt: 0 })),
      /lastReviewedAt must be > 0 when set/
    );
    assert.match(
      Notebook.validateEntry(makeEntry({ importMergedFrom: ["nope"] })),
      /importMergedFrom contains invalid uuid/
    );
    assert.match(
      Notebook.validateEntry(makeEntry({ card: makeCard({ translation: 42 }) })),
      /card\.translation/
    );
    assert.match(
      Notebook.validateEntry(makeEntry({ card: makeCard({ points: [{ text: "x" }] }) })),
      /lacks type/
    );
  } finally {
    restore();
  }
});

// ── normalizeCardSnapshot ───────────────────────────────────────────

test("normalizeCardSnapshot strips legacy aliases and keeps surface/reading", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const snap = Notebook.normalizeCardSnapshot({
      index: 5,
      lineIndex: 5,
      line: "legacy line",
      original: "本命 original",
      translation: "译文",
      startTime: 1,
      endTime: 2,
      startMs: 1000,
      endMs: 2000,
      highlights: [{ type: "vocabulary", text: "词:义", surface: "词", reading: "" }],
      points: null,
      note: "n",
      extraJunk: true
    });
    assert.deepEqual(snap, {
      index: 5,
      lineIndex: 5,
      original: "本命 original",
      translation: "译文",
      points: [{ type: "vocabulary", text: "词:义", surface: "词" }],
      note: "n",
      startMs: 1000,
      endMs: 2000
    });
    // line-only legacy card + missing timing → original from line, nulls
    const bare = Notebook.normalizeCardSnapshot({ index: 0, line: "only line", points: [] });
    assert.equal(bare.original, "only line");
    assert.equal(bare.startMs, null);
    assert.equal(bare.endMs, null);
  } finally {
    restore();
  }
});

// ── mergeEntries (schema §合并规则, desktop merge_into semantics) ───

test("mergeEntries appends userNote with the exact separator marker", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const local = makeEntry({ userNote: "本地备注" });
    const incoming = makeEntry({
      id: UUID_B,
      source: "desktop",
      userNote: "对面备注",
      starredAt: 500,
      updatedAt: 1500
    });
    const ts = Date.UTC(2026, 6, 2, 12, 0, 0);
    const { outcome, entry } = Notebook.mergeEntries(local, incoming, ts);
    assert.equal(outcome, "merged");
    assert.equal(entry.id, UUID_A); // 1. id 保 local
    assert.equal(
      entry.userNote,
      "本地备注\n\n---来自 desktop（2026-07-02T12:00:00Z）---\n对面备注"
    );
    assert.equal(entry.starredAt, 500); // 4. 取更早
    assert.equal(entry.updatedAt, ts); // 5. import 时刻
    assert.deepEqual(entry.importMergedFrom, [UUID_B]); // 6. 追加
    assert.equal(entry.source, "plugin"); // 7. 不变
  } finally {
    restore();
  }
});

test("mergeEntries leaves local userNote alone when incoming note is empty", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const local = makeEntry({ userNote: "只有本地" });
    const incoming = makeEntry({ id: UUID_B, source: "desktop", userNote: "" });
    const { outcome, entry } = Notebook.mergeEntries(local, incoming, 5000);
    assert.equal(outcome, "merged");
    assert.equal(entry.userNote, "只有本地");
  } finally {
    restore();
  }
});

test("mergeEntries skips when the same import already happened (triple-AND)", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const incoming = makeEntry({ id: UUID_B, source: "desktop", userNote: "对面备注" });
    const alreadyMerged = makeEntry({
      userNote: "本地\n\n---来自 desktop（2026-07-01T00:00:00Z）---\n对面备注"
    });
    const { outcome } = Notebook.mergeEntries(alreadyMerged, incoming, 6000);
    assert.equal(outcome, "skipped");

    // Hand-written "---来自 desktop（" but different note text → real merge.
    const handWritten = makeEntry({ userNote: "我自己写过 ---来自 desktop（草稿）--- 这样的话" });
    const again = Notebook.mergeEntries(handWritten, incoming, 6000);
    assert.equal(again.outcome, "merged");
  } finally {
    restore();
  }
});

test("mergeEntries takes the newer card by updatedAt", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const local = makeEntry({ updatedAt: 2000, card: makeCard({ note: "local card" }) });
    const newer = makeEntry({
      id: UUID_B, source: "desktop", updatedAt: 3000, card: makeCard({ note: "newer card" })
    });
    assert.equal(Notebook.mergeEntries(local, newer, 9000).entry.card.note, "newer card");
    const older = makeEntry({
      id: UUID_B, source: "desktop", updatedAt: 1000, card: makeCard({ note: "older card" })
    });
    assert.equal(Notebook.mergeEntries(local, older, 9000).entry.card.note, "local card");
  } finally {
    restore();
  }
});

test("mergeEntries dedupes importMergedFrom (A→B→A loop guard)", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const local = makeEntry({ importMergedFrom: [UUID_B] });
    const incoming = makeEntry({ id: UUID_B, source: "desktop", userNote: "再来一次" });
    const { entry } = Notebook.mergeEntries(local, incoming, 9000);
    assert.deepEqual(entry.importMergedFrom, [UUID_B]);
  } finally {
    restore();
  }
});

test("mergeEntries mastery: authoritative timestamp is lastReviewedAt alone", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const N = (over) => makeEntry(over);
    const I = (over) => makeEntry({ id: UUID_B, source: "desktop", ...over });

    // 双 null → 保 local
    let r = Notebook.mergeEntries(N({}), I({}), 9000).entry;
    assert.equal(r.mastery, "new");
    assert.equal(r.lastReviewedAt, null);
    // 只 incoming 有 → 取 incoming
    r = Notebook.mergeEntries(N({}), I({ mastery: "yes", lastReviewedAt: 800 }), 9000).entry;
    assert.equal(r.mastery, "yes");
    assert.equal(r.lastReviewedAt, 800);
    // 只 local 有 → 保 local
    r = Notebook.mergeEntries(N({ mastery: "no", lastReviewedAt: 700 }), I({}), 9000).entry;
    assert.equal(r.mastery, "no");
    assert.equal(r.lastReviewedAt, 700);
    // 双有，incoming 更晚 → 取 incoming
    r = Notebook.mergeEntries(
      N({ mastery: "no", lastReviewedAt: 700 }),
      I({ mastery: "yes", lastReviewedAt: 900 }),
      9000
    ).entry;
    assert.equal(r.mastery, "yes");
    assert.equal(r.lastReviewedAt, 900);
    // 双有，incoming 更早 → 保 local（updatedAt 无关）
    r = Notebook.mergeEntries(
      N({ mastery: "meh", lastReviewedAt: 900, updatedAt: 100 }),
      I({ mastery: "yes", lastReviewedAt: 800, updatedAt: 99999 }),
      99999
    ).entry;
    assert.equal(r.mastery, "meh");
    assert.equal(r.lastReviewedAt, 900);
  } finally {
    restore();
  }
});

// ── export envelope ─────────────────────────────────────────────────

test("serializeEntry keeps desktop key order and omission rules", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const plain = Notebook.serializeEntry(makeEntry({ card: makeCard({ points: [{ type: "general", text: "t" }] }) }));
    assert.deepEqual(Object.keys(plain), [
      "id", "songKey", "songTitle", "songArtist", "lineIndex", "lineText",
      "card", "userNote", "starredAt", "updatedAt", "source", "mastery", "lastReviewedAt"
    ]);
    assert.equal("importMergedFrom" in plain, false); // omitted when absent
    assert.deepEqual(plain.card.points[0], { type: "general", text: "t" }); // surface/reading omitted
    assert.equal(plain.card.startMs, 30000);

    const merged = Notebook.serializeEntry(makeEntry({ importMergedFrom: [UUID_B] }));
    assert.deepEqual(Object.keys(merged).slice(-3), ["importMergedFrom", "mastery", "lastReviewedAt"]);
  } finally {
    restore();
  }
});

test("buildExportEnvelope emits the locked schema shape, starredAt DESC", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const older = makeEntry({ starredAt: 1000, updatedAt: 1000 });
    const newer = makeEntry({ id: UUID_B, lineIndex: 7, starredAt: 5000, updatedAt: 5000 });
    const envelope = Notebook.buildExportEnvelope([older, newer], Date.UTC(2026, 6, 2, 8, 0, 0));
    assert.equal(envelope.schema, "lyriclens.notebook.v1");
    assert.equal(envelope.exportedAt, "2026-07-02T08:00:00Z");
    assert.equal(envelope.exportedFrom, "plugin");
    assert.deepEqual(envelope.entries.map((e) => e.id), [UUID_B, UUID_A]);
  } finally {
    restore();
  }
});

// ── Anki TSV ────────────────────────────────────────────────────────

test("buildAnkiTsv formats Front/Back/Tags exactly like desktop", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const entry = makeEntry({ userNote: "我的\n多行备注" });
    const tsv = Notebook.buildAnkiTsv([entry]);
    const expectedFront = "Brave Shine — Aimer<br>強く眩しい光が";
    const expectedBack =
      "强烈而耀眼的光<br><br>词汇: 眩しい: 耀眼的<br><br>LLM 补充<br><br>---<br>我的<br>多行备注";
    const expectedTags = "lyriclens song:brave_shine_aimer_234 source:plugin";
    assert.equal(tsv, `${expectedFront}\t${expectedBack}\t${expectedTags}\n`);
  } finally {
    restore();
  }
});

test("buildAnkiTsv drops empty sections and escapes tabs", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const entry = makeEntry({
      userNote: "",
      card: makeCard({ points: [], note: "", translation: "只有\t翻译" })
    });
    const tsv = Notebook.buildAnkiTsv([entry]);
    const back = tsv.split("\t")[1];
    assert.equal(back, "只有 翻译"); // \t → space, no stray --- or <br>
    assert.equal(tsv.includes("---"), false);
  } finally {
    restore();
  }
});

test("buildAnkiTsv maps point labels incl. unknown → 其他", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const entry = makeEntry({
      card: makeCard({
        points: [
          { type: "grammar", text: "g" },
          { type: "mystery", text: "m" }
        ],
        note: "",
        translation: ""
      }),
      userNote: ""
    });
    const back = Notebook.buildAnkiTsv([entry]).split("\t")[1];
    assert.equal(back, "语法: g<br>其他: m");
  } finally {
    restore();
  }
});

// ── parseImportEnvelope ─────────────────────────────────────────────

test("parseImportEnvelope hard-rejects unknown schema, matches desktop wording", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    assert.throws(
      () => Notebook.parseImportEnvelope(JSON.stringify({ schema: "lyriclens.notebook.v2", entries: [] })),
      /unknown schema version: "lyriclens\.notebook\.v2" \(expected lyriclens\.notebook\.v1\)/
    );
    assert.throws(() => Notebook.parseImportEnvelope("not json"), /JSON 解析失败/);
    assert.throws(
      () => Notebook.parseImportEnvelope(JSON.stringify({ schema: "lyriclens.notebook.v1", entries: "x" })),
      /entries is not an array/
    );
    const ok = Notebook.parseImportEnvelope(
      JSON.stringify({ schema: "lyriclens.notebook.v1", exportedAt: "x", exportedFrom: "desktop", entries: [] })
    );
    assert.deepEqual(ok.entries, []);
  } finally {
    restore();
  }
});

// ── masteryTag ──────────────────────────────────────────────────────

test("masteryTag renders the four read-only states like desktop", () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const now = Date.UTC(2026, 6, 2, 12, 0, 0);
    assert.deepEqual(Notebook.masteryTag("new", null, now), { cls: "mastery-new", text: "新加 · 从未复习" });
    // lastReviewedAt null wins even with a non-new mastery (bad import lie-detector)
    assert.deepEqual(Notebook.masteryTag("yes", null, now), { cls: "mastery-new", text: "新加 · 从未复习" });
    assert.deepEqual(
      Notebook.masteryTag("yes", now - 1000, now),
      { cls: "mastery-yes", text: "记住了 · 今天过" }
    );
    assert.deepEqual(
      Notebook.masteryTag("meh", now - 86_400_000, now),
      { cls: "mastery-meh", text: "不确定 · 昨天过" }
    );
    assert.deepEqual(
      Notebook.masteryTag("no", now - 7 * 86_400_000, now),
      { cls: "mastery-no", text: "没记住 · 7 天前过" }
    );
  } finally {
    restore();
  }
});

// ── store: bootstrap / star / unstar / note / removeMany ───────────

test("store bootstrap loads rows, drops invalid ones, reports ready", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const good = makeEntry();
    const bad = makeEntry({ id: "broken", lineIndex: 9 });
    Notebook._setPersistenceForTest(makeFakePersistence([good, bad]));
    const diag = await Notebook.bootstrap();
    assert.equal(diag.status, "ready");
    assert.equal(diag.count, 1);
    assert.equal(Notebook.getByBusinessKey(good.songKey, good.lineIndex).id, UUID_A);
  } finally {
    restore();
  }
});

test("store bootstrap failure degrades: not ready, star returns null", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    Notebook._setPersistenceForTest({
      async loadAll() { throw new Error("idb dead"); },
      async put() {}, async remove() {}
    });
    const diag = await Notebook.bootstrap();
    assert.match(diag.status, /^failed:idb dead/);
    assert.equal(Notebook.isReady(), false);
    assert.equal(
      Notebook.starEntry({ songKey: "k|a|1", songTitle: "T", songArtist: "A", lineIndex: 0, lineText: "x", card: makeCard() }),
      null
    );
  } finally {
    restore();
  }
});

test("starEntry creates a fresh plugin-source entry and persists it", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const fake = makeFakePersistence();
    Notebook._setPersistenceForTest(fake);
    await Notebook.bootstrap();
    const entry = Notebook.starEntry(
      {
        songKey: "brave shine|aimer|234",
        songTitle: "Brave Shine",
        songArtist: "Aimer",
        lineIndex: 3,
        lineText: "強く眩しい光が",
        card: makeCard()
      },
      { nowMs: 4242 }
    );
    assert.match(entry.id, /^[0-9a-f-]{36}$/i);
    assert.equal(entry.source, "plugin");
    assert.equal(entry.mastery, "new");
    assert.equal(entry.lastReviewedAt, null);
    assert.equal(entry.starredAt, 4242);
    assert.equal(entry.updatedAt, 4242);
    assert.equal(entry.userNote, "");
    assert.equal(fake.rows.get(entry.id).id, entry.id);
    assert.equal(Notebook.count(), 1);
  } finally {
    restore();
  }
});

test("starEntry on business-key conflict preserves id/starredAt/mastery, refreshes card", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const existing = makeEntry({
      userNote: "旧备注", mastery: "yes", lastReviewedAt: 900, starredAt: 100, updatedAt: 200
    });
    Notebook._setPersistenceForTest(makeFakePersistence([existing]));
    await Notebook.bootstrap();
    const entry = Notebook.starEntry(
      {
        songKey: existing.songKey,
        songTitle: "Brave Shine (Live)",
        songArtist: "Aimer",
        lineIndex: existing.lineIndex,
        lineText: existing.lineText,
        card: makeCard({ note: "refreshed" })
      },
      { nowMs: 7777 }
    );
    assert.equal(entry.id, UUID_A);
    assert.equal(entry.starredAt, 100);
    assert.equal(entry.mastery, "yes");
    assert.equal(entry.lastReviewedAt, 900);
    assert.equal(entry.songTitle, "Brave Shine (Live)");
    assert.equal(entry.card.note, "refreshed");
    assert.equal(entry.updatedAt, 7777);
    assert.equal(Notebook.count(), 1);
  } finally {
    restore();
  }
});

test("unstar / unstarByBusinessKey / removeMany drop entries and persistence rows", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const a = makeEntry();
    const b = makeEntry({ id: UUID_B, lineIndex: 7 });
    const fake = makeFakePersistence([a, b]);
    Notebook._setPersistenceForTest(fake);
    await Notebook.bootstrap();
    assert.equal(Notebook.unstarByBusinessKey(a.songKey, a.lineIndex), true);
    assert.equal(Notebook.getByBusinessKey(a.songKey, a.lineIndex), null);
    assert.equal(Notebook.removeMany([UUID_B, "missing-id"]), 1);
    assert.equal(Notebook.count(), 0);
    assert.equal(fake.rows.size, 0);
  } finally {
    restore();
  }
});

test("updateUserNote bumps updatedAt and persists", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const fake = makeFakePersistence([makeEntry()]);
    Notebook._setPersistenceForTest(fake);
    await Notebook.bootstrap();
    const updated = Notebook.updateUserNote(UUID_A, "新备注", { nowMs: 9999 });
    assert.equal(updated.userNote, "新备注");
    assert.equal(updated.updatedAt, 9999);
    assert.equal(fake.rows.get(UUID_A).userNote, "新备注");
    assert.equal(Notebook.updateUserNote("missing", "x"), null);
  } finally {
    restore();
  }
});

test("listEntries returns starredAt DESC", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const older = makeEntry({ starredAt: 100, updatedAt: 100 });
    const newer = makeEntry({ id: UUID_B, lineIndex: 9, starredAt: 900, updatedAt: 900 });
    Notebook._setPersistenceForTest(makeFakePersistence([older, newer]));
    await Notebook.bootstrap();
    assert.deepEqual(Notebook.listEntries().map((e) => e.id), [UUID_B, UUID_A]);
  } finally {
    restore();
  }
});

// ── store: importEntries end-to-end ────────────────────────────────

test("importEntries handles new/merge/skip/invalid in one batch", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    const local = makeEntry({ userNote: "本地" });
    const fake = makeFakePersistence([local]);
    Notebook._setPersistenceForTest(fake);
    await Notebook.bootstrap();

    const conflictMerge = makeEntry({
      id: UUID_B, source: "desktop", userNote: "对面", starredAt: 50, updatedAt: 60
    });
    const freshEntry = makeEntry({
      id: "99999999-8888-4777-8666-555555555555",
      songKey: "other song|x|100",
      lineIndex: 0,
      source: "desktop"
    });
    const invalid = makeEntry({ id: "not-a-uuid", lineIndex: 42 });

    const envelope = {
      schema: "lyriclens.notebook.v1",
      entries: [conflictMerge, freshEntry, invalid]
    };
    const summary = Notebook.importEntries(envelope, { nowMs: Date.UTC(2026, 6, 2) });
    assert.deepEqual(
      { totalParsed: summary.totalParsed, imported: summary.imported, merged: summary.merged, skipped: summary.skipped },
      { totalParsed: 3, imported: 1, merged: 1, skipped: 1 }
    );
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /id is not a valid uuid/);

    const merged = Notebook.getByBusinessKey(local.songKey, local.lineIndex);
    assert.match(merged.userNote, /^本地\n\n---来自 desktop（2026-07-02T00:00:00Z）---\n对面$/);
    assert.equal(merged.id, UUID_A);
    // Second import of the same file: merge becomes skip, fresh becomes merge-noop path
    const second = Notebook.importEntries(envelope, { nowMs: Date.UTC(2026, 6, 3) });
    assert.equal(second.skipped >= 2, true); // duplicate-note skip + invalid
  } finally {
    restore();
  }
});

test("importEntries materializes v1 defaults (missing mastery fields)", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    Notebook._setPersistenceForTest(makeFakePersistence());
    await Notebook.bootstrap();
    const v1Entry = makeEntry();
    delete v1Entry.mastery;
    delete v1Entry.lastReviewedAt;
    const summary = Notebook.importEntries({ schema: "lyriclens.notebook.v1", entries: [v1Entry] });
    assert.equal(summary.imported, 1);
    const stored = Notebook.getById(UUID_A);
    assert.equal(stored.mastery, "new");
    assert.equal(stored.lastReviewedAt, null);
  } finally {
    restore();
  }
});

// ── cross-host fixture round-trip ───────────────────────────────────

test("a desktop-shaped export imports cleanly (field-name contract)", async () => {
  const { Notebook, restore } = freshNotebook();
  try {
    Notebook._setPersistenceForTest(makeFakePersistence());
    await Notebook.bootstrap();
    // Shaped exactly like desktop build_export_payload output: pretty
    // JSON, importMergedFrom omitted, explicit nulls on startMs/endMs.
    const desktopJson = JSON.stringify({
      schema: "lyriclens.notebook.v1",
      exportedAt: "2026-07-02T09:00:00Z",
      exportedFrom: "desktop",
      entries: [{
        id: UUID_B,
        songKey: "one last kiss|宇多田ヒカル|252",
        songTitle: "One Last Kiss",
        songArtist: "宇多田ヒカル",
        lineIndex: 2,
        lineText: "写真は苦手なんだ",
        card: {
          index: 2, lineIndex: 2,
          original: "写真は苦手なんだ",
          translation: "我不太擅长拍照",
          points: [{ type: "vocabulary", text: "苦手: 不擅长", surface: "苦手", reading: "にがて" }],
          note: "", startMs: null, endMs: null
        },
        userNote: "桌面写的",
        starredAt: 1751400000000,
        updatedAt: 1751400000000,
        source: "desktop",
        mastery: "meh",
        lastReviewedAt: 1751450000000
      }]
    }, null, 2);
    const envelope = Notebook.parseImportEnvelope(desktopJson);
    const summary = Notebook.importEntries(envelope, { nowMs: 1751500000000 });
    assert.deepEqual(
      { imported: summary.imported, merged: summary.merged, skipped: summary.skipped },
      { imported: 1, merged: 0, skipped: 0 }
    );
    const stored = Notebook.getById(UUID_B);
    assert.equal(stored.mastery, "meh");
    assert.equal(stored.source, "desktop"); // fresh import keeps origin source
    // And it round-trips back out with plugin envelope metadata intact.
    const out = Notebook.buildExportEnvelope(Notebook.listEntries(), 1751500000000);
    assert.equal(out.entries[0].card.points[0].reading, "にがて");
    assert.equal(out.exportedFrom, "plugin");
  } finally {
    restore();
  }
});

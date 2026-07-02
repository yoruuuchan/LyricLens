const test = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");

// Node 18+ provides global Response / DecompressionStream / crypto —
// the same surface dicts.js uses in NCM's Chromium, so the gzip and
// sha256 paths run for real here, only fetch is mocked.

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function makeFixture(entries, { corruptSha = false, omitGzip = false } = {}) {
  const envelope = {
    schema: 1,
    generated_at: "2026-07-02T00:00:00Z",
    license: "test",
    sources: { test: "abc1234" },
    entries
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"), { level: 9 });
  const manifest = {
    name: "test",
    schema: 1,
    latest: "test-abc1234.v1",
    generated_at: "2026-07-02T00:00:00Z",
    sources: {
      "test-abc1234.v1": {
        url: "https://example.test/blob.json.br",
        encoding: "br",
        sha256: "unused-br-sha",
        bytes: 1,
        ...(omitGzip ? {} : {
          gzip: {
            url: "https://example.test/blob.json.gz",
            sha256: corruptSha ? "0".repeat(64) : sha256Hex(gz),
            bytes: gz.length
          }
        })
      }
    }
  };
  return { manifest, gz };
}

// Enough entries to clear the structural sanity floor (MIN_ENTRIES).
function padEntries(realEntries, valueFactory) {
  const entries = { ...realEntries };
  for (let i = 0; Object.keys(entries).length < 120; i++) {
    entries[`pad-word-${i}`] = valueFactory(i);
  }
  return entries;
}

function makeFetchMock(byUrl) {
  return async (url) => {
    const hit = byUrl[url];
    if (!hit) return new Response("not found", { status: 404 });
    return hit();
  };
}

function freshDicts() {
  const previous = globalThis.LyricLens;
  globalThis.LyricLens = {};
  delete require.cache[require.resolve("../src/dicts")];
  const Dicts = require("../src/dicts");
  return {
    Dicts,
    restore: () => {
      globalThis.LyricLens = previous;
      delete require.cache[require.resolve("../src/dicts")];
    }
  };
}

const JLPT_ENTRIES = padEntries({
  "挨拶": [{ level: "N3", reading: "あいさつ", source: "bluskyo", confidence: "source" }],
  "年": [
    { level: "N5", reading: "とし", source: "bluskyo", confidence: "source" },
    { level: "N4", reading: "ねん", source: "bluskyo", confidence: "source" }
  ]
}, (i) => [{ level: "N1", reading: `よみ${i}`, source: "bluskyo", confidence: "source" }]);

const ENEXAM_ENTRIES = padEntries({
  abandon: ["gaokao", "cet4", "kaoyan"],
  abolish: ["gaokao", "cet6", "kaoyan"]
}, () => ["cet4"]);

const CEFRJ_ENTRIES = padEntries({
  above: "A1",
  abandon: "B1",
  "according to": "B1"
}, () => "B2");

function standardMock({ jlpt = {}, enexam = {}, cefrj = {} } = {}) {
  const j = makeFixture(JLPT_ENTRIES, jlpt);
  const e = makeFixture(ENEXAM_ENTRIES, enexam);
  const c = makeFixture(CEFRJ_ENTRIES, cefrj);
  // Manifests share fixture URLs; distinguish blobs per family.
  j.manifest.sources[j.manifest.latest].gzip &&
    (j.manifest.sources[j.manifest.latest].gzip.url = "https://example.test/jlpt.json.gz");
  e.manifest.sources[e.manifest.latest].gzip &&
    (e.manifest.sources[e.manifest.latest].gzip.url = "https://example.test/enexam.json.gz");
  c.manifest.sources[c.manifest.latest].gzip &&
    (c.manifest.sources[c.manifest.latest].gzip.url = "https://example.test/cefrj.json.gz");
  return makeFetchMock({
    "https://dicts.yoru-and-akari.dev/jlpt/manifest.json": () => new Response(JSON.stringify(j.manifest)),
    "https://dicts.yoru-and-akari.dev/enexam/manifest.json": () => new Response(JSON.stringify(e.manifest)),
    "https://dicts.yoru-and-akari.dev/cefrj/manifest.json": () => new Response(JSON.stringify(c.manifest)),
    "https://example.test/jlpt.json.gz": () => new Response(j.gz),
    "https://example.test/enexam.json.gz": () => new Response(e.gz),
    "https://example.test/cefrj.json.gz": () => new Response(c.gz)
  });
}

test("bootstrapAll loads all three families through gzip + sha256 and lookups answer", async () => {
  const { Dicts, restore } = freshDicts();
  try {
    const diag = await Dicts.bootstrapAll({ fetchImpl: standardMock() });
    assert.equal(diag.status.jlpt, "ready");
    assert.equal(diag.status.enexam, "ready");
    assert.equal(diag.status.cefrj, "ready");

    // jlpt: exact surface+reading match keeps stored confidence
    const exact = Dicts.jlptLookup("挨拶", "あいさつ");
    assert.equal(exact.length, 1);
    assert.equal(exact[0].level, "N3");
    assert.equal(exact[0].confidence, "source");

    // jlpt: reading mismatch downgrades every candidate
    const mismatch = Dicts.jlptLookup("年", "のし");
    assert.equal(mismatch.length, 2);
    assert.ok(mismatch.every((e) => e.confidence === "source-surface"));

    // jlpt: reading matching one of several narrows to it
    const narrowed = Dicts.jlptLookup("年", "ねん");
    assert.equal(narrowed.length, 1);
    assert.equal(narrowed[0].level, "N4");

    // jlpt: no reading given returns candidates as stored
    const noReading = Dicts.jlptLookup("年");
    assert.equal(noReading.length, 2);
    assert.ok(noReading.every((e) => e.confidence === "source"));

    // enexam: lowercase exact, full tag list, miss is []
    assert.deepEqual(Dicts.enexamLookup("Abandon"), ["gaokao", "cet4", "kaoyan"]);
    assert.deepEqual(Dicts.enexamLookup("nonexistent"), []);

    // cefrj: lowercase exact incl. phrases, miss is null
    assert.equal(Dicts.cefrjLookup("Above"), "A1");
    assert.equal(Dicts.cefrjLookup("according to"), "B1");
    assert.equal(Dicts.cefrjLookup("nonexistent"), null);
  } finally {
    restore();
  }
});

test("sha256 mismatch fails that family only; store stays empty", async () => {
  const { Dicts, restore } = freshDicts();
  try {
    const diag = await Dicts.bootstrapAll({ fetchImpl: standardMock({ cefrj: { corruptSha: true } }) });
    assert.equal(diag.status.jlpt, "ready");
    assert.match(diag.status.cefrj, /^failed:/);
    assert.equal(Dicts.cefrjLookup("above"), null);
    // Sibling families are unaffected.
    assert.equal(Dicts.jlptLookup("挨拶", "あいさつ").length, 1);
  } finally {
    restore();
  }
});

test("manifest without a gzip variant degrades to an empty store", async () => {
  const { Dicts, restore } = freshDicts();
  try {
    const diag = await Dicts.bootstrapAll({ fetchImpl: standardMock({ enexam: { omitGzip: true } }) });
    assert.match(diag.status.enexam, /^failed:.*gzip/);
    assert.deepEqual(Dicts.enexamLookup("abandon"), []);
  } finally {
    restore();
  }
});

test("truncated-but-parseable envelope is rejected by the entry-count floor", async () => {
  const { Dicts, restore } = freshDicts();
  try {
    const tiny = makeFixture({ only: "A1" });
    tiny.manifest.sources[tiny.manifest.latest].gzip.url = "https://example.test/tiny.json.gz";
    const fetchImpl = makeFetchMock({
      "https://dicts.yoru-and-akari.dev/cefrj/manifest.json": () => new Response(JSON.stringify(tiny.manifest)),
      "https://example.test/tiny.json.gz": () => new Response(tiny.gz)
    });
    const diag = await Dicts.bootstrapAll({ fetchImpl });
    assert.match(diag.status.cefrj, /^failed:.*疑似截断/);
    // jlpt/enexam manifests 404 in this mock — also failed, never thrown.
    assert.match(diag.status.jlpt, /^failed:/);
  } finally {
    restore();
  }
});

test("missing DecompressionStream degrades to failed store without throwing", async () => {
  const { Dicts, restore } = freshDicts();
  const originalDS = globalThis.DecompressionStream;
  try {
    delete globalThis.DecompressionStream;
    const diag = await Dicts.bootstrapAll({ fetchImpl: standardMock() });
    assert.match(diag.status.jlpt, /^failed:.*DecompressionStream/);
    assert.deepEqual(Dicts.jlptLookup("挨拶"), []);
  } finally {
    globalThis.DecompressionStream = originalDS;
    restore();
  }
});

test("formatJlptBadgeLabel and ambiguity marker match the desktop rules", () => {
  const { Dicts, restore } = freshDicts();
  try {
    assert.equal(Dicts.formatJlptBadgeLabel([]), null);
    assert.equal(
      Dicts.formatJlptBadgeLabel([{ level: "N5", confidence: "source" }]),
      "JLPT N5"
    );
    // Ascending by N-number, deduplicated
    assert.equal(
      Dicts.formatJlptBadgeLabel([
        { level: "N4", confidence: "source" },
        { level: "N3", confidence: "source" },
        { level: "N4", confidence: "source" }
      ]),
      "JLPT N3 / N4"
    );
    assert.equal(Dicts.jlptAmbiguityMarker([{ level: "N5", confidence: "source" }]), null);
    assert.equal(
      Dicts.jlptAmbiguityMarker([
        { level: "N5", confidence: "source" },
        { level: "N4", confidence: "source-surface" }
      ]),
      "*"
    );
  } finally {
    restore();
  }
});

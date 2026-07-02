const test = require("node:test");
const assert = require("node:assert/strict");

// Song-detail resolution for the notebook songKey: URL recipes, shape
// normalization across both endpoint generations, and the v1→v3
// fallback that never throws (per-endpoint failures are warned, the
// caller only sees meta-or-null).

function freshNcmApi() {
  const previous = globalThis.LyricLens;
  globalThis.LyricLens = {};
  delete require.cache[require.resolve("../src/ncmLyricApi")];
  const NcmLyricApi = require("../src/ncmLyricApi");
  return {
    NcmLyricApi,
    restore: () => {
      globalThis.LyricLens = previous;
      delete require.cache[require.resolve("../src/ncmLyricApi")];
    }
  };
}

test("detail URLs carry os=osx and refuse provisional ids", () => {
  const { NcmLyricApi, restore } = freshNcmApi();
  try {
    assert.equal(
      NcmLyricApi.buildDetailApiUrl("12345"),
      "https://music.163.com/api/song/detail?os=osx&ids=[12345]"
    );
    assert.equal(
      NcmLyricApi.buildDetailApiV3Url("12345"),
      'https://music.163.com/api/v3/song/detail?os=osx&c=[{"id":12345}]'
    );
    assert.equal(NcmLyricApi.buildDetailApiUrl("captured:abc"), null);
    assert.equal(NcmLyricApi.buildDetailApiV3Url(null), null);
  } finally {
    restore();
  }
});

test("normalizeSongDetail accepts both v1 and v3 shapes, joins artists with ' / '", () => {
  const { NcmLyricApi, restore } = freshNcmApi();
  try {
    assert.deepEqual(
      NcmLyricApi.normalizeSongDetail({
        name: "Brave Shine",
        artists: [{ name: "Aimer" }, { name: "EGOIST" }],
        duration: 234499
      }),
      { title: "Brave Shine", artist: "Aimer / EGOIST", durationMs: 234499 }
    );
    assert.deepEqual(
      NcmLyricApi.normalizeSongDetail({ name: "One Last Kiss", ar: [{ name: "宇多田ヒカル" }], dt: 252000 }),
      { title: "One Last Kiss", artist: "宇多田ヒカル", durationMs: 252000 }
    );
    // Missing pieces → null, never a partial meta.
    assert.equal(NcmLyricApi.normalizeSongDetail({ name: "x", ar: [], dt: 1000 }), null);
    assert.equal(NcmLyricApi.normalizeSongDetail({ name: "", ar: [{ name: "a" }], dt: 1000 }), null);
    assert.equal(NcmLyricApi.normalizeSongDetail(null), null);
  } finally {
    restore();
  }
});

test("fetchSongDetail falls back v1→v3 and returns null (no throw) when both fail", async () => {
  const { NcmLyricApi, restore } = freshNcmApi();
  try {
    const seen = [];
    const v3Only = async (url) => {
      seen.push(url);
      if (url.includes("/api/v3/")) {
        return new Response(JSON.stringify({
          code: 200,
          songs: [{ name: "Song", ar: [{ name: "Artist" }], dt: 180000 }]
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const meta = await NcmLyricApi.fetchSongDetail("777", { fetchImpl: v3Only });
    assert.deepEqual(meta, { title: "Song", artist: "Artist", durationMs: 180000 });
    assert.equal(seen.length, 2);
    assert.match(seen[0], /api\/song\/detail\?os=osx/);
    assert.match(seen[1], /api\/v3\/song\/detail\?os=osx/);

    const allDead = async () => new Response("nope", { status: 404 });
    const missed = await NcmLyricApi.fetchSongDetail("777", { fetchImpl: allDead });
    assert.equal(missed, null);

    // Provisional id: no URL to try, quiet null.
    const untouched = await NcmLyricApi.fetchSongDetail("captured:abc", { fetchImpl: allDead });
    assert.equal(untouched, null);
  } finally {
    restore();
  }
});

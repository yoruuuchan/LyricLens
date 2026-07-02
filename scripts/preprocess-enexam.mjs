#!/usr/bin/env node
// Preprocess Chinese English-exam vocabulary sources into the compact
// word → tags[] JSON envelope + brotli blob + manifest.json shape locked
// in docs/schema/en-exam-vocab.md.
//
// Three upstream sources (all MIT, verified 2026-07-02):
//   JavaProgrammerLB/cet-word-list  word-list.txt — 2016 CET syllabus OCR,
//                                   CET4/CET6 merged, level markers lost
//   skywind3000/ECDICT              ecdict.csv — `tag` column (space-
//                                   separated: zk gk cet4 cet6 ky ...)
//                                   acts as the leveler for both lists
//   pluto0x0/word3500               3500.txt — gaokao 3500 headwords in
//                                   3-line groups (word / [IPA] / gloss)
//
// Cross-verification rules (see schema doc §双源互证构建规则):
//   cet4   = clean(cet-word-list) ∩ ECDICT[tag∋cet4]
//   cet6   = clean(cet-word-list) ∩ ECDICT[tag∋cet6] − cet4
//   gaokao = clean(word3500 headwords) ∩ ECDICT[tag∋gk]
//   kaoyan = ECDICT[tag∋ky]           (sole distributable source; the
//            NETEM syllabus count 5530 is used as a coverage check only —
//            NETEM data itself is CC BY-NC-SA and never enters the pipeline)
//
// Words present in a roster list but not confirmed by ECDICT are dropped
// and recorded in dropped.txt with a reason — never silently. Measured
// baseline (2026-07-02, cet-word-list@8f811cb ECDICT@bc015ed word3500@7af7d31):
//   gaokao=3655  cet4=3469  cet6=1357  kaoyan≈4800 (86.8% of NETEM 5530)
// Scale checks below fail the build if a future rerun drifts out of band.
//
// Output layout (scripts/out/enexam/ is gitignored):
//   enexam-tags.multi-<yyyymmdd>.v1.json     pretty JSON for humans
//   enexam-tags.multi-<yyyymmdd>.v1.json.br  brotli quality 11, KV blob
//   manifest.json                            the KV manifest to publish
//   dropped.txt                              roster words dropped + reason
//
// Usage:
//   node scripts/preprocess-enexam.mjs                  # fetch all, write all
//   node scripts/preprocess-enexam.mjs --dry-run        # fetch, stats, no write
//   node scripts/preprocess-enexam.mjs --local-dir=path # read word-list.txt /
//                                                       # 3500.txt / ecdict.csv
//                                                       # from a local dir
//   node scripts/preprocess-enexam.mjs --refresh        # redownload cached ecdict.csv

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync, constants as zlibConst } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const OUT_DIR = join(REPO_ROOT, "scripts", "out", "enexam");
const CACHE_DIR = join(OUT_DIR, ".cache");

const SCHEMA_VERSION = 1;
const SCHEMA_TAG = "v1";
const DATA_TAG = "lyriclens-enexam-tags";
const BLOB_URL_BASE = "https://dicts.yoru-and-akari.dev/enexam";

const SOURCES = {
  "cet-word-list": {
    repo: "JavaProgrammerLB/cet-word-list",
    raw: "https://raw.githubusercontent.com/JavaProgrammerLB/cet-word-list/master/word-list.txt",
    path: "word-list.txt",
    localName: "word-list.txt",
  },
  ECDICT: {
    repo: "skywind3000/ECDICT",
    raw: "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
    path: "ecdict.csv",
    localName: "ecdict.csv",
  },
  word3500: {
    repo: "pluto0x0/word3500",
    raw: "https://raw.githubusercontent.com/pluto0x0/word3500/master/3500.txt",
    path: "3500.txt",
    localName: "3500.txt",
  },
};

// NETEM (2024 postgraduate-exam syllabus) headword count. Coverage
// check only — the NETEM word data is CC BY-NC-SA and must never be
// downloaded, parsed, or redistributed by this pipeline.
const NETEM_SYLLABUS_COUNT = 5530;
const NETEM_MIN_COVERAGE = 0.8;

// Absolute size bands around the measured 2026-07-02 baseline. A rerun
// that lands outside a band means an upstream reshaped its data — stop
// and re-verify instead of shipping a silently different vocabulary.
const SCALE_CHECKS = {
  gaokao: { min: 3200, max: 4000 },
  cet4: { min: 3000, max: 4500 },
  cet6: { min: 1000, max: 2000 },
  kaoyan: { min: 4300, max: 6100 },
};

// Fixed tag order inside each entry: basic → advanced. Deterministic
// output matters — same inputs must produce byte-identical JSON.
const TAG_ORDER = ["gaokao", "cet4", "cet6", "kaoyan"];

function parseArgs() {
  const args = { dryRun: false, localDir: null, generatedAt: null, refresh: false };
  for (const raw of process.argv.slice(2)) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw === "--refresh") args.refresh = true;
    else if (raw.startsWith("--local-dir=")) args.localDir = raw.slice("--local-dir=".length);
    else if (raw.startsWith("--generated-at=")) args.generatedAt = raw.slice("--generated-at=".length);
    else throw new Error(`unknown flag: ${raw}`);
  }
  return args;
}

// One normalize rule for every side of every intersection: split on
// whitespace (OCR merged-line defect), strip edge punctuation, lowercase,
// keep single words only (letters + inner apostrophe/hyphen, e.g.
// o'clock, well-known). Phrases and stray symbols never become keys.
const WORD_RE = /^[a-z][a-z'-]*$/;
function cleanTokens(line) {
  return line
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").toLowerCase())
    .filter((t) => WORD_RE.test(t));
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}: ${await res.text()}`);
  return res.text();
}

async function fetchToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function fetchUpstreamSha(sourceKey) {
  const { repo, path } = SOURCES[sourceKey];
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`commits fetch ${repo} → ${res.status}: ${await res.text()}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`commits ${repo}: empty`);
  return String(arr[0].sha).slice(0, 7);
}

// CET roster: one flat txt, but OCR merged some lines ("fabrication
// fabulous") so token-split every line rather than trusting line = word.
function parseCetRoster(text) {
  const words = new Set();
  for (const line of text.split(/\r?\n/)) {
    for (const t of cleanTokens(line)) words.add(t);
  }
  return words;
}

// word3500: entries are 3-line groups (headword / [IPA] / gloss) but the
// grouping isn't perfectly regular, so the robust rule is: a line is a
// headword line iff the NEXT line starts with "[". Parenthesised variants
// ("a (an)") token-split into both forms.
function parseGaokaoRoster(text) {
  const lines = text.split(/\r?\n/);
  const words = new Set();
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i + 1].trimStart().startsWith("[")) {
      for (const t of cleanTokens(lines[i])) words.add(t);
    }
  }
  return words;
}

// Minimal RFC-4180 field splitter for one physical line. ECDICT escapes
// newlines inside cells as literal "\n" so physical line == record.
function csvFields(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Stream ecdict.csv (66 MB, ~770k rows) and keep only what we need:
// per-exam-tag word sets plus the full word set (to distinguish "ECDICT
// doesn't know this word" from "knows it but didn't tag it" in dropped.txt).
async function parseEcdict(csvPath) {
  const tagSets = { gk: new Set(), cet4: new Set(), cet6: new Set(), ky: new Set() };
  const allWords = new Set();
  let rows = 0;
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      if (!line.startsWith("word,")) throw new Error(`ecdict.csv: unexpected header: ${line.slice(0, 80)}`);
      continue;
    }
    rows++;
    const f = csvFields(line);
    const word = (f[0] ?? "").toLowerCase().trim();
    if (!WORD_RE.test(word)) continue;
    allWords.add(word);
    const tags = (f[7] ?? "").trim();
    if (!tags) continue;
    for (const tag of tags.split(/\s+/)) {
      if (tagSets[tag]) tagSets[tag].add(word);
    }
  }
  return { tagSets, allWords, rows };
}

const intersect = (a, b) => new Set([...a].filter((x) => b.has(x)));
const subtract = (a, b) => new Set([...a].filter((x) => !b.has(x)));

function crossVerify({ cetAll, gaokaoRoster, ecdict }) {
  const { tagSets, allWords } = ecdict;
  const cet4 = intersect(cetAll, tagSets.cet4);
  const cet6 = subtract(intersect(cetAll, tagSets.cet6), cet4);
  const gaokao = intersect(gaokaoRoster, tagSets.gk);
  const kaoyan = tagSets.ky;

  const dropped = [];
  for (const w of [...subtract(subtract(cetAll, cet4), cet6)].sort()) {
    const reason = allWords.has(w) ? "cet-roster: in ECDICT but no cet4/cet6 tag" : "cet-roster: not in ECDICT (likely OCR noise)";
    dropped.push({ word: w, reason });
  }
  for (const w of [...subtract(gaokaoRoster, gaokao)].sort()) {
    const reason = allWords.has(w)
      ? "gaokao-roster: in ECDICT but no gk tag (inflected form / rare variant)"
      : "gaokao-roster: not in ECDICT (likely OCR noise)";
    dropped.push({ word: w, reason });
  }
  return { sets: { gaokao, cet4, cet6, kaoyan }, dropped };
}

function runScaleChecks(sets) {
  const failures = [];
  for (const [tag, { min, max }] of Object.entries(SCALE_CHECKS)) {
    const n = sets[tag].size;
    if (n < min || n > max) failures.push(`${tag}=${n} outside [${min}, ${max}]`);
  }
  const coverage = sets.kaoyan.size / NETEM_SYLLABUS_COUNT;
  if (coverage < NETEM_MIN_COVERAGE) {
    failures.push(
      `kaoyan NETEM coverage ${(coverage * 100).toFixed(1)}% < ${NETEM_MIN_COVERAGE * 100}% (${sets.kaoyan.size}/${NETEM_SYLLABUS_COUNT})`
    );
  }
  return { failures, coverage };
}

function buildEntries(sets) {
  const byWord = new Map();
  for (const tag of TAG_ORDER) {
    for (const w of sets[tag]) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(tag);
    }
  }
  // Insertion order of a JS object is preserved by JSON.stringify —
  // sorted keys make the output byte-stable across reruns.
  const entries = {};
  for (const w of [...byWord.keys()].sort()) entries[w] = byWord.get(w);
  return entries;
}

function buildEnvelope({ entries, shas, generatedAt }) {
  return {
    schema: SCHEMA_VERSION,
    generated_at: generatedAt,
    license: "MIT sources, cross-verified; headwords + tags only",
    sources: {
      "cet-word-list": shas["cet-word-list"],
      ECDICT: shas.ECDICT,
      word3500: shas.word3500,
    },
    entries,
  };
}

function buildManifest({ buildKey, blobName, sha256Hex, byteLen, gz, shas, generatedAt }) {
  return {
    name: DATA_TAG,
    schema: SCHEMA_VERSION,
    latest: buildKey,
    generated_at: generatedAt,
    sources: {
      [buildKey]: {
        url: `${BLOB_URL_BASE}/${blobName}`,
        encoding: "br",
        license: "MIT sources, cross-verified; headwords + tags only",
        source: `cet-word-list@${shas["cet-word-list"]} + ECDICT@${shas.ECDICT} + word3500@${shas.word3500}`,
        sha256: sha256Hex,
        bytes: byteLen,
        gzip: {
          url: `${BLOB_URL_BASE}/${gz.name}`,
          sha256: gz.sha256,
          bytes: gz.bytes,
        },
      },
    },
  };
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function loadInputs(args) {
  if (args.localDir) {
    console.log(`reading local dir: ${args.localDir}`);
    const read = (name) => readFile(join(args.localDir, name), "utf8");
    return {
      cetText: await read(SOURCES["cet-word-list"].localName),
      gaokaoText: await read(SOURCES.word3500.localName),
      ecdictPath: join(args.localDir, SOURCES.ECDICT.localName),
      shas: { "cet-word-list": "local", ECDICT: "local", word3500: "local" },
    };
  }

  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
  const ecdictPath = join(CACHE_DIR, "ecdict.csv");
  const needEcdict = args.refresh || !existsSync(ecdictPath);
  if (needEcdict) console.log(`downloading ecdict.csv (~66 MB) → ${ecdictPath}`);
  else console.log(`using cached ecdict.csv: ${ecdictPath} (--refresh to redownload)`);

  const [cetText, gaokaoText, , ...shaValues] = await Promise.all([
    fetchText(SOURCES["cet-word-list"].raw),
    fetchText(SOURCES.word3500.raw),
    needEcdict ? fetchToFile(SOURCES.ECDICT.raw, ecdictPath) : Promise.resolve(),
    fetchUpstreamSha("cet-word-list"),
    fetchUpstreamSha("ECDICT"),
    fetchUpstreamSha("word3500"),
  ]);
  const shas = { "cet-word-list": shaValues[0], ECDICT: shaValues[1], word3500: shaValues[2] };
  console.log(`upstream shas: cet-word-list@${shas["cet-word-list"]} ECDICT@${shas.ECDICT} word3500@${shas.word3500}`);
  return { cetText, gaokaoText, ecdictPath, shas };
}

async function main() {
  const args = parseArgs();
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const buildDate = generatedAt.slice(0, 10).replaceAll("-", "");
  const buildKey = `multi-${buildDate}.${SCHEMA_TAG}`;

  const { cetText, gaokaoText, ecdictPath, shas } = await loadInputs(args);

  const cetAll = parseCetRoster(cetText);
  const gaokaoRoster = parseGaokaoRoster(gaokaoText);
  console.log(`cet roster: ${cetAll.size} unique words`);
  console.log(`gaokao roster: ${gaokaoRoster.size} unique headwords`);

  const ecdict = await parseEcdict(ecdictPath);
  console.log(`ecdict: ${ecdict.rows} rows; tags gk=${ecdict.tagSets.gk.size} cet4=${ecdict.tagSets.cet4.size} cet6=${ecdict.tagSets.cet6.size} ky=${ecdict.tagSets.ky.size}`);

  const { sets, dropped } = crossVerify({ cetAll, gaokaoRoster, ecdict });
  console.log(`cross-verified: gaokao=${sets.gaokao.size} cet4=${sets.cet4.size} cet6=${sets.cet6.size} kaoyan=${sets.kaoyan.size}`);
  console.log(`dropped: ${dropped.length} roster words (see dropped.txt)`);

  const { failures, coverage } = runScaleChecks(sets);
  console.log(`kaoyan NETEM coverage: ${(coverage * 100).toFixed(1)}% (count check only, NETEM data untouched)`);
  if (failures.length > 0) {
    console.error("SCALE CHECK FAILED — refusing to build:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(2);
  }

  const entries = buildEntries(sets);
  const entryCount = Object.keys(entries).length;
  console.log(`entries: ${entryCount} words`);

  const envelope = buildEnvelope({ entries, shas, generatedAt });
  const jsonPretty = JSON.stringify(envelope, null, 2);
  const jsonCompact = JSON.stringify(envelope);
  const jsonCompactBuf = Buffer.from(jsonCompact, "utf8");
  console.log(`json bytes (compact): ${jsonCompactBuf.length}`);

  const t0 = Date.now();
  const brBuf = brotliCompressSync(jsonCompactBuf, {
    params: {
      [zlibConst.BROTLI_PARAM_QUALITY]: 11,
      [zlibConst.BROTLI_PARAM_MODE]: zlibConst.BROTLI_MODE_TEXT,
    },
  });
  const brSecs = ((Date.now() - t0) / 1000).toFixed(1);
  const ratio = ((brBuf.length / jsonCompactBuf.length) * 100).toFixed(1);
  console.log(`brotli quality 11: ${brBuf.length} bytes (${ratio}% of raw, ${brSecs}s)`);

  const sha = sha256Hex(brBuf);
  console.log(`blob sha256: ${sha}`);

  const blobName = `enexam-tags.${buildKey}.json.br`;
  // gzip variant for the BetterNCM plugin host — its Chromium 91 has no
  // brotli decoder (DecompressionStream is gzip/deflate only). The .br
  // blob stays canonical for the desktop host; manifest field is additive.
  const gzName = blobName.replace(/\.br$/, ".gz");
  const gzBuf = gzipSync(jsonCompactBuf, { level: 9 });
  const gzSha = sha256Hex(gzBuf);
  const gzRatio = ((gzBuf.length / jsonCompactBuf.length) * 100).toFixed(1);
  console.log(`gzip level 9: ${gzBuf.length} bytes (${gzRatio}% of raw), sha256: ${gzSha}`);
  const manifest = buildManifest({
    buildKey,
    blobName,
    sha256Hex: sha,
    byteLen: brBuf.length,
    gz: { name: gzName, sha256: gzSha, bytes: gzBuf.length },
    shas,
    generatedAt,
  });

  if (args.dryRun) {
    console.log("--dry-run: skipping writes");
    console.log(`would write: ${join(OUT_DIR, blobName)}`);
    console.log(`would write: ${join(OUT_DIR, gzName)}`);
    console.log(`would write: ${join(OUT_DIR, "manifest.json")}`);
    console.log(`would write: ${join(OUT_DIR, "dropped.txt")}`);
    return;
  }

  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  const jsonOut = join(OUT_DIR, blobName.replace(/\.br$/, ""));
  const brOut = join(OUT_DIR, blobName);
  const gzOut = join(OUT_DIR, gzName);
  const manifestOut = join(OUT_DIR, "manifest.json");
  const droppedOut = join(OUT_DIR, "dropped.txt");

  const droppedText =
    `# roster words dropped by cross-verification — ${generatedAt}\n` +
    `# ${dropped.length} words; format: <word>\t<reason>\n` +
    dropped.map((d) => `${d.word}\t${d.reason}`).join("\n") +
    "\n";

  await writeFile(jsonOut, jsonPretty, "utf8");
  await writeFile(brOut, brBuf);
  await writeFile(gzOut, gzBuf);
  await writeFile(manifestOut, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(droppedOut, droppedText, "utf8");

  console.log(`wrote: ${jsonOut}`);
  console.log(`wrote: ${brOut}`);
  console.log(`wrote: ${gzOut}`);
  console.log(`wrote: ${manifestOut}`);
  console.log(`wrote: ${droppedOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

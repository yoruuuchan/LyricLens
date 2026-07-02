#!/usr/bin/env node
// Preprocess the CEFR-J Vocabulary Profile into the compact
// word → level JSON envelope + brotli blob + manifest.json shape locked
// in docs/schema/cefrj-vocab.md.
//
// Single source (verified 2026-07-02, file contents inspected — not
// just README):
//   openlanguageprofiles/olp-en-cefrj  cefrj-vocabulary-profile-1.5.csv
//     7799 rows, columns headword,pos,CEFR,... — levels A1/A2/B1/B2
//     only, no dirty values. © Tono Laboratory at TUFS; per repo README
//     free for research AND commercial use with citation.
//
// The sibling octanove-vocabulary-profile-c1c2-1.0.csv (C1/C2, 1950
// unique words) is CC BY-SA 4.0 — ShareAlike. Excluded from this
// pipeline for the same reason JLPT chose Bluskyo over yomitan
// (roadmap decision #12: avoid ShareAlike data obligations). See
// schema doc §数据源 for the standing decision.
//
// Build rules (see schema doc §构建规则):
//   split "/"-joined spelling variants (airplane/aeroplane → 2 keys)
//   trim → lowercase → keep /^\p{L}[\p{L}\p{N} .'-]*$/u
//     (phrases like "according to" and "mp3 player" are legitimate
//     hand-curated entries, NOT OCR noise — kept, unlike enexam)
//   fold diacritics for alias keys (café → cafe points at same level)
//   same key at multiple levels (573 words, pos-dependent) → LOWEST
//     level wins: "above" is A1 (adverb/preposition) not B1 (adjective)
//     — the reference-level semantics is "when does a learner first
//     meet this word".
//
// Rejected tokens (clitics 'm / 're / 's) are recorded in dropped.txt
// with a reason — never silently. Measured baseline (2026-07-02,
// olp-en-cefrj@HEAD): rows=7799 A1=1164 A2=1411 B1=2446 B2=2778.
// Scale checks below fail the build if a rerun drifts out of band.
//
// Output layout (scripts/out/cefrj/ is gitignored):
//   cefrj-levels.olp-<sha7>.v1.json     pretty JSON for humans
//   cefrj-levels.olp-<sha7>.v1.json.br  brotli quality 11, KV blob
//   manifest.json                       the KV manifest to publish
//   dropped.txt                         rejected tokens + reason
//
// Usage:
//   node scripts/preprocess-cefrj.mjs                  # fetch, write all
//   node scripts/preprocess-cefrj.mjs --dry-run        # fetch, stats, no write
//   node scripts/preprocess-cefrj.mjs --local-dir=path # read the csv from
//                                                      # a local dir instead

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync, constants as zlibConst } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const OUT_DIR = join(REPO_ROOT, "scripts", "out", "cefrj");

const SCHEMA_VERSION = 1;
const SCHEMA_TAG = "v1";
const DATA_TAG = "lyriclens-cefrj-levels";
const BLOB_URL_BASE = "https://dicts.yoru-and-akari.dev/cefrj";
const LICENSE_LINE =
  "CEFR-J Wordlist v1.5 (Tono Lab, TUFS) — free for research & commercial use with citation; headwords + levels only";

const SOURCE = {
  key: "olp-en-cefrj",
  repo: "openlanguageprofiles/olp-en-cefrj",
  raw: "https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/cefrj-vocabulary-profile-1.5.csv",
  path: "cefrj-vocabulary-profile-1.5.csv",
  localName: "cefrj-vocabulary-profile-1.5.csv",
};

// Order doubles as merge priority: the lowest level a headword appears
// at wins (reference-level = first-contact level).
const LEVELS = ["A1", "A2", "B1", "B2"];

// Absolute bands around the measured 2026-07-02 baseline (rows=7799,
// A1=1164 A2=1411 B1=2446 B2=2778, entries≈7.1k after variant split
// and lowest-level merge). Outside a band = upstream reshaped its data;
// stop and re-verify instead of shipping silently different levels.
const SCALE_CHECKS = {
  rows: { min: 7000, max: 8500 },
  A1: { min: 900, max: 1500 },
  A2: { min: 1100, max: 1800 },
  B1: { min: 2000, max: 3000 },
  B2: { min: 2200, max: 3400 },
  entries: { min: 6500, max: 8000 },
};

// Hand-curated list: letters (unicode, café is in the data), then
// letters/digits/space/dot/apostrophe/hyphen ("according to",
// "mp3 player", "a.m.", "o'clock", "well-known").
const KEY_RE = /^\p{L}[\p{L}\p{N} .'-]*$/u;

function parseArgs() {
  const args = { dryRun: false, localDir: null, generatedAt: null };
  for (const raw of process.argv.slice(2)) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw.startsWith("--local-dir=")) args.localDir = raw.slice("--local-dir=".length);
    else if (raw.startsWith("--generated-at=")) args.generatedAt = raw.slice("--generated-at=".length);
    else throw new Error(`unknown flag: ${raw}`);
  }
  return args;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}: ${await res.text()}`);
  return res.text();
}

async function fetchUpstreamSha() {
  const url = `https://api.github.com/repos/${SOURCE.repo}/commits?path=${encodeURIComponent(SOURCE.path)}&per_page=1`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`commits fetch ${SOURCE.repo} → ${res.status}: ${await res.text()}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`commits ${SOURCE.repo}: empty`);
  return String(arr[0].sha).slice(0, 7);
}

// Minimal RFC-4180 field splitter for one physical line (same as the
// enexam pipeline; this csv has no embedded newlines).
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

// NFD-decompose and strip combining marks: café → cafe. Returns the
// input unchanged when there's nothing to fold.
function foldDiacritics(s) {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = csvFields(lines[0]);
  if (header[0] !== "headword" || header[2] !== "CEFR") {
    throw new Error(`unexpected csv header: ${lines[0].slice(0, 80)}`);
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = csvFields(line);
    rows.push({ headword: f[0] ?? "", level: (f[2] ?? "").trim() });
  }
  return rows;
}

function build(rows) {
  const levelRank = new Map(LEVELS.map((l, i) => [l, i]));
  const byKey = new Map(); // key → rank of lowest level seen
  const dropped = [];
  const levelCounts = Object.fromEntries(LEVELS.map((l) => [l, 0]));

  const claim = (key, rank) => {
    const prev = byKey.get(key);
    if (prev === undefined || rank < prev) byKey.set(key, rank);
  };

  for (const { headword, level } of rows) {
    const rank = levelRank.get(level);
    if (rank === undefined) {
      dropped.push({ token: headword, reason: `unknown CEFR level "${level}"` });
      continue;
    }
    levelCounts[level]++;
    for (const variant of headword.split("/")) {
      const key = variant.trim().toLowerCase();
      if (!KEY_RE.test(key)) {
        dropped.push({ token: key || headword, reason: "rejected by key charset (clitic / empty)" });
        continue;
      }
      claim(key, rank);
      const folded = foldDiacritics(key);
      if (folded !== key) claim(folded, rank); // alias: café → cafe
    }
  }

  const entries = {};
  for (const key of [...byKey.keys()].sort()) entries[key] = LEVELS[byKey.get(key)];
  return { entries, dropped, levelCounts };
}

function runScaleChecks({ rowCount, levelCounts, entryCount }) {
  const observed = { rows: rowCount, ...levelCounts, entries: entryCount };
  const failures = [];
  for (const [name, { min, max }] of Object.entries(SCALE_CHECKS)) {
    const n = observed[name];
    if (n < min || n > max) failures.push(`${name}=${n} outside [${min}, ${max}]`);
  }
  return failures;
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function loadInput(args) {
  if (args.localDir) {
    console.log(`reading local dir: ${args.localDir}`);
    return {
      csvText: await readFile(join(args.localDir, SOURCE.localName), "utf8"),
      sha: "local",
    };
  }
  const [csvText, sha] = await Promise.all([fetchText(SOURCE.raw), fetchUpstreamSha()]);
  console.log(`upstream sha: ${SOURCE.key}@${sha}`);
  return { csvText, sha };
}

async function main() {
  const args = parseArgs();
  const generatedAt = args.generatedAt ?? new Date().toISOString();

  const { csvText, sha } = await loadInput(args);
  const rows = parseCsv(csvText);
  console.log(`csv rows: ${rows.length}`);

  const { entries, dropped, levelCounts } = build(rows);
  const entryCount = Object.keys(entries).length;
  console.log(
    `levels: ${LEVELS.map((l) => `${l}=${levelCounts[l]}`).join(" ")}; entries: ${entryCount} keys (variants split, lowest level wins)`
  );
  console.log(`dropped: ${dropped.length} tokens (see dropped.txt)`);

  const failures = runScaleChecks({ rowCount: rows.length, levelCounts, entryCount });
  if (failures.length > 0) {
    console.error("SCALE CHECK FAILED — refusing to build:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(2);
  }

  const buildKey = `olp-${sha}.${SCHEMA_TAG}`;
  const blobName = `cefrj-levels.${buildKey}.json.br`;

  const envelope = {
    schema: SCHEMA_VERSION,
    generated_at: generatedAt,
    license: LICENSE_LINE,
    sources: { [SOURCE.key]: sha },
    entries,
  };
  const jsonPretty = JSON.stringify(envelope, null, 2);
  const jsonCompactBuf = Buffer.from(JSON.stringify(envelope), "utf8");
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

  const blobSha256 = sha256Hex(brBuf);
  console.log(`blob sha256: ${blobSha256}`);

  // gzip variant for the BetterNCM plugin host — its Chromium 91 has no
  // brotli decoder (DecompressionStream is gzip/deflate only). The .br
  // blob stays canonical for the desktop host; manifest field is additive.
  const gzName = blobName.replace(/\.br$/, ".gz");
  const gzBuf = gzipSync(jsonCompactBuf, { level: 9 });
  const gzSha256 = sha256Hex(gzBuf);
  const gzRatio = ((gzBuf.length / jsonCompactBuf.length) * 100).toFixed(1);
  console.log(`gzip level 9: ${gzBuf.length} bytes (${gzRatio}% of raw), sha256: ${gzSha256}`);

  const manifest = {
    name: DATA_TAG,
    schema: SCHEMA_VERSION,
    latest: buildKey,
    generated_at: generatedAt,
    sources: {
      [buildKey]: {
        url: `${BLOB_URL_BASE}/${blobName}`,
        encoding: "br",
        license: LICENSE_LINE,
        source: `${SOURCE.key}@${sha}`,
        sha256: blobSha256,
        bytes: brBuf.length,
        gzip: {
          url: `${BLOB_URL_BASE}/${gzName}`,
          sha256: gzSha256,
          bytes: gzBuf.length,
        },
      },
    },
  };

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
    `# tokens rejected by the cefrj pipeline — ${generatedAt}\n` +
    `# ${dropped.length} tokens; format: <token>\t<reason>\n` +
    dropped.map((d) => `${d.token}\t${d.reason}`).join("\n") +
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

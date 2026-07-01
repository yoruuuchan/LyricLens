#!/usr/bin/env node
// Preprocess Bluskyo/JLPT_Vocabulary into the compact JSON envelope + brotli
// blob + manifest.json shape locked in docs/schema/jlpt-vocab.md.
//
// Bluskyo upstream ships JLPT_vocab_ALL.json as:
//   { "挨拶": [{ "reading": "あいさつ", "level": 3 }], ... }
// with 8138 entries. We keep the outer map shape, translate level int → "N<n>"
// string, tag source + confidence, and pin a schema version.
//
// Output layout (scripts/out/jlpt/ is gitignored):
//   jlpt-levels.bluskyo-<upstream-sha>.v1.json      pretty JSON for humans
//   jlpt-levels.bluskyo-<upstream-sha>.v1.json.br   brotli quality 11, KV blob
//   manifest.json                                    the KV manifest to publish
//
// Usage:
//   node scripts/preprocess-jlpt.mjs               # fetch upstream, write all
//   node scripts/preprocess-jlpt.mjs --dry-run     # fetch, print stats, no write
//   node scripts/preprocess-jlpt.mjs --local=path  # skip fetch, read local file

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zlibConst } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const OUT_DIR = join(REPO_ROOT, "scripts", "out", "jlpt");

const UPSTREAM_RAW =
  "https://raw.githubusercontent.com/Bluskyo/JLPT_Vocabulary/main/data/vocab/results/JLPT_vocab_ALL.json";
const UPSTREAM_COMMITS_API =
  "https://api.github.com/repos/Bluskyo/JLPT_Vocabulary/commits?path=data/vocab/results/JLPT_vocab_ALL.json&per_page=1";
const SCHEMA_VERSION = 1;
const SCHEMA_TAG = "v1";
const DATA_TAG = "lyriclens-jlpt-levels";
// dicts.yoru-and-akari.dev is a dedicated subdomain for KV-backed dictionary
// blobs — separated from the root yoru-and-akari.dev (which is the Pages
// landing site) to keep routes clean. See docs/schema/jlpt-vocab.md.
const BLOB_URL_BASE = "https://dicts.yoru-and-akari.dev/jlpt";

function parseArgs() {
  const args = { dryRun: false, local: null, generatedAt: null };
  for (const raw of process.argv.slice(2)) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw.startsWith("--local=")) args.local = raw.slice("--local=".length);
    else if (raw.startsWith("--generated-at=")) args.generatedAt = raw.slice("--generated-at=".length);
    else throw new Error(`unknown flag: ${raw}`);
  }
  return args;
}

async function fetchUpstreamRaw() {
  const res = await fetch(UPSTREAM_RAW);
  if (!res.ok) throw new Error(`upstream fetch ${res.status}: ${await res.text()}`);
  return res.text();
}

async function fetchUpstreamSha() {
  const res = await fetch(UPSTREAM_COMMITS_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`upstream commits fetch ${res.status}: ${await res.text()}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("upstream commits: empty");
  return String(arr[0].sha).slice(0, 7);
}

function levelIntToLabel(level) {
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return `N${n}`;
}

function convert(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("upstream JSON: expected object at top level");
  }
  const entries = {};
  const stats = { surfaces: 0, candidates: 0, dropped: 0, byLevel: { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 } };
  for (const [surface, rawList] of Object.entries(parsed)) {
    if (!Array.isArray(rawList)) {
      stats.dropped += 1;
      continue;
    }
    const converted = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const label = levelIntToLabel(item.level);
      if (!label) continue;
      const reading = typeof item.reading === "string" && item.reading.length > 0 ? item.reading : undefined;
      const entry = { level: label, source: "bluskyo", confidence: "source" };
      if (reading) entry.reading = reading;
      converted.push(entry);
      stats.byLevel[label] += 1;
      stats.candidates += 1;
    }
    if (converted.length > 0) {
      entries[surface] = converted;
      stats.surfaces += 1;
    } else {
      stats.dropped += 1;
    }
  }
  return { entries, stats };
}

function buildEnvelope({ entries, upstreamSha, generatedAt }) {
  return {
    schema: SCHEMA_VERSION,
    generated_at: generatedAt,
    license: "MIT (repo) / CC BY (upstream data)",
    source: {
      name: "Bluskyo/JLPT_Vocabulary",
      version: upstreamSha,
      url: "https://github.com/Bluskyo/JLPT_Vocabulary",
      upstream: "Tanos / Jonathan Waller",
    },
    entries,
  };
}

function buildManifest({ blobName, sha256Hex, byteLen, upstreamSha, generatedAt }) {
  const sourceKey = `bluskyo-${upstreamSha}.${SCHEMA_TAG}`;
  return {
    name: DATA_TAG,
    schema: SCHEMA_VERSION,
    latest: sourceKey,
    generated_at: generatedAt,
    sources: {
      [sourceKey]: {
        url: `${BLOB_URL_BASE}/${blobName}`,
        encoding: "br",
        license: "MIT-repo / CC-BY-upstream",
        source: `Bluskyo/JLPT_Vocabulary @ ${upstreamSha}`,
        upstream: "Jonathan Waller / Tanos JLPT Resources (CC BY)",
        sha256: sha256Hex,
        bytes: byteLen,
      },
    },
  };
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const args = parseArgs();
  const generatedAt = args.generatedAt ?? new Date().toISOString();

  let raw;
  let upstreamSha;
  if (args.local) {
    console.log(`reading local: ${args.local}`);
    raw = await readFile(args.local, "utf8");
    upstreamSha = "local";
  } else {
    console.log(`fetching upstream: ${UPSTREAM_RAW}`);
    [raw, upstreamSha] = await Promise.all([fetchUpstreamRaw(), fetchUpstreamSha()]);
    console.log(`upstream commit sha: ${upstreamSha}`);
  }

  const { entries, stats } = convert(raw);
  console.log(`surfaces: ${stats.surfaces}`);
  console.log(`candidates: ${stats.candidates}`);
  console.log(`dropped: ${stats.dropped}`);
  console.log(`by level: N1=${stats.byLevel.N1} N2=${stats.byLevel.N2} N3=${stats.byLevel.N3} N4=${stats.byLevel.N4} N5=${stats.byLevel.N5}`);

  const envelope = buildEnvelope({ entries, upstreamSha, generatedAt });
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

  const blobName = `jlpt-levels.bluskyo-${upstreamSha}.${SCHEMA_TAG}.json.br`;
  const manifest = buildManifest({
    blobName,
    sha256Hex: sha,
    byteLen: brBuf.length,
    upstreamSha,
    generatedAt,
  });

  if (args.dryRun) {
    console.log("--dry-run: skipping writes");
    console.log(`would write: ${join(OUT_DIR, blobName)}`);
    console.log(`would write: ${join(OUT_DIR, "manifest.json")}`);
    return;
  }

  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  const jsonOut = join(OUT_DIR, blobName.replace(/\.br$/, ""));
  const brOut = join(OUT_DIR, blobName);
  const manifestOut = join(OUT_DIR, "manifest.json");

  await writeFile(jsonOut, jsonPretty, "utf8");
  await writeFile(brOut, brBuf);
  await writeFile(manifestOut, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`wrote: ${jsonOut}`);
  console.log(`wrote: ${brOut}`);
  console.log(`wrote: ${manifestOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

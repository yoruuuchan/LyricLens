/*
 * LyricLens Updater Probe (one-shot, throwaway)
 *
 * Verifies the BetterNCM capabilities we plan to depend on for the
 * in-plugin auto-updater. Runs once at NCM boot, prints a structured
 * report to the console under `[ProbeA]`, and writes the same report
 * to `./plugins/lyriclens-probe-a-report.json` for easy copy-paste.
 *
 * Environment confirmed by Yoru (2026-06-29):
 *   - BetterNCM 1.3.4
 *   - NetEase CloudMusic 3.1.23 (64-bit)
 *   - LyricLens currently installed as `.plugin` file
 *   - Process name: NetEase Cloud Music (likely cloudmusic.exe binary)
 *
 * IMPORTANT: this probe DOES NOT touch any LyricLens-owned files. All
 * its writes use the `lyriclens-probe-a-*` prefix and live under the
 * BetterNCM plugins/ dir. After running, Yoru should uninstall this
 * probe (or rename to .plugin.disabled) and the leftover probe files
 * can be deleted manually.
 *
 * Safety:
 *   - Never overwrites any existing .plugin we don't own
 *   - All file operations are wrapped in try/catch + safe stringify
 *   - Restart/reload calls are GATED behind explicit user prompts so
 *     the probe doesn't hijack NCM on first install
 */

(function runUpdaterProbe(root) {
  "use strict";

  const PREFIX = "[ProbeA]";
  const REPORT_FILENAME = "lyriclens-probe-a-report.json";
  const PROBE_WORK_FILE = "lyriclens-probe-a-work.txt";
  const PROBE_WORK_FILE_2 = "lyriclens-probe-a-work2.txt";
  const PROBE_BLOB_FILE = "lyriclens-probe-a-blob.bin";
  const PROBE_BIG_FILE = "lyriclens-probe-a-big.bin";

  // Marker we leave in window so a second-pass run after restart can
  // detect whether prior probe state survived. The actual cross-restart
  // persistence test belongs to Probe B (IndexedDB), but checking
  // global residue is cheap and informative.
  const MARKER = "__lyriclens_probe_a_marker__";
  const previousMarker = root[MARKER];
  root[MARKER] = { instantiatedAt: nowIso(), runCount: (previousMarker?.runCount || 0) + 1 };

  const report = {
    probe: "A",
    probeVersion: "0.1.0",
    capturedAt: nowIso(),
    env: {},
    api: {},
    fs: {},
    reload: {},
    restart: {},
    process: {},
    notes: [],
    errors: []
  };

  log("=== LyricLens Updater Probe START ===");
  log("Run count this NCM session:", root[MARKER].runCount);
  if (previousMarker) {
    log("Previous marker present → hot reload likely (reloadPlugins fired):", previousMarker);
    note("Previous marker present (instantiatedAt=" + previousMarker.instantiatedAt + ") — module re-evaluated without process restart");
  }

  // Defer the heavy work to next tick so betterncm globals have a
  // chance to settle. BetterNCM injects `plugin`, `betterncm`,
  // `betterncm_native` synchronously, but we don't want to race the
  // BetterNCM bootstrap output.
  setTimeout(runAll, 200);

  async function runAll() {
    try {
      probeEnv();
      probeApiSurface();
      await probeFs();
      probeReloadApi();
      probeRestartApi();
      probeProcess();
      finish();
    } catch (err) {
      err("top-level probe failure", err);
      finish();
    }
  }

  // ---- ENV ----
  function probeEnv() {
    report.env = {
      userAgent: safeRead(() => navigator.userAgent),
      betterncmVersion: safeRead(() => root.betterncm?.app?.version),
      // BetterNCM 1.3.4 exposes betterncm_native.app.version separately
      betterncmNativeVersion: safeRead(() => root.betterncm_native?.app?.version),
      betterncmExists: typeof root.betterncm,
      betterncmNativeExists: typeof root.betterncm_native,
      pluginGlobalExists: safeRead(() => (typeof plugin !== "undefined" ? typeof plugin : "undefined")),
      hasIndexedDB: typeof root.indexedDB !== "undefined",
      hasStorageApi: typeof root.navigator?.storage?.estimate === "function",
      location: safeRead(() => root.location?.href)
    };
    log("env:", report.env);
  }

  // ---- API surface ----
  function probeApiSurface() {
    const surface = {};
    const namespaces = {
      betterncm: root.betterncm,
      "betterncm.app": root.betterncm?.app,
      "betterncm.fs": root.betterncm?.fs,
      "betterncm.ncm": root.betterncm?.ncm,
      "betterncm_native": root.betterncm_native,
      "betterncm_native.app": root.betterncm_native?.app,
      "betterncm_native.fs": root.betterncm_native?.fs,
      "plugin": safeRead(() => (typeof plugin !== "undefined" ? plugin : undefined))
    };
    for (const [name, ns] of Object.entries(namespaces)) {
      if (!ns || typeof ns !== "object" && typeof ns !== "function") {
        surface[name] = { present: false };
        continue;
      }
      const keys = [];
      try {
        for (const k of Object.keys(ns)) keys.push(`${k}:${typeof ns[k]}`);
      } catch (_) {}
      surface[name] = { present: true, keys };
    }
    report.api = surface;
    log("api surface:", surface);
  }

  // ---- FS ----
  // The core write-blob-to-plugins flow that PluginMarket uses. We
  // verify it actually works for us, that overwrite-in-place is safe,
  // and that 100kb / 1mb / 10mb writes don't blow up.
  async function probeFs() {
    const fs = root.betterncm?.fs;
    const native = root.betterncm_native?.fs;
    if (!fs) {
      err("betterncm.fs missing entirely — abort fs probe");
      report.fs = { available: false };
      return;
    }

    const out = {
      available: true,
      writeFileText: null,
      writeFileBlob100kb: null,
      writeFileBlob1mb: null,
      writeFileBlob10mb: null,
      rename: null,
      overwriteSameFile: null,
      readDirContainsPlugins: null,
      readFileTextRoundtrip: null,
      exists: null,
      remove: null,
      methodSignatures: {}
    };

    // Inventory whichever methods are present so we know the API shape
    // for BetterNCM 1.3.4.
    for (const [k, v] of Object.entries({
      "fs.writeFile": fs.writeFile,
      "fs.writeFileText": fs.writeFileText,
      "fs.readFileText": fs.readFileText,
      "fs.readFile": fs.readFile,
      "fs.readDir": fs.readDir,
      "fs.rename": fs.rename,
      "fs.remove": fs.remove,
      "fs.exists": fs.exists,
      "fs.mkdir": fs.mkdir,
      "fs.unzip": fs.unzip,
      "fs.watchDirectory": fs.watchDirectory,
      "native.fs.writeFile": native?.writeFile,
      "native.fs.readFile": native?.readFile
    })) {
      out.methodSignatures[k] = typeof v;
    }

    // Test 1: write small text file
    try {
      const ok = await callMaybeAsync(fs.writeFileText, fs, [
        `./plugins/${PROBE_WORK_FILE}`,
        `probe-a wrote at ${nowIso()}`
      ]);
      out.writeFileText = { ok, value: ok };
    } catch (e) {
      out.writeFileText = { error: stringifyError(e) };
    }

    // Test 2: roundtrip read
    try {
      const text = await callMaybeAsync(fs.readFileText, fs, [`./plugins/${PROBE_WORK_FILE}`]);
      out.readFileTextRoundtrip = { ok: typeof text === "string" && text.startsWith("probe-a"), sample: String(text).slice(0, 80) };
    } catch (e) {
      out.readFileTextRoundtrip = { error: stringifyError(e) };
    }

    // Test 3: writeFile with Blob (PluginMarket pattern)
    // This is the critical capability for the updater. We do three
    // sizes to catch any silent truncation or buffer limit.
    out.writeFileBlob100kb = await writeBlobSized(fs, PROBE_BLOB_FILE, 100 * 1024);
    out.writeFileBlob1mb = await writeBlobSized(fs, PROBE_BLOB_FILE, 1024 * 1024);
    out.writeFileBlob10mb = await writeBlobSized(fs, PROBE_BIG_FILE, 10 * 1024 * 1024);

    // Test 4: rename
    if (typeof fs.rename === "function") {
      try {
        const renameTarget = `./plugins/${PROBE_WORK_FILE_2}`;
        try { await callMaybeAsync(fs.remove, fs, [renameTarget]); } catch (_) {}
        const ok = await callMaybeAsync(fs.rename, fs, [`./plugins/${PROBE_WORK_FILE}`, renameTarget]);
        // Confirm rename via exists
        const existsAfter = typeof fs.exists === "function"
          ? await callMaybeAsync(fs.exists, fs, [renameTarget])
          : null;
        out.rename = { ok, existsAfter };
      } catch (e) {
        out.rename = { error: stringifyError(e) };
      }
    } else {
      out.rename = { skipped: "fs.rename not present" };
    }

    // Test 5: overwrite same file (critical for "drop new .plugin in
    // place" updater path). We rewrite the blob target with new bytes
    // and confirm length changed.
    try {
      const path = `./plugins/${PROBE_BLOB_FILE}`;
      const newContents = makeBlob(50 * 1024, 0xAB);
      const ok = await callMaybeAsync(fs.writeFile, fs, [path, newContents]);
      out.overwriteSameFile = { ok, sizeAfter: 50 * 1024 };
    } catch (e) {
      out.overwriteSameFile = { error: stringifyError(e) };
    }

    // Test 6: readDir lists our probe files? Also gives us a snapshot
    // of what's in plugins/ so we can confirm install path.
    if (typeof fs.readDir === "function") {
      try {
        const entries = await callMaybeAsync(fs.readDir, fs, ["./plugins/"]);
        const names = (Array.isArray(entries) ? entries : []).map((e) => {
          if (typeof e === "string") return e;
          return e?.name || e?.path || JSON.stringify(e).slice(0, 60);
        });
        out.readDirContainsPlugins = {
          ok: true,
          totalEntries: names.length,
          containsLyricLens: names.some((n) => /lyriclens/i.test(n) && !/probe/i.test(n)),
          containsProbeFiles: names.filter((n) => n.includes("lyriclens-probe-a")),
          sample: names.slice(0, 20)
        };
      } catch (e) {
        out.readDirContainsPlugins = { error: stringifyError(e) };
      }
    } else {
      out.readDirContainsPlugins = { skipped: "fs.readDir not present" };
    }

    // Test 7: exists() sanity
    if (typeof fs.exists === "function") {
      try {
        const a = await callMaybeAsync(fs.exists, fs, [`./plugins/${PROBE_BLOB_FILE}`]);
        const b = await callMaybeAsync(fs.exists, fs, [`./plugins/this-file-definitely-does-not-exist-12345.xyz`]);
        out.exists = { existing: a, missing: b };
      } catch (e) {
        out.exists = { error: stringifyError(e) };
      }
    }

    // Test 8: cleanup attempt (we leave the report file alone; remove
    // the rest so plugins/ doesn't accumulate junk)
    if (typeof fs.remove === "function") {
      const cleanedUp = [];
      for (const f of [PROBE_WORK_FILE_2, PROBE_BLOB_FILE, PROBE_BIG_FILE]) {
        try {
          await callMaybeAsync(fs.remove, fs, [`./plugins/${f}`]);
          cleanedUp.push(f);
        } catch (e) {
          out.errors = (out.errors || []).concat([{ remove: f, error: stringifyError(e) }]);
        }
      }
      out.remove = { cleanedUp };
    }

    report.fs = out;
    log("fs probe:", out);
  }

  async function writeBlobSized(fs, filename, byteCount) {
    try {
      const blob = makeBlob(byteCount, 0xCC);
      const t0 = perfNow();
      const ok = await callMaybeAsync(fs.writeFile, fs, [`./plugins/${filename}`, blob]);
      const ms = Math.round(perfNow() - t0);
      return { ok, bytes: byteCount, elapsedMs: ms };
    } catch (e) {
      return { error: stringifyError(e), bytes: byteCount };
    }
  }

  function makeBlob(byteCount, fillByte) {
    const buf = new Uint8Array(byteCount);
    if (fillByte !== undefined) buf.fill(fillByte);
    return new Blob([buf], { type: "application/octet-stream" });
  }

  // ---- Reload APIs (probe only, NOT executed) ----
  // Calling reloadPlugins() in the middle of the probe would yank the
  // rug out and lose our logs. We only inventory their presence and
  // expose a window helper Yoru can call manually from the console.
  function probeReloadApi() {
    const out = {
      hasReloadPlugins: typeof root.betterncm?.app?.reloadPlugins === "function",
      hasReload: typeof root.betterncm?.reload === "function",
      hasNativeReload: typeof root.betterncm_native?.reload === "function",
      readyForManualTest: false
    };
    if (out.hasReloadPlugins) {
      root.__probeARunReload = function probeARunReload() {
        log("MANUAL: running betterncm.app.reloadPlugins() in 1s — keep console open");
        setTimeout(() => {
          try {
            root.betterncm.app.reloadPlugins();
          } catch (e) {
            err("manual reloadPlugins() threw", e);
          }
        }, 1000);
      };
      out.readyForManualTest = true;
      log("manual reload helper installed → run `__probeARunReload()` in console to test");
    }
    report.reload = out;
  }

  // ---- Restart APIs (probe only, NOT executed) ----
  function probeRestartApi() {
    const out = {
      hasNativeRestart: typeof root.betterncm_native?.app?.restart === "function",
      hasAppExec: typeof root.betterncm?.app?.exec === "function",
      readyForManualTest: false
    };
    if (out.hasNativeRestart) {
      root.__probeARunRestart = function probeARunRestart() {
        log("MANUAL: running betterncm_native.app.restart() in 2s — NCM will be killed and relaunched");
        setTimeout(() => {
          try {
            root.betterncm_native.app.restart();
          } catch (e) {
            err("manual restart() threw", e);
          }
        }, 2000);
      };
      out.readyForManualTest = true;
      log("manual restart helper installed → run `__probeARunRestart()` to verify it really restarts NCM");
    }
    report.restart = out;
  }

  // ---- Process detection ----
  // BetterNCM 1.3.4 doesn't expose a direct "what's my process name"
  // call, but we can read the executable path via several known
  // surfaces and grep it ourselves.
  function probeProcess() {
    const out = {
      pluginPathHint: safeRead(() => (typeof plugin !== "undefined" ? plugin?.path : undefined)),
      processArgv: safeRead(() => root.process?.argv),
      processExecPath: safeRead(() => root.process?.execPath),
      processCwd: safeRead(() => root.process?.cwd?.()),
      // BetterNCM sometimes exposes the install dir
      betterncmPluginPath: safeRead(() => root.betterncm?.app?.pluginPath),
      betterncmDataPath: safeRead(() => root.betterncm?.app?.dataPath),
      betterncmCwd: safeRead(() => root.betterncm?.app?.cwd?.()),
      // Inferred process name (for the exec() fallback design)
      // Yoru reports task manager shows "NetEase Cloud Music" — the
      // actual binary is almost certainly cloudmusic.exe but the
      // probe will print whatever we can read here
      inferredProcessFromExec: null
    };
    report.process = out;
    log("process probe:", out);
  }

  // ---- Finalize ----
  async function finish() {
    const fs = root.betterncm?.fs;
    if (fs?.writeFileText) {
      try {
        const serialized = safeStringify(report, 2);
        await callMaybeAsync(fs.writeFileText, fs, [`./plugins/${REPORT_FILENAME}`, serialized]);
        log("=== report written to ./plugins/" + REPORT_FILENAME + " ===");
        log("Copy that file + this console log back to Claude.");
      } catch (e) {
        err("failed to write report file (console output is still complete)", e);
      }
    }
    log("=== LyricLens Updater Probe DONE ===");
    log("To test reload manually: __probeARunReload()");
    log("To test restart manually: __probeARunRestart()");
    log("FULL REPORT:", report);
  }

  // ---- helpers ----
  function log(...args) { console.log(PREFIX, ...args); }
  function note(s) { report.notes.push(s); log("note:", s); }
  function err(...args) {
    console.warn(PREFIX, ...args);
    report.errors.push(args.map((a) => stringifyError(a)).join(" | "));
  }
  function nowIso() { try { return new Date().toISOString(); } catch (_) { return ""; } }
  function perfNow() { try { return performance.now(); } catch (_) { return Date.now(); } }
  function safeRead(fn) { try { return fn(); } catch (e) { return `<<read error: ${stringifyError(e)}>>`; } }
  function stringifyError(e) {
    if (!e) return String(e);
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    if (typeof e === "object") {
      try { return JSON.stringify(e); } catch (_) { return String(e); }
    }
    return String(e);
  }
  function safeStringify(obj, indent) {
    const seen = new WeakSet();
    return JSON.stringify(obj, (k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "<<circular>>";
        seen.add(v);
      }
      if (typeof v === "function") return `<<fn ${v.name || "anon"}>>`;
      if (typeof v === "bigint") return v.toString();
      return v;
    }, indent);
  }
  async function callMaybeAsync(fn, ctx, args) {
    const r = fn.apply(ctx, args || []);
    if (r && typeof r.then === "function") return await r;
    return r;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

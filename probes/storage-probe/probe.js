/*
 * LyricLens Storage Probe (multi-phase, throwaway)
 *
 * Verifies IndexedDB on the `orpheus://` origin BetterNCM/NCM injects
 * into. Probe A confirmed `navigator.storage` is missing (Chromium 91),
 * so we can't ask for quota — we measure it by writing until something
 * breaks.
 *
 * Phase model:
 *   - Phase 1 (first run): probe DB doesn't exist → write step ladder
 *     (1MB → 10MB → 50MB → 100MB → 250MB → 500MB), persist marker
 *     with timestamp + write outcomes, write report-phase1.json
 *   - Phase 2 (second run after NCM restart): probe DB found → read
 *     marker → compare against expected → write report-phase2.json
 *     telling us whether data survived
 *
 * Each phase writes a JSON report into ./plugins/ so the harness
 * (Claude on the outside) can read it without copying console.
 *
 * Throwaway: uninstall after both phases collected.
 */

(function runStorageProbe(root) {
  "use strict";

  const PREFIX = "[ProbeB]";
  const DB_NAME = "lyriclens-storage-probe";
  const DB_VERSION = 1;
  const STORE_DATA = "data";        // holds the ladder writes
  const STORE_META = "meta";        // holds the marker
  const REPORT_DIR_PREFIX = "./plugins/";
  const REPORT_PREFIX = "lyriclens-probe-b-";
  const MARKER_KEY = "probe-marker";

  // Sizes for the write ladder (bytes). We stop at the first failure or
  // when the ladder finishes. Each step writes ONE record of that size
  // so failures attribute to a specific size.
  const LADDER_BYTES = [
    1 * 1024 * 1024,
    10 * 1024 * 1024,
    50 * 1024 * 1024,
    100 * 1024 * 1024
    // 250 / 500 MB intentionally NOT in default ladder — Probe A says
    // 10MB write took 126ms via fs.writeFile, IDB through structured-
    // clone is slower. If 100MB writes cleanly, we can rerun with the
    // larger ladder. Better to finish quickly than risk hanging NCM.
  ];

  log("=== Storage Probe START ===");

  // Defer to next tick to let betterncm globals settle.
  setTimeout(runEverything, 250);

  async function runEverything() {
    try {
      await runPhases();
    } catch (e) {
      err("top-level failure", e);
    }
  }

  async function runPhases() {
    const fs = root.betterncm?.fs;
    if (!fs) return err("betterncm.fs missing");

    if (typeof root.indexedDB === "undefined") {
      const report = {
        phase: "preflight",
        capturedAt: isoNow(),
        verdict: "ABORT_NO_INDEXEDDB",
        note: "window.indexedDB does not exist in this environment"
      };
      await writeReport(fs, "phase0-no-idb", report);
      return err("indexedDB missing — abort");
    }

    // Open DB and detect phase
    const { db, justCreated, openError } = await openProbeDb();
    if (openError) {
      const report = {
        phase: "open-failed",
        capturedAt: isoNow(),
        verdict: "ABORT_OPEN_FAILED",
        error: openError
      };
      await writeReport(fs, "phase0-open-failed", report);
      return err("open failed", openError);
    }

    // Read marker if present
    const marker = justCreated ? null : await safeReadMarker(db);

    if (!marker) {
      log("Phase 1 detected — DB is fresh OR marker missing.");
      await runPhase1(db, fs);
    } else {
      log("Phase 2 detected — marker found from:", marker.writtenAt);
      await runPhase2(db, fs, marker);
    }
  }

  // ----- Phase 1: write ladder + marker -----
  async function runPhase1(db, fs) {
    const phase1 = {
      phase: 1,
      capturedAt: isoNow(),
      env: snapshotEnv(),
      ladder: [],
      marker: null,
      counts: null,
      verdict: null
    };

    // Clear data store in case of partial prior run
    await clearStore(db, STORE_DATA);

    let lastSuccessBytes = 0;
    let stoppedReason = "completed";

    for (const sizeBytes of LADDER_BYTES) {
      log(`writing ${humanBytes(sizeBytes)}…`);
      const entry = { sizeBytes, label: humanBytes(sizeBytes), success: false };
      const t0 = perfNow();
      try {
        const payload = makePayload(sizeBytes);
        await putRecord(db, STORE_DATA, `ladder-${sizeBytes}`, payload);
        entry.success = true;
        entry.writeMs = Math.round(perfNow() - t0);
        // Round-trip read to confirm the bytes survived
        const readT0 = perfNow();
        const back = await getRecord(db, STORE_DATA, `ladder-${sizeBytes}`);
        entry.readMs = Math.round(perfNow() - readT0);
        entry.readBack = back?.bytes?.length === sizeBytes;
        entry.firstByte = back?.bytes?.[0];
        entry.lastByte = back?.bytes?.[sizeBytes - 1];
        lastSuccessBytes = sizeBytes;
        log(`  ok in ${entry.writeMs}ms (write) + ${entry.readMs}ms (read), readBack=${entry.readBack}`);
      } catch (e) {
        entry.error = stringifyError(e);
        entry.errorName = e?.name;
        entry.writeMs = Math.round(perfNow() - t0);
        log(`  failed in ${entry.writeMs}ms: ${entry.error}`);
        stoppedReason = `failed-at-${sizeBytes}`;
        phase1.ladder.push(entry);
        break;
      }
      phase1.ladder.push(entry);
    }

    phase1.maxSuccessfulBytes = lastSuccessBytes;
    phase1.maxSuccessfulLabel = humanBytes(lastSuccessBytes);
    phase1.stoppedReason = stoppedReason;

    // Write the marker
    const marker = {
      writtenAt: isoNow(),
      writtenAtMs: Date.now(),
      ladderTopBytes: lastSuccessBytes,
      probeVersion: "0.1.0",
      sentinel: "lyriclens-probe-b-phase1-marker"
    };
    try {
      await putRecord(db, STORE_META, MARKER_KEY, marker);
      phase1.marker = marker;
    } catch (e) {
      phase1.markerWriteError = stringifyError(e);
    }

    // Count records in stores
    try {
      phase1.counts = {
        data: await countStore(db, STORE_DATA),
        meta: await countStore(db, STORE_META)
      };
    } catch (e) {
      phase1.counts = { error: stringifyError(e) };
    }

    phase1.verdict = phase1.maxSuccessfulBytes > 0
      ? `WROTE_UP_TO_${phase1.maxSuccessfulLabel}`
      : "NO_WRITE_SUCCEEDED";
    phase1.nextStep = "RESTART NCM (full process) and let probe re-run to verify persistence";

    log("Phase 1 done:", phase1.verdict);
    await writeReport(fs, "phase1", phase1);
    log("=== Phase 1 report written. Restart NCM to run Phase 2. ===");
  }

  // ----- Phase 2: verify marker + read back ladder -----
  async function runPhase2(db, fs, marker) {
    const phase2 = {
      phase: 2,
      capturedAt: isoNow(),
      env: snapshotEnv(),
      marker: marker,
      markerAgeSeconds: marker?.writtenAtMs ? Math.round((Date.now() - marker.writtenAtMs) / 1000) : null,
      ladder: [],
      counts: null,
      verdict: null
    };

    // Re-read every ladder record and confirm bytes survived
    for (const sizeBytes of LADDER_BYTES) {
      const entry = { sizeBytes, label: humanBytes(sizeBytes) };
      try {
        const t0 = perfNow();
        const back = await getRecord(db, STORE_DATA, `ladder-${sizeBytes}`);
        entry.readMs = Math.round(perfNow() - t0);
        entry.present = !!back;
        entry.sizeMatches = back?.bytes?.length === sizeBytes;
        entry.firstByte = back?.bytes?.[0];
      } catch (e) {
        entry.error = stringifyError(e);
      }
      phase2.ladder.push(entry);
    }

    try {
      phase2.counts = {
        data: await countStore(db, STORE_DATA),
        meta: await countStore(db, STORE_META)
      };
    } catch (e) {
      phase2.counts = { error: stringifyError(e) };
    }

    const allPresent = phase2.ladder.every(l => l.present && l.sizeMatches);
    phase2.verdict = allPresent
      ? "PERSISTENCE_OK_ALL_LADDER_BYTES_SURVIVED"
      : "PARTIAL_OR_LOST_DATA_SEE_LADDER";

    // Cleanup so the user's plugin dir doesn't keep the big bytes
    log("Cleaning up probe DB now…");
    try { await clearStore(db, STORE_DATA); } catch (_) {}
    try { await clearStore(db, STORE_META); } catch (_) {}
    db.close();
    try { await deleteDatabase(DB_NAME); phase2.dbDeleted = true; }
    catch (e) { phase2.dbDeleted = false; phase2.deleteError = stringifyError(e); }

    log("Phase 2 done:", phase2.verdict);
    await writeReport(fs, "phase2", phase2);
    log("=== Phase 2 report written. You can uninstall the probe now. ===");
  }

  // ----- IDB helpers -----
  function openProbeDb() {
    return new Promise((resolve) => {
      let justCreated = false;
      const req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        justCreated = true;
        if (!db.objectStoreNames.contains(STORE_DATA)) db.createObjectStore(STORE_DATA);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      };
      req.onsuccess = () => resolve({ db: req.result, justCreated, openError: null });
      req.onerror = () => resolve({ db: null, justCreated: false, openError: stringifyError(req.error) });
      req.onblocked = () => resolve({ db: null, justCreated: false, openError: "blocked: another connection open" });
    });
  }

  function putRecord(db, storeName, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("transaction error"));
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  }

  function getRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const r = tx.objectStore(storeName).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function clearStore(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function countStore(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const r = tx.objectStore(storeName).count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function deleteDatabase(name) {
    return new Promise((resolve, reject) => {
      const r = root.indexedDB.deleteDatabase(name);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("deleteDatabase blocked"));
    });
  }

  function safeReadMarker(db) {
    return getRecord(db, STORE_META, MARKER_KEY).catch(() => null);
  }

  // ----- payload helpers -----
  function makePayload(byteCount) {
    // Wrap the raw bytes in an object so the IDB value isn't a bare
    // typed array (some IDB implementations choke on those directly).
    const bytes = new Uint8Array(byteCount);
    // Sparse fill (every 4096 bytes) to make it more realistic than
    // a constant fill — gives structured-clone more work.
    for (let i = 0; i < byteCount; i += 4096) bytes[i] = (i / 4096) & 0xFF;
    bytes[0] = 0xAB;
    bytes[byteCount - 1] = 0xCD;
    return { bytes, createdAt: isoNow(), byteCount };
  }

  function humanBytes(n) {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${n}B`;
  }

  function snapshotEnv() {
    return {
      userAgent: safeRead(() => navigator.userAgent),
      location: safeRead(() => root.location?.href),
      origin: safeRead(() => root.location?.origin),
      hasIndexedDB: typeof root.indexedDB !== "undefined",
      hasStorage: typeof root.navigator?.storage !== "undefined",
      hasStorageEstimate: typeof root.navigator?.storage?.estimate === "function",
      hasStoragePersist: typeof root.navigator?.storage?.persist === "function"
    };
  }

  async function writeReport(fs, suffix, report) {
    const filename = `${REPORT_PREFIX}${suffix}.json`;
    try {
      const text = safeStringify(report, 2);
      const r = await callMaybeAsync(fs.writeFileText, fs, [REPORT_DIR_PREFIX + filename, text]);
      log(`report → ${filename} (${text.length} chars), writeFileText returned`, r);
    } catch (e) {
      err(`failed to write ${filename}`, e);
    }
  }

  // ----- generic helpers -----
  function log(...args) { console.log(PREFIX, ...args); }
  function err(...args) { console.warn(PREFIX, ...args); }
  function isoNow() { try { return new Date().toISOString(); } catch (_) { return ""; } }
  function perfNow() { try { return performance.now(); } catch (_) { return Date.now(); } }
  function safeRead(fn) { try { return fn(); } catch (e) { return `<<error: ${stringifyError(e)}>>`; } }
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
      if (v instanceof Uint8Array) return `<<Uint8Array length=${v.length} first=${v[0]} last=${v[v.length - 1]}>>`;
      return v;
    }, indent);
  }
  async function callMaybeAsync(fn, ctx, args) {
    const r = fn.apply(ctx, args || []);
    if (r && typeof r.then === "function") return await r;
    return r;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

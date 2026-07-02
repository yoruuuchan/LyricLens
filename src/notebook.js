(function initLyricLensNotebook(root) {
  "use strict";

  /*
   * Notebook store — the plugin half of the cross-host NotebookEntry
   * contract (docs/schema/notebook-entry.md, locked v1 + v1.1 additive).
   * Mirrors the desktop host's src-tauri/src/notebook.rs semantics:
   * validation wording, the seven-step import merge (plus the v1.1
   * mastery rule), the export envelope, and the Anki TSV layout are
   * kept byte-compatible so JSON round-trips between hosts merge
   * instead of duplicating.
   *
   * Storage: IndexedDB (probe B verified persistence across NCM
   * restarts on the orpheus:// origin), fronted by an in-memory mirror
   * so panel renders can query star state synchronously. Any IDB
   * failure degrades to warn + empty/memory-only store — the panel
   * must never break because of the notebook.
   *
   * Mastery is a read-only progress journal here: yes/meh/no can only
   * flow in via JSON import from the Android reviewer app. This host
   * renders the dot and never offers rating buttons (schema doc hard
   * rule — do not add them).
   */

  const SCHEMA_VERSION = "lyriclens.notebook.v1";
  const DB_NAME = "lyriclens-notebook";
  const DB_VERSION = 1;
  const STORE_NAME = "entries";

  const SOURCES = ["plugin", "desktop"];
  const MASTERY_VALUES = ["yes", "meh", "no", "new"];
  const MASTERY_LABELS = { yes: "记住了", meh: "不确定", no: "没记住" };
  const MASTERY_TOOLTIP =
    "复习进度来自安卓单词本 app（read-only，插件端不编辑）";

  const POINT_LABELS = {
    vocabulary: "词汇",
    grammar: "语法",
    culture: "文化背景",
    pronunciation: "发音",
    tone: "语感",
    general: "补充"
  };

  // Desktop's uuid::Uuid::parse_str is version-agnostic; matching the
  // standard hyphenated shape (what both hosts generate) keeps the two
  // validators accepting the same ids.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ── Pure logic layer (no IDB, unit-testable) ─────────────────────

  // Must match desktop src/notebook.ts makeSongKey verbatim — this is
  // the cross-host business identity; a divergence here makes the same
  // starred line import as a duplicate instead of merging.
  function makeSongKey(title, artist, durationMs) {
    return [
      String(title ?? "").trim().toLowerCase(),
      String(artist ?? "").trim().toLowerCase(),
      Math.round(Number(durationMs) / 1000)
    ].join("|");
  }

  function businessKey(songKey, lineIndex) {
    return `${songKey}:${lineIndex}`;
  }

  // crypto.randomUUID landed in Chromium 92; NCM ships 91, so v4 is
  // assembled from getRandomValues with the version/variant bits set.
  function newEntryId() {
    const c = root.crypto || (typeof crypto !== "undefined" ? crypto : null);
    if (typeof c?.randomUUID === "function") return c.randomUUID();
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // RFC3339 with seconds precision, matching desktop's
  // to_rfc3339_opts(SecondsFormat::Secs, true) output shape.
  function toIsoSeconds(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function isMsOrNull(v) {
    return v === null || isFiniteNumber(v);
  }

  // Shape check for the card snapshot. Desktop gets this for free from
  // serde's typed deserialize; here it doubles as both the star-path
  // sanity check and the import-path type gate.
  function validateCard(card) {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      return "card is not an object";
    }
    if (!isFiniteNumber(card.index)) return "card.index is not a number";
    if (!isFiniteNumber(card.lineIndex)) return "card.lineIndex is not a number";
    if (typeof card.original !== "string") return "card.original is not a string";
    if (typeof card.translation !== "string") return "card.translation is not a string";
    if (typeof card.note !== "string") return "card.note is not a string";
    if (!Array.isArray(card.points)) return "card.points is not an array";
    for (const p of card.points) {
      if (!p || typeof p !== "object") return "card.points contains a non-object";
      if (typeof p.type !== "string" || !p.type) return "card.points entry lacks type";
      if (typeof p.text !== "string") return "card.points entry lacks text";
      if (p.surface !== undefined && p.surface !== null && typeof p.surface !== "string") {
        return "card.points surface is not a string";
      }
      if (p.reading !== undefined && p.reading !== null && typeof p.reading !== "string") {
        return "card.points reading is not a string";
      }
    }
    if (!isMsOrNull(card.startMs ?? null)) return "card.startMs is not number|null";
    if (!isMsOrNull(card.endMs ?? null)) return "card.endMs is not number|null";
    return null;
  }

  // Mirrors desktop notebook.rs validate() — same checks, same wording
  // where the desktop has wording. Returns an error string or null.
  function validateEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "entry is not an object";
    }
    if (typeof entry.id !== "string" || !UUID_RE.test(entry.id)) {
      return `id is not a valid uuid: ${JSON.stringify(entry.id)}`;
    }
    if (typeof entry.songKey !== "string" || !entry.songKey.trim()) {
      return "songKey is empty";
    }
    if (typeof entry.songTitle !== "string" || !entry.songTitle.trim()) {
      return "songTitle is empty";
    }
    if (typeof entry.songArtist !== "string" || !entry.songArtist.trim()) {
      return "songArtist is empty";
    }
    if (!Number.isInteger(entry.lineIndex) || entry.lineIndex < 0) {
      return `lineIndex must be >= 0, got ${entry.lineIndex}`;
    }
    if (typeof entry.lineText !== "string" || !entry.lineText.trim()) {
      return "lineText is empty";
    }
    const cardErr = validateCard(entry.card);
    if (cardErr) return cardErr;
    if (typeof entry.userNote !== "string") return "userNote is not a string";
    if (!isFiniteNumber(entry.starredAt)) return "starredAt is not a number";
    if (!isFiniteNumber(entry.updatedAt)) return "updatedAt is not a number";
    if (entry.starredAt > entry.updatedAt) {
      return `starredAt (${entry.starredAt}) must be <= updatedAt (${entry.updatedAt})`;
    }
    if (!SOURCES.includes(entry.source)) {
      return `source must be "plugin" | "desktop", got ${JSON.stringify(entry.source)}`;
    }
    if (entry.importMergedFrom !== undefined) {
      if (!Array.isArray(entry.importMergedFrom)) {
        return "importMergedFrom is not an array";
      }
      for (const id of entry.importMergedFrom) {
        if (typeof id !== "string" || !UUID_RE.test(id)) {
          return `importMergedFrom contains invalid uuid: ${JSON.stringify(id)}`;
        }
      }
    }
    if (!MASTERY_VALUES.includes(entry.mastery)) {
      return `mastery must be one of yes/meh/no/new, got ${JSON.stringify(entry.mastery)}`;
    }
    if (entry.lastReviewedAt !== null) {
      if (!isFiniteNumber(entry.lastReviewedAt)) {
        return "lastReviewedAt is not number|null";
      }
      if (entry.lastReviewedAt <= 0) {
        return `lastReviewedAt must be > 0 when set, got ${entry.lastReviewedAt}`;
      }
    }
    return null;
  }

  // Plugin cards carry legacy aliases (line/highlights/startTime…) for
  // older render paths; the notebook snapshot strips down to the schema
  // AnalysisCard so exports are shaped identically to desktop's.
  function normalizeCardSnapshot(pluginCard) {
    const src = pluginCard || {};
    const rawPoints = Array.isArray(src.points)
      ? src.points
      : Array.isArray(src.highlights)
        ? src.highlights
        : [];
    const points = rawPoints
      .filter((p) => p && typeof p === "object")
      .map((p) => {
        const out = {
          type: typeof p.type === "string" && p.type ? p.type : "general",
          text: String(p.text ?? "")
        };
        if (typeof p.surface === "string" && p.surface.trim()) out.surface = p.surface;
        if (typeof p.reading === "string" && p.reading.trim()) out.reading = p.reading;
        return out;
      });
    const lineIndex = isFiniteNumber(src.lineIndex) ? src.lineIndex : Number(src.index) || 0;
    return {
      index: isFiniteNumber(src.index) ? src.index : lineIndex,
      lineIndex,
      original: String(src.original ?? src.line ?? ""),
      translation: String(src.translation ?? ""),
      points,
      note: String(src.note ?? ""),
      startMs: isFiniteNumber(src.startMs) ? src.startMs : null,
      endMs: isFiniteNumber(src.endMs) ? src.endMs : null
    };
  }

  // Import-side default materialization, mirroring serde's
  // #[serde(default)]: pre-v1.1 exports omit mastery/lastReviewedAt,
  // and importMergedFrom/surface/reading are omitted when absent.
  function withDefaults(entry) {
    const out = { ...entry };
    if (out.mastery === undefined) out.mastery = "new";
    if (out.lastReviewedAt === undefined) out.lastReviewedAt = null;
    if (out.userNote === undefined) out.userNote = "";
    return out;
  }

  // Seven-step merge + v1.1 mastery rule, ported line-for-line from
  // desktop notebook.rs merge_into(). Returns {outcome, entry} where
  // outcome is "merged" | "skipped".
  function mergeEntries(local, incoming, importTsMs) {
    const incomingSource = incoming.source;
    const markerHead = `---来自 ${incomingSource}（`;

    // Schema's "跳过这条" trigger: same source marker already present
    // AND the incoming note text already embedded verbatim. Both checks
    // guard against false positives on a hand-written "---来自" line.
    if (
      incoming.userNote !== "" &&
      local.userNote.includes(markerHead) &&
      local.userNote.includes(incoming.userNote)
    ) {
      return { outcome: "skipped", entry: { ...local } };
    }

    const merged = { ...local };
    // 1. id 保留为 local（clone 已保证）
    // 2. userNote 拼接（incoming 空 → 不动 local）
    if (incoming.userNote !== "") {
      const separator = `\n\n---来自 ${incomingSource}（${toIsoSeconds(importTsMs)}）---\n`;
      merged.userNote = `${local.userNote}${separator}${incoming.userNote}`;
    }
    // 3. card 用 updatedAt 更晚的（防 prompt 回退）
    if (incoming.updatedAt > local.updatedAt) {
      merged.card = incoming.card;
    }
    // 4. starredAt 用更早的（保留最早收藏时间语义）
    merged.starredAt = Math.min(local.starredAt, incoming.starredAt);
    // 5. updatedAt = 本次 import 时间
    merged.updatedAt = importTsMs;
    // 6. importMergedFrom 追加 incoming.id，去重防 A→B→A 死循环
    const from = Array.isArray(local.importMergedFrom) ? local.importMergedFrom.slice() : [];
    if (!from.includes(incoming.id)) from.push(incoming.id);
    merged.importMergedFrom = from;
    // 7. source 不变（合并后仍属于本地 host）
    // 8. v1.1 mastery：权威时间戳是独立的 lastReviewedAt——双 null 保
    //    local；单边非 null 取那边；双非 null 严格更晚才取 incoming。
    const l = local.lastReviewedAt;
    const i = incoming.lastReviewedAt;
    if (l === null && i !== null) {
      merged.mastery = incoming.mastery;
      merged.lastReviewedAt = incoming.lastReviewedAt;
    } else if (l !== null && i !== null && i > l) {
      merged.mastery = incoming.mastery;
      merged.lastReviewedAt = incoming.lastReviewedAt;
    }

    return { outcome: "merged", entry: merged };
  }

  // Serialize one entry with the same key order as desktop's current
  // serde_json golden so pretty-printed exports diff cleanly across
  // hosts. Omission rules mirror serde: importMergedFrom/surface/
  // reading drop when absent; startMs/endMs stay as explicit nulls.
  function serializeEntry(entry) {
    const out = {
      card: {
        endMs: entry.card.endMs ?? null,
        index: entry.card.index,
        lineIndex: entry.card.lineIndex,
        note: entry.card.note,
        original: entry.card.original,
        points: entry.card.points.map((p) => {
          const point = {};
          if (typeof p.reading === "string") point.reading = p.reading;
          if (typeof p.surface === "string") point.surface = p.surface;
          point.text = p.text;
          point.type = p.type;
          return point;
        }),
        startMs: entry.card.startMs ?? null,
        translation: entry.card.translation
      },
      id: entry.id
    };
    if (Array.isArray(entry.importMergedFrom)) {
      out.importMergedFrom = entry.importMergedFrom.slice();
    }
    out.lastReviewedAt = entry.lastReviewedAt ?? null;
    out.lineIndex = entry.lineIndex;
    out.lineText = entry.lineText;
    out.mastery = entry.mastery;
    out.songArtist = entry.songArtist;
    out.songKey = entry.songKey;
    out.songTitle = entry.songTitle;
    out.source = entry.source;
    out.starredAt = entry.starredAt;
    out.updatedAt = entry.updatedAt;
    out.userNote = entry.userNote;
    return out;
  }

  function sortByStarredDesc(entries) {
    return entries.slice().sort((a, b) => b.starredAt - a.starredAt);
  }

  function buildExportEnvelope(entries, nowMs) {
    const ts = isFiniteNumber(nowMs) ? nowMs : Date.now();
    return {
      schema: SCHEMA_VERSION,
      exportedAt: toIsoSeconds(ts),
      exportedFrom: "plugin",
      entries: sortByStarredDesc(entries).map(serializeEntry)
    };
  }

  // ── Anki TSV (schema doc §"Anki CSV 导出", desktop anki_row_for) ──

  function labelOf(type) {
    return POINT_LABELS[type] || "其他";
  }

  function sanitizeAnkiField(s) {
    // \t would break the column count; \n becomes <br> because Anki
    // renders fields as HTML.
    return s.replace(/\t/g, " ").replace(/\n/g, "<br>");
  }

  function sanitizeTagSongKey(songKey) {
    // Anki splits tags on whitespace and treats | specially in search.
    return songKey.replace(/[| ]/g, "_");
  }

  function ankiRowFor(entry) {
    const front = `${entry.songTitle.trim()} — ${entry.songArtist.trim()}\n${entry.lineText.trim()}`;

    // Sections join with a blank line; empty sections drop out so the
    // Back never carries a stray "---" or trailing blank.
    const sections = [];
    const translation = entry.card.translation.trim();
    if (translation) sections.push(translation);
    if (entry.card.points.length > 0) {
      sections.push(
        entry.card.points
          .map((p) => `${labelOf(p.type)}: ${p.text.trim()}`)
          .join("\n")
      );
    }
    const cardNote = entry.card.note.trim();
    if (cardNote) sections.push(cardNote);
    const userNote = entry.userNote.trim();
    if (userNote) sections.push(`---\n${userNote}`);
    const back = sections.join("\n\n");

    const tags = `lyriclens song:${sanitizeTagSongKey(entry.songKey)} source:${entry.source}`;
    return `${sanitizeAnkiField(front)}\t${sanitizeAnkiField(back)}\t${tags}`;
  }

  function buildAnkiTsv(entries) {
    let tsv = "";
    for (const entry of sortByStarredDesc(entries)) {
      tsv += ankiRowFor(entry);
      tsv += "\n";
    }
    return tsv;
  }

  // ── Import envelope parsing ──────────────────────────────────────

  // Unknown schema is a hard error (never best-effort parse). Unlike
  // desktop — where serde's typed deserialize rejects the whole file on
  // one malformed entry — shape problems here are caught per entry by
  // validateEntry and counted as skipped, which is what the schema
  // doc's "报错跳过" wording asks for. Strictly more forgiving than
  // desktop, never less.
  function parseImportEnvelope(raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (err) {
      throw new Error(`JSON 解析失败: ${err?.message || err}`);
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("envelope is not an object");
    }
    if (envelope.schema !== SCHEMA_VERSION) {
      throw new Error(
        `unknown schema version: ${JSON.stringify(envelope.schema)} (expected ${SCHEMA_VERSION})`
      );
    }
    if (!Array.isArray(envelope.entries)) {
      throw new Error("envelope.entries is not an array");
    }
    return envelope;
  }

  // ── Mastery tag (ported from desktop main.ts masteryTag) ─────────

  function masteryTag(mastery, lastReviewedAt, nowMs) {
    if (mastery === "new" || lastReviewedAt === null || lastReviewedAt === undefined) {
      return { cls: "mastery-new", text: "新加 · 从未复习" };
    }
    const now = isFiniteNumber(nowMs) ? nowMs : Date.now();
    const days = Math.floor((now - lastReviewedAt) / 86_400_000);
    const dayText = days <= 0 ? "今天过" : days === 1 ? "昨天过" : `${days} 天前过`;
    return { cls: `mastery-${mastery}`, text: `${MASTERY_LABELS[mastery]} · ${dayText}` };
  }

  // ── Persistence (IndexedDB, swappable for tests) ─────────────────

  function createIdbPersistence() {
    let dbPromise = null;

    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const idb = root.indexedDB;
        if (!idb) {
          reject(new Error("indexedDB 不可用"));
          return;
        }
        const req = idb.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "id" });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // Another tab/version asking for an upgrade: release the
          // connection and let the next call reopen.
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => reject(req.error || new Error("indexedDB open 失败"));
      });
      dbPromise.catch(() => {
        dbPromise = null;
      });
      return dbPromise;
    }

    function requestAsPromise(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("indexedDB request 失败"));
      });
    }

    return {
      async loadAll() {
        const db = await openDb();
        const tx = db.transaction(STORE_NAME, "readonly");
        return requestAsPromise(tx.objectStore(STORE_NAME).getAll());
      },
      async put(entry) {
        const db = await openDb();
        const tx = db.transaction(STORE_NAME, "readwrite");
        return requestAsPromise(tx.objectStore(STORE_NAME).put(entry));
      },
      async remove(id) {
        const db = await openDb();
        const tx = db.transaction(STORE_NAME, "readwrite");
        return requestAsPromise(tx.objectStore(STORE_NAME).delete(id));
      }
    };
  }

  let persistence = createIdbPersistence();

  // ── Store (in-memory mirror + async IDB writes) ──────────────────

  const entriesById = new Map();
  const idByBusinessKey = new Map();
  // "idle" | "loading" | "ready" | "failed:<reason>"
  let storeStatus = "idle";

  function indexEntry(entry) {
    entriesById.set(entry.id, entry);
    idByBusinessKey.set(businessKey(entry.songKey, entry.lineIndex), entry.id);
  }

  function unindexEntry(entry) {
    entriesById.delete(entry.id);
    const key = businessKey(entry.songKey, entry.lineIndex);
    if (idByBusinessKey.get(key) === entry.id) idByBusinessKey.delete(key);
  }

  function persistPut(entry) {
    return persistence.put(entry).catch((err) => {
      console.warn(
        "[LyricLens:notebook]",
        "IDB 写入失败（内存态保留，重启后可能丢这条变更）",
        err?.message || err
      );
    });
  }

  function persistRemove(id) {
    return persistence.remove(id).catch((err) => {
      console.warn("[LyricLens:notebook]", "IDB 删除失败", err?.message || err);
    });
  }

  async function bootstrap() {
    if (storeStatus === "loading" || storeStatus === "ready") return getDiagnostics();
    storeStatus = "loading";
    try {
      const rows = await persistence.loadAll();
      entriesById.clear();
      idByBusinessKey.clear();
      let dropped = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const entry = withDefaults(row);
        const err = validateEntry(entry);
        if (err) {
          dropped += 1;
          console.warn("[LyricLens:notebook]", "本地库有坏条目，已跳过：", err);
          continue;
        }
        indexEntry(entry);
      }
      storeStatus = "ready";
      console.log(
        "[LyricLens:notebook]",
        `ready (${entriesById.size} entries${dropped ? `, ${dropped} dropped` : ""})`
      );
    } catch (err) {
      storeStatus = `failed:${err?.message || err}`;
      console.warn(
        "[LyricLens:notebook]",
        "bootstrap 失败（star 功能禁用，其余功能不受影响）",
        err?.message || err
      );
    }
    return getDiagnostics();
  }

  function isReady() {
    return storeStatus === "ready";
  }

  function getDiagnostics() {
    return { status: storeStatus, count: entriesById.size };
  }

  function getByBusinessKey(songKey, lineIndex) {
    const id = idByBusinessKey.get(businessKey(songKey, lineIndex));
    return id ? entriesById.get(id) || null : null;
  }

  function getById(id) {
    return entriesById.get(id) || null;
  }

  function listEntries() {
    return sortByStarredDesc(Array.from(entriesById.values()));
  }

  function count() {
    return entriesById.size;
  }

  // Star path. snapshot = {songKey, songTitle, songArtist, lineIndex,
  // lineText, card}. On business-key conflict this follows desktop
  // upsert semantics: refresh title/artist/lineText/card/userNote/
  // updatedAt, preserve id/starredAt/source/mastery/lastReviewedAt —
  // re-starring must never blow away the Android side's review
  // progress.
  function starEntry(snapshot, opts = {}) {
    if (!isReady()) return null;
    const now = isFiniteNumber(opts.nowMs) ? opts.nowMs : Date.now();
    const existing = getByBusinessKey(snapshot.songKey, snapshot.lineIndex);
    let entry;
    if (existing) {
      entry = {
        ...existing,
        songTitle: snapshot.songTitle,
        songArtist: snapshot.songArtist,
        lineText: snapshot.lineText,
        card: snapshot.card,
        userNote: snapshot.userNote ?? "",
        updatedAt: now
      };
    } else {
      entry = {
        id: newEntryId(),
        songKey: snapshot.songKey,
        songTitle: snapshot.songTitle,
        songArtist: snapshot.songArtist,
        lineIndex: snapshot.lineIndex,
        lineText: snapshot.lineText,
        card: snapshot.card,
        userNote: snapshot.userNote ?? "",
        starredAt: now,
        updatedAt: now,
        source: "plugin",
        mastery: "new",
        lastReviewedAt: null
      };
    }
    const err = validateEntry(entry);
    if (err) {
      console.warn("[LyricLens:notebook]", "star 快照校验失败：", err);
      return null;
    }
    indexEntry(entry);
    persistPut(entry);
    return entry;
  }

  function unstar(id) {
    const entry = entriesById.get(id);
    if (!entry) return false;
    unindexEntry(entry);
    persistRemove(id);
    return true;
  }

  function unstarByBusinessKey(songKey, lineIndex) {
    const existing = getByBusinessKey(songKey, lineIndex);
    return existing ? unstar(existing.id) : false;
  }

  function updateUserNote(id, note, opts = {}) {
    const entry = entriesById.get(id);
    if (!entry) return null;
    const now = isFiniteNumber(opts.nowMs) ? opts.nowMs : Date.now();
    const updated = { ...entry, userNote: String(note ?? ""), updatedAt: now };
    indexEntry(updated);
    persistPut(updated);
    return updated;
  }

  function removeMany(ids) {
    let removed = 0;
    for (const id of ids) {
      if (unstar(id)) removed += 1;
    }
    return removed;
  }

  // Import path — desktop import_from_json_str semantics: per-entry
  // validation failures are counted and reported, never abort the
  // batch; merged rows are written verbatim (replace, not upsert).
  function importEntries(envelope, opts = {}) {
    const importTsMs = isFiniteNumber(opts.nowMs) ? opts.nowMs : Date.now();
    const summary = {
      totalParsed: envelope.entries.length,
      imported: 0,
      merged: 0,
      skipped: 0,
      errors: []
    };
    for (const raw of envelope.entries) {
      const incoming = withDefaults(raw);
      const err = validateEntry(incoming);
      if (err) {
        summary.skipped += 1;
        summary.errors.push(err);
        continue;
      }
      const local = getByBusinessKey(incoming.songKey, incoming.lineIndex);
      if (!local) {
        indexEntry(incoming);
        persistPut(incoming);
        summary.imported += 1;
        continue;
      }
      const { outcome, entry } = mergeEntries(local, incoming, importTsMs);
      if (outcome === "skipped") {
        summary.skipped += 1;
        continue;
      }
      indexEntry(entry);
      persistPut(entry);
      summary.merged += 1;
    }
    return summary;
  }

  // ── File I/O (export to disk, import from text) ──────────────────
  //
  // Probe B's ruling: exports go through betterncm.fs.writeFile to a
  // findable folder (<BetterNCM data dir>/lyriclens-exports/), because
  // <a download> behavior on the orpheus:// origin is unverified. The
  // betterncm surface is injectable for tests.

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // Local-date filename, matching the desktop host's save-dialog
  // default (lyriclens-notebook-YYYY-MM-DD.{json|tsv}).
  function buildExportFilename(format, nowMs) {
    const d = new Date(isFiniteNumber(nowMs) ? nowMs : Date.now());
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return `lyriclens-notebook-${stamp}.${format === "anki" ? "tsv" : "json"}`;
  }

  async function resolveExportDir(betterncm) {
    let base = null;
    try {
      const fn = betterncm?.app?.getDataPath;
      if (typeof fn === "function") base = await fn.call(betterncm.app);
    } catch (_) {}
    const dir = base ? `${String(base).replace(/[\\/]+$/, "")}/lyriclens-exports` : "./lyriclens-exports";
    try {
      const mkdir = betterncm?.fs?.mkdir;
      if (typeof mkdir === "function") await mkdir.call(betterncm.fs, dir);
    } catch (_) {
      // Already exists (or unsupported) — writeFile decides for real.
    }
    return dir;
  }

  // format: "json" | "anki". Returns {ok, path, count} on success,
  // {ok: false, error} on any failure — callers surface, never throw.
  async function exportToFile(format, opts = {}) {
    const betterncm = opts.betterncm || root.betterncm;
    const writeFile = betterncm?.fs?.writeFile;
    if (typeof writeFile !== "function") {
      return { ok: false, error: "betterncm.fs.writeFile 不可用" };
    }
    try {
      const entries = listEntries();
      const nowMs = isFiniteNumber(opts.nowMs) ? opts.nowMs : Date.now();
      const content = format === "anki"
        ? buildAnkiTsv(entries)
        : `${JSON.stringify(buildExportEnvelope(entries, nowMs), null, 2)}\n`;
      const dir = await resolveExportDir(betterncm);
      const path = `${dir}/${buildExportFilename(format, nowMs)}`;
      const BlobCtor = root.Blob || (typeof Blob !== "undefined" ? Blob : null);
      const payload = BlobCtor
        ? new BlobCtor([content], { type: format === "anki" ? "text/tab-separated-values" : "application/json" })
        : content;
      await writeFile.call(betterncm.fs, path, payload);
      return { ok: true, path, count: entries.length };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // Parse + merge a pasted/picked export file. Returns {ok, summary}
  // or {ok: false, error} (unknown schema, JSON syntax, …).
  function importFromText(text, opts = {}) {
    try {
      const envelope = parseImportEnvelope(text);
      const summary = importEntries(envelope, opts);
      return { ok: true, summary };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // ── Test hooks ───────────────────────────────────────────────────

  function _setPersistenceForTest(fake) {
    persistence = fake || createIdbPersistence();
    entriesById.clear();
    idByBusinessKey.clear();
    storeStatus = "idle";
  }

  const api = {
    SCHEMA_VERSION,
    MASTERY_VALUES,
    MASTERY_LABELS,
    MASTERY_TOOLTIP,
    POINT_LABELS,
    makeSongKey,
    businessKey,
    newEntryId,
    toIsoSeconds,
    validateEntry,
    normalizeCardSnapshot,
    withDefaults,
    mergeEntries,
    serializeEntry,
    buildExportEnvelope,
    buildAnkiTsv,
    parseImportEnvelope,
    masteryTag,
    bootstrap,
    isReady,
    getDiagnostics,
    getByBusinessKey,
    getById,
    listEntries,
    count,
    starEntry,
    unstar,
    unstarByBusinessKey,
    updateUserNote,
    removeMany,
    importEntries,
    buildExportFilename,
    exportToFile,
    importFromText,
    _setPersistenceForTest
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Notebook = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

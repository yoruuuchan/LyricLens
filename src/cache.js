(function initLyricLensCache(root) {
  "use strict";

  const STORAGE_KEY = "lyriclens.cardCache.v1";
  const MAX_ENTRIES = 200;
  const FLUSH_DEBOUNCE_MS = 800;

  function hashString(value) {
    const text = String(value ?? "");
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function buildCacheKey({ songId, lyricsHash, apiEndpoint, modelName, promptVersion }) {
    return [
      String(songId ?? ""),
      String(lyricsHash ?? ""),
      hashString(apiEndpoint),
      String(modelName ?? ""),
      String(promptVersion ?? "")
    ].join(":");
  }

  function createMemoryCache() {
    const map = new Map();
    return {
      get(key) { return map.get(key); },
      set(key, value) { map.set(key, value); return value; },
      has(key) { return map.has(key); },
      delete(key) { return map.delete(key); },
      clear() { map.clear(); },
      size() { return map.size; },
      entries() { return map.entries(); },
      forEach(fn) { map.forEach(fn); }
    };
  }

  function createPersistentCache(options = {}) {
    const storage = options.storage ?? (root && root.localStorage) ?? null;
    const storageKey = options.storageKey || STORAGE_KEY;
    const maxEntries = Number.isFinite(Number(options.maxEntries))
      ? Math.max(10, Math.round(Number(options.maxEntries)))
      : MAX_ENTRIES;
    const flushDebounceMs = Number.isFinite(Number(options.flushDebounceMs))
      ? Math.max(0, Math.round(Number(options.flushDebounceMs)))
      : FLUSH_DEBOUNCE_MS;

    const map = new Map();
    let flushTimer = null;
    let lastWriteFailedAt = 0;

    function loadFromStorage() {
      if (!storage?.getItem) return;
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.entries)) return;
        for (const [k, v] of data.entries) {
          if (typeof k !== "string" || !Array.isArray(v)) continue;
          map.set(k, v);
        }
      } catch (_) {}
    }

    function persistNow() {
      if (!storage?.setItem) return;
      const entries = Array.from(map.entries());
      const payload = JSON.stringify({ version: 1, entries });
      try {
        storage.setItem(storageKey, payload);
        lastWriteFailedAt = 0;
      } catch (err) {
        // QuotaExceededError or similar — shrink to half and retry once.
        lastWriteFailedAt = Date.now();
        const keep = entries.slice(-Math.max(10, Math.floor(entries.length / 2)));
        map.clear();
        for (const [k, v] of keep) map.set(k, v);
        try {
          storage.setItem(storageKey, JSON.stringify({ version: 1, entries: keep }));
          lastWriteFailedAt = 0;
        } catch (_) {
          // give up; in-memory state still usable
        }
      }
    }

    function scheduleFlush() {
      if (!storage?.setItem) return;
      if (flushTimer) return;
      const tick = () => {
        flushTimer = null;
        persistNow();
      };
      if (flushDebounceMs <= 0) {
        tick();
        return;
      }
      flushTimer = setTimeout(tick, flushDebounceMs);
      if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
    }

    function evictIfNeeded() {
      while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    }

    function touch(key) {
      // Re-insert to push to the end of Map iteration order (LRU bump).
      if (!map.has(key)) return;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
    }

    loadFromStorage();

    return {
      get(key) {
        if (!map.has(key)) return undefined;
        touch(key);
        return map.get(key);
      },
      set(key, value) {
        if (map.has(key)) map.delete(key);
        map.set(key, value);
        evictIfNeeded();
        scheduleFlush();
        return value;
      },
      has(key) { return map.has(key); },
      delete(key) {
        const ok = map.delete(key);
        if (ok) scheduleFlush();
        return ok;
      },
      clear() {
        map.clear();
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        try { storage?.removeItem?.(storageKey); } catch (_) {}
      },
      size() { return map.size; },
      entries() { return map.entries(); },
      forEach(fn) { map.forEach(fn); },
      // Diagnostics — not part of the legacy contract
      _flush: persistNow,
      _lastWriteFailedAt: () => lastWriteFailedAt,
      _isPersistent: () => Boolean(storage?.setItem)
    };
  }

  const defaultCache = createPersistentCache();

  const api = {
    hashString,
    buildCacheKey,
    createMemoryCache,
    createPersistentCache,
    defaultCache
  };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Cache = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

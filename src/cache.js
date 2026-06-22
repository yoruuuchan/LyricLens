(function initLyricLensCache(root) {
  "use strict";

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
      get(key) {
        return map.get(key);
      },
      set(key, value) {
        map.set(key, value);
        return value;
      },
      has(key) {
        return map.has(key);
      },
      delete(key) {
        return map.delete(key);
      },
      clear() {
        map.clear();
      },
      size() {
        return map.size;
      }
    };
  }

  const defaultCache = createMemoryCache();
  const api = { hashString, buildCacheKey, createMemoryCache, defaultCache };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Cache = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

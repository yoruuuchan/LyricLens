(function initLyricLensUtils(root) {
  "use strict";

  const LOG_PREFIX = "[LyricLens]";

  function getNamespace() {
    root.LyricLens = root.LyricLens || {};
    return root.LyricLens;
  }

  function log(...args) {
    try {
      console.log(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  function warn(...args) {
    try {
      console.warn(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  function error(...args) {
    try {
      console.error(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
  }

  function safeJsonParse(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  function safeCall(label, fn, fallback) {
    try {
      return fn();
    } catch (err) {
      warn(`${label} failed`, err);
      return fallback;
    }
  }

  function debounce(fn, waitMs) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), waitMs);
    };
  }

  function injectInlineStyle(id, cssText, diagnostics) {
    if (!root.document?.head || !id || typeof cssText !== "string") {
      diagnostics?.recordCss?.("inline-skipped");
      return null;
    }
    let style = root.document.getElementById?.(id) || null;
    if (!style) {
      style = root.document.createElement("style");
      style.id = id;
      style.dataset.llCss = "inline";
      root.document.head.appendChild(style);
    }
    style.textContent = cssText;
    diagnostics?.recordCss?.("inline-injected");
    return style;
  }

  const api = {
    LOG_PREFIX,
    getNamespace,
    log,
    warn,
    error,
    clamp,
    escapeHtml,
    isObject,
    toArray,
    safeJsonParse,
    safeCall,
    debounce,
    injectInlineStyle
  };

  getNamespace().Utils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

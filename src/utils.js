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

  function sha256HexSync(input) {
    let bytes;
    if (input instanceof ArrayBuffer) {
      bytes = new Uint8Array(input);
    } else if (input instanceof Uint8Array) {
      bytes = input;
    } else if (ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
      throw new TypeError("sha256HexSync expects ArrayBuffer or Uint8Array");
    }

    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
      0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
      0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
      0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const w = new Uint32Array(64);
    const bitLengthHi = Math.floor(bytes.length / 0x20000000);
    const bitLengthLo = (bytes.length << 3) >>> 0;
    const totalLength = (((bytes.length + 9 + 63) >>> 6) << 6);
    const padded = new Uint8Array(totalLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(totalLength - 8, bitLengthHi);
    view.setUint32(totalLength - 4, bitLengthLo);

    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < totalLength; offset += 64) {
      for (let i = 0; i < 16; i += 1) {
        w[i] = view.getUint32(offset + i * 4);
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h[0];
      let b = h[1];
      let c = h[2];
      let d = h[3];
      let e = h[4];
      let f = h[5];
      let g = h[6];
      let hh = h[7];

      for (let i = 0; i < 64; i += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }

    return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
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
    injectInlineStyle,
    sha256HexSync
  };

  getNamespace().Utils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

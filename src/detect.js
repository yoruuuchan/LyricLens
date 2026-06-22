(function initLyricLensDetect(root) {
  "use strict";

  const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u;
  const LATIN_RE = /[A-Za-z\u00c0-\u024f]/u;
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const MEANINGFUL_RE = /[\p{L}\p{N}\u3040-\u30ff\u3400-\u9fff]/u;

  function detectLanguage(input) {
    const text = Array.isArray(input) ? input.join("\n") : String(input ?? "");
    let kana = 0;
    let latin = 0;
    let cjk = 0;
    let meaningful = 0;

    for (const char of text) {
      if (!MEANINGFUL_RE.test(char)) continue;
      meaningful += 1;
      if (KANA_RE.test(char)) kana += 1;
      else if (LATIN_RE.test(char)) latin += 1;
      else if (CJK_RE.test(char)) cjk += 1;
    }

    if (kana > 0) return "ja";
    if (meaningful > 0 && latin / meaningful > 0.6) return "en";
    if (cjk > 0) return "other";
    return "other";
  }

  const api = { detectLanguage };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Detect = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

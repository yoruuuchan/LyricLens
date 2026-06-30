(function initLyricLensDetect(root) {
  "use strict";

  const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u;
  const HANGUL_RE = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u;
  const LATIN_RE = /[A-Za-z\u00c0-\u024f]/u;
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const CYRILLIC_RE = /[\u0400-\u04ff]/u;
  const ARABIC_RE = /[\u0600-\u06ff\u0750-\u077f]/u;
  const THAI_RE = /[\u0e00-\u0e7f]/u;
  const MEANINGFUL_RE = /[\p{L}\p{N}\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

  function detectLanguage(input) {
    const text = Array.isArray(input) ? input.join("\n") : String(input ?? "");
    let kana = 0;
    let hangul = 0;
    let latin = 0;
    let cjk = 0;
    let cyrillic = 0;
    let arabic = 0;
    let thai = 0;
    let meaningful = 0;

    for (const char of text) {
      if (!MEANINGFUL_RE.test(char)) continue;
      meaningful += 1;
      if (KANA_RE.test(char)) kana += 1;
      else if (HANGUL_RE.test(char)) hangul += 1;
      else if (CYRILLIC_RE.test(char)) cyrillic += 1;
      else if (ARABIC_RE.test(char)) arabic += 1;
      else if (THAI_RE.test(char)) thai += 1;
      else if (LATIN_RE.test(char)) latin += 1;
      else if (CJK_RE.test(char)) cjk += 1;
    }

    if (kana > 0) return "ja";
    if (hangul > 0) return "ko";
    if (meaningful > 0 && cyrillic / meaningful > 0.3) return "ru";
    if (meaningful > 0 && arabic / meaningful > 0.3) return "ar";
    if (meaningful > 0 && thai / meaningful > 0.3) return "th";
    if (meaningful > 0 && latin / meaningful > 0.6) return "en";
    if (cjk > 0) return "zh";
    return "other";
  }

  const api = { detectLanguage };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Detect = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

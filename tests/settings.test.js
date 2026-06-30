const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_SETTINGS, normalizeSettings } = require("../src/settings");

test("defaults use per-line card generation with full-song limits", () => {
  const settings = normalizeSettings({});

  assert.equal(settings.cardGenerationMode, "per-line");
  assert.equal(settings.maxAnalysisLines, 80);
  // Per-batch output is ~500-1500 tokens; 3000 leaves 2x headroom and
  // reduces KV reserve pressure on upstream APIs.
  assert.equal(settings.analyzeMaxTokens, 3000);
  assert.equal(settings.fallbackMaxLines >= 30, true);
  assert.equal(settings.fallbackMaxTokens, 3000);
  assert.equal(DEFAULT_SETTINGS.cardGenerationMode, "per-line");
  assert.equal(settings.panelTheme, "light");
  assert.equal(settings.panelFontSize, "standard");
  assert.equal(settings.panelOpacity, 0.96);
});

test("normalizeSettings validates panel appearance options", () => {
  const configured = normalizeSettings({ panelTheme: "light", panelFontSize: "large" });
  assert.equal(configured.panelTheme, "light");
  assert.equal(configured.panelFontSize, "large");

  const invalid = normalizeSettings({ panelTheme: "sepia", panelFontSize: "huge" });
  assert.equal(invalid.panelTheme, "light");
  assert.equal(invalid.panelFontSize, "standard");
});

test("normalizeSettings migrates the legacy default panel opacity", () => {
  const legacy = normalizeSettings({ panelOpacity: 0.85 });
  assert.equal(legacy.panelOpacity, 0.96);

  const explicit = normalizeSettings({
    panelOpacity: 0.85,
    panelTheme: "dark",
    panelFontSize: "standard"
  });
  assert.equal(explicit.panelOpacity, 0.85);
});

test("normalizeSettings keeps selected mode when explicitly configured", () => {
  const settings = normalizeSettings({
    cardGenerationMode: "selected",
    analyzeMaxTokens: 20000,
    fallbackMaxTokens: 20000
  });

  assert.equal(settings.cardGenerationMode, "selected");
  assert.equal(settings.analyzeMaxTokens, 16000);
  assert.equal(settings.fallbackMaxTokens, 16000);
});

test("normalizeSettings rejects unknown cardGenerationMode", () => {
  const settings = normalizeSettings({ cardGenerationMode: "other" });

  assert.equal(settings.cardGenerationMode, "per-line");
});

test("normalizeSettings migrates old per-line 24-line limit to full-song default", () => {
  const settings = normalizeSettings({
    cardGenerationMode: "per-line",
    maxAnalysisLines: 24
  });

  assert.equal(settings.maxAnalysisLines, 80);
});

test("normalizeSettings migrates old per-line token and fallback defaults", () => {
  const settings = normalizeSettings({
    cardGenerationMode: "per-line",
    maxAnalysisLines: 24,
    analyzeMaxTokens: 4096,
    fallbackMaxLines: 12,
    fallbackMaxTokens: 1500
  });

  assert.equal(settings.analyzeMaxTokens, 3000);
  assert.equal(settings.fallbackMaxLines, 40);
  assert.equal(settings.fallbackMaxTokens, 3000);
});

test("normalizeSettings migrates previous-default 12000 tokens to new 3000 default", () => {
  const settings = normalizeSettings({
    cardGenerationMode: "per-line",
    maxAnalysisLines: 80,
    analyzeMaxTokens: 12000,
    fallbackMaxLines: 40,
    fallbackMaxTokens: 12000
  });

  assert.equal(settings.analyzeMaxTokens, 3000);
  assert.equal(settings.fallbackMaxTokens, 3000);
});

test("normalizeSettings preserves user-tweaked 12000 tokens if other knobs differ", () => {
  const settings = normalizeSettings({
    cardGenerationMode: "per-line",
    maxAnalysisLines: 60, // user tweaked
    analyzeMaxTokens: 12000,
    fallbackMaxLines: 40,
    fallbackMaxTokens: 12000
  });

  // User has touched maxAnalysisLines, so we don't assume their other values
  // are still defaults — keep their 12000 in place.
  assert.equal(settings.analyzeMaxTokens, 12000);
  assert.equal(settings.fallbackMaxTokens, 12000);
});

test("normalizeSettings preserves explicit small per-line fallback settings", () => {
  const settings = normalizeSettings({
    cardGenerationMode: "per-line",
    maxAnalysisLines: 25,
    analyzeMaxTokens: 4096,
    fallbackMaxLines: 12,
    fallbackMaxTokens: 1500
  });

  assert.equal(settings.maxAnalysisLines, 25);
  assert.equal(settings.analyzeMaxTokens, 4096);
  assert.equal(settings.fallbackMaxLines, 12);
  assert.equal(settings.fallbackMaxTokens, 1500);
});

test("normalizeSettings preserves explicit 24-line limit for selected mode", () => {
  const settings = normalizeSettings({
    cardGenerationMode: "selected",
    maxAnalysisLines: 24
  });

  assert.equal(settings.maxAnalysisLines, 24);
});

test("normalizeSettings defaults enabled to true and treats only explicit false as off", () => {
  // Default-on so a brand-new install / blank config doesn't surprise
  // users with a silent overlay.
  assert.equal(DEFAULT_SETTINGS.enabled, true);
  assert.equal(normalizeSettings({}).enabled, true);
  assert.equal(normalizeSettings({ enabled: true }).enabled, true);

  assert.equal(normalizeSettings({ enabled: false }).enabled, false);

  // Anything other than literal `false` (missing key, 0, "", null,
  // undefined) keeps the plugin enabled — coarse but safer than
  // bouncing the user out of analysis because of a serialization
  // quirk in older configs.
  assert.equal(normalizeSettings({ enabled: 0 }).enabled, true);
  assert.equal(normalizeSettings({ enabled: "" }).enabled, true);
  assert.equal(normalizeSettings({ enabled: null }).enabled, true);
  assert.equal(normalizeSettings({ enabled: undefined }).enabled, true);
});

test("normalizeSettings repairs UTF-8 mojibake in learning prompt settings", () => {
  const settings = normalizeSettings({
    targetLanguage: "ä¸­æ",
    customPrompt: "Content rules:\n- translation must be natural ä¸­æ.\n- note: â¤100 ä¸­æ characters."
  });

  assert.equal(settings.targetLanguage, "中文");
  assert.match(settings.customPrompt, /natural 中文/);
  assert.match(settings.customPrompt, /≤100 中文/);
});

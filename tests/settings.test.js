const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_SETTINGS, normalizeSettings } = require("../src/settings");

test("defaults use per-line card generation with full-song limits", () => {
  const settings = normalizeSettings({});

  assert.equal(settings.cardGenerationMode, "per-line");
  assert.equal(settings.maxAnalysisLines, 80);
  assert.equal(settings.analyzeMaxTokens >= 12000, true);
  assert.equal(settings.fallbackMaxLines >= 30, true);
  assert.equal(settings.fallbackMaxTokens >= 12000, true);
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

  assert.equal(settings.analyzeMaxTokens, 12000);
  assert.equal(settings.fallbackMaxLines, 40);
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

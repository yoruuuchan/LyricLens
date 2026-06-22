(function initLyricLensSettings(root) {
  "use strict";

  const CONFIG_KEY = "lyriclens.config";
  const LOCAL_STORAGE_KEY = "ll-settings";
  const DEFAULT_SETTINGS = {
    apiEndpoint: "",
    apiKey: "",
    modelName: "",
    autoAnalyze: true,
    defaultPosition: "bottomRight",
    panelOpacity: 0.96,
    panelTheme: "light",
    panelFontSize: "standard",
    analyzeTimeoutMs: 60000,
    maxAnalysisLines: 80,
    analyzeMaxTokens: 12000,
    analyzeTemperature: 0.2,
    fallbackOnTimeout: true,
    fallbackMaxLines: 40,
    fallbackMaxTokens: 12000,
    fallbackTimeoutMs: 25000,
    cardGenerationMode: "per-line",
    responseFormatMode: "auto",
    modelThinkingMode: "off",
    companionExePath: ""
  };

  const MODEL_PRESETS = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", model: "deepseek-ai/DeepSeek-V4-Flash" },
    { id: "deepseek-v3.2", name: "DeepSeek V3.2", model: "deepseek-ai/DeepSeek-V3.2" },
    { id: "qwen-2.5-7b", name: "Qwen 2.5 7B", model: "Qwen/Qwen2.5-7B-Instruct" },
    { id: "qwen-2.5-32b", name: "Qwen 2.5 32B", model: "Qwen/Qwen2.5-32B-Instruct" },
    { id: "glm-4-flash", name: "GLM-4 Flash", model: "THUDM/glm-4-9b-chat" }
  ];

  const MIN_TIMEOUT_MS = 15 * 1000;
  const MAX_TIMEOUT_MS = 180 * 1000;
  const MIN_LINES = 5;
  const MAX_LINES = 80;
  const MIN_TOKENS = 256;
  const MAX_TOKENS = 16000;
  const LEGACY_PER_LINE_MAX_ANALYSIS_LINES = 24;
  const LEGACY_PER_LINE_ANALYZE_MAX_TOKENS = 4096;
  const LEGACY_PER_LINE_FALLBACK_MAX_LINES = 12;
  const LEGACY_PER_LINE_FALLBACK_MAX_TOKENS = 1500;
  const LEGACY_PANEL_OPACITY = 0.85;

  function normalizeSettings(value) {
    const input = value && typeof value === "object" ? value : {};
    const opacity = Number(input.panelOpacity);
    const hasLegacyAppearanceDefaults = opacity === LEGACY_PANEL_OPACITY &&
      !Object.prototype.hasOwnProperty.call(input, "panelTheme") &&
      !Object.prototype.hasOwnProperty.call(input, "panelFontSize");
    const cardGenerationMode = ["per-line", "selected"].includes(input.cardGenerationMode)
      ? input.cardGenerationMode
      : DEFAULT_SETTINGS.cardGenerationMode;
    const hasLegacyPerLineDefaults = cardGenerationMode === "per-line" &&
      Number(input.maxAnalysisLines) === LEGACY_PER_LINE_MAX_ANALYSIS_LINES &&
      Number(input.analyzeMaxTokens) === LEGACY_PER_LINE_ANALYZE_MAX_TOKENS &&
      Number(input.fallbackMaxLines) === LEGACY_PER_LINE_FALLBACK_MAX_LINES &&
      Number(input.fallbackMaxTokens) === LEGACY_PER_LINE_FALLBACK_MAX_TOKENS;
    const normalizedMaxAnalysisLines = normalizeInteger(input.maxAnalysisLines, DEFAULT_SETTINGS.maxAnalysisLines, MIN_LINES, MAX_LINES);
    const maxAnalysisLines = cardGenerationMode === "per-line" && Number(input.maxAnalysisLines) === LEGACY_PER_LINE_MAX_ANALYSIS_LINES
      ? DEFAULT_SETTINGS.maxAnalysisLines
      : normalizedMaxAnalysisLines;
    const normalizedAnalyzeMaxTokens = normalizeInteger(input.analyzeMaxTokens, DEFAULT_SETTINGS.analyzeMaxTokens, MIN_TOKENS, MAX_TOKENS);
    const analyzeMaxTokens = hasLegacyPerLineDefaults
      ? DEFAULT_SETTINGS.analyzeMaxTokens
      : normalizedAnalyzeMaxTokens;
    const normalizedFallbackMaxLines = normalizeInteger(input.fallbackMaxLines, DEFAULT_SETTINGS.fallbackMaxLines, MIN_LINES, MAX_LINES);
    const fallbackMaxLines = hasLegacyPerLineDefaults
      ? DEFAULT_SETTINGS.fallbackMaxLines
      : normalizedFallbackMaxLines;
    const normalizedFallbackMaxTokens = normalizeInteger(input.fallbackMaxTokens, DEFAULT_SETTINGS.fallbackMaxTokens, MIN_TOKENS, MAX_TOKENS);
    const fallbackMaxTokens = hasLegacyPerLineDefaults
      ? DEFAULT_SETTINGS.fallbackMaxTokens
      : normalizedFallbackMaxTokens;
    return {
      apiEndpoint: String(input.apiEndpoint ?? ""),
      apiKey: String(input.apiKey ?? ""),
      modelName: String(input.modelName ?? ""),
      autoAnalyze: input.autoAnalyze !== false,
      defaultPosition: ["topLeft", "topRight", "bottomLeft", "bottomRight"].includes(input.defaultPosition)
        ? input.defaultPosition
        : DEFAULT_SETTINGS.defaultPosition,
      panelOpacity: hasLegacyAppearanceDefaults
        ? DEFAULT_SETTINGS.panelOpacity
        : (Number.isFinite(opacity) ? clamp(opacity, 0.5, 1) : DEFAULT_SETTINGS.panelOpacity),
      panelTheme: ["dark", "light"].includes(input.panelTheme)
        ? input.panelTheme
        : DEFAULT_SETTINGS.panelTheme,
      panelFontSize: ["compact", "standard", "large"].includes(input.panelFontSize)
        ? input.panelFontSize
        : DEFAULT_SETTINGS.panelFontSize,
      analyzeTimeoutMs: normalizeNumber(input.analyzeTimeoutMs, DEFAULT_SETTINGS.analyzeTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      maxAnalysisLines,
      analyzeMaxTokens,
      analyzeTemperature: normalizeNumber(input.analyzeTemperature, DEFAULT_SETTINGS.analyzeTemperature, 0, 1),
      fallbackOnTimeout: input.fallbackOnTimeout !== false,
      fallbackMaxLines,
      fallbackMaxTokens,
      fallbackTimeoutMs: normalizeNumber(input.fallbackTimeoutMs, DEFAULT_SETTINGS.fallbackTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      cardGenerationMode,
      modelThinkingMode: ["auto", "off", "high", "max"].includes(input.modelThinkingMode)
        ? input.modelThinkingMode
        : DEFAULT_SETTINGS.modelThinkingMode,
      responseFormatMode: ["auto", "json_object", "off"].includes(input.responseFormatMode)
        ? input.responseFormatMode
        : DEFAULT_SETTINGS.responseFormatMode,
      companionExePath: String(input.companionExePath ?? "").trim()
    };
  }

  function normalizeNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, min, max) : fallback;
  }

  function normalizeInteger(value, fallback, min, max) {
    return Math.round(normalizeNumber(value, fallback, min, max));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isApiConfigured(settings) {
    const value = normalizeSettings(settings);
    return Boolean(value.apiEndpoint.trim() && value.apiKey.trim() && value.modelName.trim());
  }

  async function readSettings() {
    const fallback = readLocalSettings();
    const serializedDefault = JSON.stringify(fallback);
    const Diagnostics = root.LyricLens?.Diagnostics;
    if (Diagnostics?.safeReadConfig) {
      try {
        const result = await Diagnostics.safeReadConfig(root, CONFIG_KEY, serializedDefault);
        if (result.ok) return normalizeSettings(JSON.parse(result.value || serializedDefault));
        console.warn("[LyricLens]", "readConfig 不可用，使用 localStorage", result);
      } catch (err) {
        console.warn("[LyricLens]", "readConfig 失败，使用 localStorage", err);
      }
    }
    return fallback;
  }

  async function writeSettings(settings) {
    const normalized = normalizeSettings(settings);
    const serialized = JSON.stringify(normalized);
    const Diagnostics = root.LyricLens?.Diagnostics;
    if (Diagnostics?.safeWriteConfig) {
      try {
        const result = await Diagnostics.safeWriteConfig(root, CONFIG_KEY, serialized);
        if (!result.ok) console.warn("[LyricLens]", "writeConfig 不可用，写入 localStorage", result);
      } catch (err) {
        console.warn("[LyricLens]", "writeConfig 失败，写入 localStorage", err);
      }
    }
    writeLocalSettings(normalized);
    return normalized;
  }

  function readLocalSettings() {
    try {
      const raw = root.localStorage?.getItem(LOCAL_STORAGE_KEY);
      if (raw) return normalizeSettings(JSON.parse(raw));
    } catch (err) {
      console.warn("[LyricLens]", "localStorage 配置读取失败", err);
    }
    return normalizeSettings(DEFAULT_SETTINGS);
  }

  function writeLocalSettings(settings) {
    try {
      root.localStorage?.setItem(LOCAL_STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
    } catch (err) {
      console.warn("[LyricLens]", "localStorage 配置写入失败", err);
    }
  }

  const api = {
    CONFIG_KEY,
    DEFAULT_SETTINGS,
    MODEL_PRESETS,
    normalizeSettings,
    isApiConfigured,
    readSettings,
    writeSettings,
    readLocalSettings,
    writeLocalSettings
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Settings = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

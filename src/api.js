(function initLyricLensApi(root) {
  "use strict";

  const PROMPT_VERSION = "v2";
  const ANALYSIS_REQUEST_TIMEOUT_FALLBACK_MS = 60000;
  const TEST_CONNECTION_TIMEOUT_MS = 12000;

  function normalizeChatCompletionsEndpoint(endpoint) {
    const raw = String(endpoint ?? "").trim();
    if (!raw) return "";
    const stripped = raw.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(stripped)) return stripped;
    if (/\/v1$/i.test(stripped)) return `${stripped}/chat/completions`;
    return stripped;
  }

  function safeUpdateDiagnostics(partial) {
    try {
      root.LyricLens?.diagnostics?.updateState?.(partial);
    } catch (_) {}
  }

  const SYSTEM_PROMPTS = {
    en: `You are an English learning assistant. The user provides timed song lyrics. Generate one learning card for every input lyric line.

Return ONLY a JSON object — no markdown, no code fences, no explanations.

Required shape:
{"cards":[{"lineIndex":0,"startMs":1234,"endMs":5678,"original":"...","translation":"...","points":["..."],"note":"..."}]}

Rules:
- cards.length must equal input lines.length.
- Do not skip simple lines. If there is no grammar or vocabulary worth teaching, points can be [] and note should briefly explain tone, feeling, or meaning.
- lineIndex must exactly match the input line index.
- startMs/endMs should be copied from input when present.
- original must be the exact original lyric, do not rewrite.
- translation must be natural Chinese.
- points: at most 1-2 items, each ≤50 Chinese characters. Avoid filler.
- note: ≤100 Chinese characters.
- If a referenceTranslation is provided, use it only as reference; do not mechanically copy it.
- No markdown. No code block. No text outside the JSON.`,

    ja: `You are a Japanese learning assistant. The user provides timed Japanese song lyrics. Generate one learning card for every input lyric line.

Return ONLY a JSON object — no markdown, no code fences, no explanations.

Required shape:
{"cards":[{"lineIndex":0,"startMs":1234,"endMs":5678,"original":"...","translation":"...","points":["..."],"note":"..."}]}

Rules:
- cards.length must equal input lines.length.
- Do not skip simple lines. If there is no vocabulary, grammar, or expression worth teaching, points can be [] and note should briefly explain tone, feeling, or meaning.
- lineIndex must exactly match the input line index.
- startMs/endMs should be copied from input when present.
- original must be the exact original lyric, do not rewrite.
- translation must be natural Chinese.
- points: at most 1-2 items, each ≤50 Chinese characters. Prefer useful words, grammar, expressions, or nuance. Avoid filler.
- note: ≤100 Chinese characters.
- If referenceTranslation or romanLyric is provided, use it only as reference.
- No markdown. No code block. No text outside the JSON.`
  };

  const SELECTED_PROMPTS = {
    en: `You are an English learning assistant. The user provides song lyrics with line numbers in [index] text format.

Pick 6-8 most valuable lines to learn from. Return ONLY a JSON object — no markdown, no code fences, no explanations.

Shape: {"cards":[{"lineIndex":0,"original":"...","translation":"...","points":["...","..."],"note":"..."}]}

Rules:
- lineIndex: the original line number.
- original: exact lyric line, don't rewrite.
- translation: short Chinese translation, one sentence.
- points: at most 2 learning points, each ≤24 Chinese characters.
- note: cultural or usage note, ≤60 Chinese characters. Can be empty string.
- If fewer than 6 lines have learning value, return fewer cards — never pad.
- No markdown. No code block. No explanatory text outside the JSON.`,

    ja: `You are a Japanese learning assistant. The user provides song lyrics with line numbers in [index] text format.

Pick 6-8 most valuable lines to learn from. Return ONLY a JSON object — no markdown, no code fences, no explanations.

Shape: {"cards":[{"lineIndex":0,"original":"...","translation":"...","points":["...","..."],"note":"..."}]}

Rules:
- lineIndex: the original line number.
- original: exact lyric line, don't rewrite.
- translation: short Chinese translation, one sentence.
- points: at most 2 learning points (word/grammar/expression), each ≤24 Chinese characters.
- note: cultural or usage note, ≤60 Chinese characters. Can be empty string.
- If fewer than 6 lines have learning value, return fewer cards — never pad.
- No markdown. No code block. No explanatory text outside the JSON.`
  };

  const FALLBACK_PROMPTS = {
    en: `Generate one short card for every input English lyric line. Return ONLY JSON: {"cards":[{"lineIndex":0,"startMs":0,"endMs":0,"original":"...","translation":"...","points":[],"note":"..."}]}. cards.length must equal input lines.length. points max 1 item. No markdown.`,

    ja: `Generate one short card for every input Japanese lyric line. Return ONLY JSON: {"cards":[{"lineIndex":0,"startMs":0,"endMs":0,"original":"...","translation":"...","points":[],"note":"..."}]}. cards.length must equal input lines.length. points max 1 item. No markdown.`
  };

  const SELECTED_FALLBACK_PROMPTS = {
    en: `Pick 2-4 most valuable English lyric lines. Return ONLY a JSON object: {"cards":[{"lineIndex":0,"original":"...","translation":"...","points":["..."],"note":""}]}. Each field must be short. No markdown. No code blocks. No explanations. If unsure, return fewer cards.`,

    ja: `Pick 2-4 most valuable Japanese lyric lines. Return ONLY a JSON object: {"cards":[{"lineIndex":0,"original":"...","translation":"...","points":["..."],"note":""}]}. Each field must be short. No markdown. No code blocks. No explanations. If unsure, return fewer cards.`
  };

  class TimeoutError extends Error {
    constructor(message = "请求超时") {
      super(message);
      this.name = "TimeoutError";
    }
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  class NetworkError extends Error {
    constructor(message, originalMessage) {
      super(message);
      this.name = "NetworkError";
      this.originalMessage = originalMessage || "";
    }
  }

  class ApiParseError extends Error {
    constructor(message, info = {}) {
      super(message);
      this.name = "ApiParseError";
      this.stage = info.stage || "parse";
      this.contentSample = info.contentSample || "";
      this.responseTextSample = info.responseTextSample || "";
      this.requestUrl = info.requestUrl;
    }
  }

  function sampleString(value, maxLength = 500) {
    const text = String(value ?? "");
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…(${text.length})`;
  }

  function normalizeCardGenerationMode(mode) {
    return mode === "selected" ? "selected" : "per-line";
  }

  function getSystemPrompt(language, isFallback, cardGenerationMode) {
    const mode = normalizeCardGenerationMode(cardGenerationMode);
    if (mode === "selected") {
      if (isFallback && SELECTED_FALLBACK_PROMPTS[language]) return SELECTED_FALLBACK_PROMPTS[language];
      return SELECTED_PROMPTS[language] || SELECTED_PROMPTS.en;
    }
    if (isFallback && FALLBACK_PROMPTS[language]) return FALLBACK_PROMPTS[language];
    return SYSTEM_PROMPTS[language] || SYSTEM_PROMPTS.en;
  }

  function buildChatRequestBody({ modelName, language, formattedLyrics, maxTokens, temperature, thinkingMode, responseFormatMode, isFallback, cardGenerationMode }) {
    const generationMode = normalizeCardGenerationMode(cardGenerationMode);
    const body = {
      model: modelName,
      messages: [
        { role: "system", content: getSystemPrompt(language, isFallback, generationMode) },
        { role: "user", content: formattedLyrics }
      ],
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.3
    };
    if (Number.isFinite(Number(maxTokens))) {
      body.max_tokens = Number(maxTokens);
    }
    const mode = thinkingMode || "off";
    const isDeepSeekV4 = typeof modelName === "string" && /deepseek.*v4/i.test(modelName);
    let thinkingPayload = null;
    if (isDeepSeekV4 && mode === "off") {
      thinkingPayload = { thinking: { type: "disabled" } };
      body.thinking = { type: "disabled" };
    } else if (isDeepSeekV4 && (mode === "high" || mode === "max")) {
      thinkingPayload = { reasoning_effort: mode };
      body.reasoning_effort = mode;
    }
    safeUpdateDiagnostics({
      cardGenerationMode: generationMode,
      modelThinkingMode: mode,
      lastRequestThinkingPayload: thinkingPayload,
      reasoningEffort: isDeepSeekV4 ? mode : null
    });
    const rfMode = responseFormatMode || "auto";
    if (rfMode === "json_object" || rfMode === "auto") {
      body.response_format = { type: "json_object" };
      safeUpdateDiagnostics({
        responseFormatMode: rfMode,
        lastRequestResponseFormat: { type: "json_object" }
      });
    } else {
      safeUpdateDiagnostics({
        responseFormatMode: rfMode,
        lastRequestResponseFormat: null
      });
    }
    return body;
  }

  function normalizePoints(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string" && item.trim()).map((item) => String(item).slice(0, 200));
  }

  function rawContentSample(content) {
    const text = String(content ?? "");
    if (text.length <= 1000) return text;
    return `${text.slice(0, 500)}…[${text.length - 1000} chars]…${text.slice(-500)}`;
  }

  function parseCompletionJsonWithReport(content) {
    const text = String(content ?? "").trim();
    let strategy = null;
    let parsed = null;

    // Strategy 1: direct parse
    try {
      parsed = JSON.parse(text);
      strategy = "direct";
      return { parsed, strategy };
    } catch (_) {}

    // Strategy 2: extract from fenced code block
    const fenceMatch = text.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
        strategy = "fenced-code";
        return { parsed, strategy };
      } catch (_) {}
    }

    // Strategy 3: slice first { to last }
    const objStart = text.indexOf("{");
    const objEnd = text.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      try {
        parsed = JSON.parse(text.slice(objStart, objEnd + 1));
        strategy = "object-slice";
        return { parsed, strategy };
      } catch (_) {}
    }

    // Strategy 4: slice first [ to last ], wrap as { cards: array }
    const arrStart = text.indexOf("[");
    const arrEnd = text.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        const array = JSON.parse(text.slice(arrStart, arrEnd + 1));
        if (Array.isArray(array)) {
          parsed = { cards: array };
          strategy = "array-slice";
          return { parsed, strategy };
        }
      } catch (_) {}
    }

    return { parsed: null, strategy: null };
  }

  function stripMarkdownCodeFence(content) {
    const text = String(content ?? "").trim();
    const fence = text.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
    if (fence) return fence[1].trim();
    return text;
  }

  function parseCompletionJson(content) {
    const report = parseCompletionJsonWithReport(content);
    if (report.parsed) {
      if (Array.isArray(report.parsed)) return { cards: report.parsed };
      return report.parsed;
    }
    throw new Error("无法解析 JSON");
  }

  function extractAssistantContent(responseJson) {
    return responseJson?.choices?.[0]?.message?.content ?? responseJson?.choices?.[0]?.text ?? "";
  }

  function normalizeCardIndex(card) {
    if (Number.isInteger(card?.lineIndex)) return card.lineIndex;
    if (Number.isInteger(card?.index)) return card.index;
    const numericIndex = Number(card?.lineIndex ?? card?.index);
    return Number.isInteger(numericIndex) ? numericIndex : null;
  }

  function normalizeLineStart(line) {
    const value = Number(line?.startTime ?? line?.startMs);
    return Number.isFinite(value) ? value : null;
  }

  function normalizeLineEnd(line, nextLine) {
    const value = Number(line?.endTime ?? line?.endMs);
    if (Number.isFinite(value)) return value;
    const nextStart = normalizeLineStart(nextLine);
    return Number.isFinite(nextStart) ? nextStart : null;
  }

  function normalizeCardsWithReport(parsed, lines) {
    const lyricLines = Array.isArray(lines) ? lines : [];
    const validIndexes = new Set(lyricLines.map((line) => line.index));
    const lineByIndex = new Map(lyricLines.map((line, position) => [line.index, { line, position }]));
    const rawCards = Array.isArray(parsed?.cards) ? parsed.cards : [];
    const dropReasons = {
      notObject: 0,
      missingIndex: 0,
      indexNotInLines: 0,
      relativeIndexRecovered: 0
    };
    const droppedSamples = [];
    const result = [];
    for (const card of rawCards) {
      if (!card || typeof card !== "object") {
        dropReasons.notObject += 1;
        if (droppedSamples.length < 3) droppedSamples.push({ reason: "notObject", value: String(card).slice(0, 80) });
        continue;
      }
      const cardIndex = normalizeCardIndex(card);
      if (!Number.isInteger(cardIndex)) {
        dropReasons.missingIndex += 1;
        if (droppedSamples.length < 3) droppedSamples.push({ reason: "missingIndex", index: card.index, line: String(card.line ?? "").slice(0, 80) });
        continue;
      }
      let resolvedIndex = cardIndex;
      let match = lineByIndex.get(cardIndex);
      if (!validIndexes.has(cardIndex)) {
        const positionalLine = cardIndex >= 0 && cardIndex < lyricLines.length ? lyricLines[cardIndex] : null;
        if (positionalLine && Number.isInteger(positionalLine.index)) {
          resolvedIndex = positionalLine.index;
          match = { line: positionalLine, position: cardIndex };
          dropReasons.relativeIndexRecovered += 1;
        }
      }
      if (!validIndexes.has(resolvedIndex)) {
        dropReasons.indexNotInLines += 1;
        if (droppedSamples.length < 3) droppedSamples.push({ reason: "indexNotInLines", index: cardIndex, line: String(card.line ?? "").slice(0, 80) });
        continue;
      }
      const lyricLine = match?.line;
      const nextLine = lyricLines[(match?.position ?? -1) + 1];
      const original = String(lyricLine?.text ?? card.original ?? card.line ?? "");
      const startMs = normalizeLineStart(lyricLine);
      const endMs = normalizeLineEnd(lyricLine, nextLine);
      const points = normalizePoints(card.points || card.highlights);
      result.push({
        index: resolvedIndex,
        lineIndex: resolvedIndex,
        original,
        line: String(card.original || card.line || original),
        translation: String(card.translation ?? ""),
        startMs,
        startTime: startMs,
        endMs,
        endTime: endMs,
        points,
        note: String(card.note ?? ""),
        highlights: points
      });
    }
    return {
      cards: result,
      parsedCount: rawCards.length,
      normalizedCount: result.length,
      dropReasons,
      droppedSamples
    };
  }

  function normalizeCards(parsed, lines) {
    return normalizeCardsWithReport(parsed, lines).cards;
  }

  function abortErrorName(error) {
    return error?.name === "AbortError" || String(error?.message || "").includes("abort");
  }

  async function requestAnalysis({
    apiEndpoint,
    apiKey,
    modelName,
    language,
    formattedLyrics,
    maxTokens,
    temperature,
    thinkingMode,
    responseFormatMode,
    isFallback,
    cardGenerationMode,
    signal,
    fetchImpl,
    timeoutMs = ANALYSIS_REQUEST_TIMEOUT_FALLBACK_MS
  }) {
    const fetcher = fetchImpl || root.fetch;
    if (typeof fetcher !== "function") {
      throw new ApiError("当前环境不可用 fetch");
    }

    const requestUrl = normalizeChatCompletionsEndpoint(apiEndpoint);
    safeUpdateDiagnostics({ lastRequestUrl: requestUrl });

    const actualTimeoutMs = Number.isFinite(Number(timeoutMs))
      ? Number(timeoutMs)
      : ANALYSIS_REQUEST_TIMEOUT_FALLBACK_MS;
    const startedAt = Date.now();
    let currentRfMode = responseFormatMode || "auto";
    let responseFormatUnsupported = false;
    let responseFormatFallbackAttempted = false;

    async function sendRequest(rfModeOverride) {
      const rfMode = rfModeOverride !== undefined ? rfModeOverride : currentRfMode;
      return buildChatRequestBody({
        modelName, language, formattedLyrics, maxTokens, temperature,
        thinkingMode, responseFormatMode: rfMode, isFallback, cardGenerationMode
      });
    }

    let body = await sendRequest();
    const bodyString = JSON.stringify(body);
    safeUpdateDiagnostics({
      lastRequestStartedAt: startedAt,
      lastRequestEndedAt: null,
      lastRequestDurationMs: null,
      timeoutStage: null,
      lastRequestModel: modelName,
      lastRequestMaxTokens: Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : null,
      lastRequestTemperature: Number.isFinite(Number(temperature)) ? Number(temperature) : body.temperature,
      analyzeTimeoutMs: actualTimeoutMs,
      promptCharCount: String(formattedLyrics ?? "").length,
      requestBodySize: bodyString.length
    });

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, actualTimeoutMs);

    const relayAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", relayAbort, { once: true });
    }

    let attemptCount = 0;

    try {
      while (attemptCount < 2) {
        attemptCount += 1;
        const bodyString = JSON.stringify(body);

        const response = await fetcher(requestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: bodyString,
          signal: controller.signal
        });

        safeUpdateDiagnostics({ lastResponseStatus: response.status });

        let responseText = "";
        try {
          responseText = await response.text();
        } catch (_) {}
        const responseTextSample = sampleString(responseText, 500);
        safeUpdateDiagnostics({ lastResponseTextSample: responseTextSample });

        if (!response.ok) {
          const status = response.status;
          if (status === 400 && currentRfMode === "auto" && !responseFormatFallbackAttempted) {
            const errorText = responseText.toLowerCase();
            if (/response_format|response format/i.test(errorText)) {
              safeUpdateDiagnostics({
                responseFormatUnsupported: true,
                responseFormatFallbackAttempted: true
              });
              responseFormatFallbackAttempted = true;
              currentRfMode = "off";
              body = await sendRequest("off");
              continue;
            }
          }
          const err = new ApiError(`API 请求失败：HTTP ${response.status}`, status);
          err.requestUrl = requestUrl;
          err.responseTextSample = responseTextSample;
          throw err;
        }

        let responseJson;
        try {
          responseJson = JSON.parse(responseText);
        } catch (_) {
          throw new ApiParseError("API 响应不是合法 JSON", {
            stage: "response-json",
            responseTextSample,
            contentSample: responseTextSample,
            requestUrl
          });
        }

        const usage = responseJson?.usage;
        if (usage) {
          const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? null;
          const completionTokens = usage.completion_tokens;
          safeUpdateDiagnostics({
            responsePromptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
            responseCompletionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
            responseReasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : null,
            responseTotalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null
          });
        }
        const finishReason = responseJson?.choices?.[0]?.finish_reason || null;
        if (finishReason) {
          safeUpdateDiagnostics({ finishReason });
        }

        const content = extractAssistantContent(responseJson);
        const contentSample = sampleString(content, 500);
        safeUpdateDiagnostics({ lastParsedContentSample: contentSample });

        if (!content) {
          throw new ApiParseError("API 返回内容为空", {
            stage: "missing-content",
            responseTextSample,
            contentSample,
            requestUrl
          });
        }

        const parseReport = parseCompletionJsonWithReport(content);
        safeUpdateDiagnostics({
          extractedJsonStrategy: parseReport.strategy,
          rawContentSample: rawContentSample(content),
          rawContentLength: content.length,
          finishReasonWasLength: finishReason === "length"
        });

        if (parseReport.parsed) {
          if (finishReason === "length") {
            const parseErr = new ApiParseError("模型输出太长被截断，无法解析完整 JSON", {
              stage: "truncated-content",
              contentSample: rawContentSample(content),
              responseTextSample,
              requestUrl
            });
            parseErr.finishReasonWasLength = true;
            parseErr.rawContentLength = content.length;
            parseErr.extractedJsonStrategy = parseReport.strategy;
            throw parseErr;
          }
          return parseReport.parsed;
        }

        const parseErr = new ApiParseError("API 返回的 content 不是合法 JSON", {
          stage: "content-json",
          contentSample: rawContentSample(content),
          responseTextSample,
          requestUrl
        });
        parseErr.finishReasonWasLength = finishReason === "length";
        parseErr.rawContentLength = content.length;
        parseErr.extractedJsonStrategy = parseReport.strategy;
        if (finishReason === "length") {
          parseErr.message = "模型输出被截断，JSON 无法解析";
        }
        throw parseErr;
      }
    } catch (err) {
      if (timedOut && abortErrorName(err)) {
        safeUpdateDiagnostics({ timeoutStage: "fetch" });
        const timeoutErr = new TimeoutError();
        timeoutErr.requestUrl = requestUrl;
        throw timeoutErr;
      }
      if (err && !err.requestUrl) err.requestUrl = requestUrl;
      if (classifyFetchError(err)) {
        const networkErr = new NetworkError(
          `网络错误：${err.message || String(err)}`,
          err.message || String(err)
        );
        networkErr.requestUrl = requestUrl;
        throw networkErr;
      }
      throw err;
    } finally {
      const endedAt = Date.now();
      safeUpdateDiagnostics({
        lastRequestEndedAt: endedAt,
        lastRequestDurationMs: Math.max(0, endedAt - startedAt)
      });
      clearTimeout(timeout);
      if (signal) signal.removeEventListener?.("abort", relayAbort);
    }
  }

  function classifyFetchError(err) {
    if (!err) return false;
    const msg = String(err?.message || err);
    return /failed to fetch|networkerror|fetch failed|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|network request failed/i.test(msg);
  }

  function describeHttpStatus(status) {
    if (status === 401 || status === 403) return "密钥或权限问题";
    if (status === 404) return "endpoint 或 model 不存在";
    if (status === 429) return "额度/限流";
    if (status >= 500 && status < 600) return "服务端错误";
    return "";
  }

  async function testConnection({
    apiEndpoint,
    apiKey,
    modelName,
    fetchImpl,
    timeoutMs = TEST_CONNECTION_TIMEOUT_MS
  } = {}) {
    const trimmedEndpoint = String(apiEndpoint ?? "").trim();
    const trimmedKey = String(apiKey ?? "").trim();
    const trimmedModel = String(modelName ?? "").trim();

    if (!trimmedEndpoint) {
      return { ok: false, status: null, requestUrl: null, message: "请填写 API Endpoint" };
    }
    if (!trimmedKey) {
      return { ok: false, status: null, requestUrl: null, message: "请填写 API Key" };
    }
    if (!trimmedModel) {
      return { ok: false, status: null, requestUrl: null, message: "请填写 Model 名称" };
    }

    const requestUrl = normalizeChatCompletionsEndpoint(trimmedEndpoint);
    const fetcher = fetchImpl || root.fetch;
    if (typeof fetcher !== "function") {
      return { ok: false, status: null, requestUrl, message: "当前环境不可用 fetch" };
    }

    safeUpdateDiagnostics({ lastRequestUrl: requestUrl });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetcher(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${trimmedKey}`
        },
        body: JSON.stringify({
          model: trimmedModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0
        }),
        signal: controller.signal
      });

      const status = response.status;
      if (response.ok) {
        return {
          ok: true,
          status,
          requestUrl,
          message: `连接成功：HTTP ${status}`
        };
      }

      let detail = "";
      try {
        const text = await response.text();
        if (text) detail = `：${String(text).slice(0, 200)}`;
      } catch (_) {}

      const reason = describeHttpStatus(status);
      const reasonText = reason ? `（${reason}）` : "";
      return {
        ok: false,
        status,
        requestUrl,
        message: `连接失败：HTTP ${status}${reasonText}${detail}`,
        rawError: `HTTP ${status}${detail}`
      };
    } catch (err) {
      if (timedOut) {
        return {
          ok: false,
          status: null,
          requestUrl,
          message: "连接失败：请求超时",
          rawError: "timeout"
        };
      }
      const message = String(err?.message || err);
      const isNetwork = /failed to fetch|networkerror|fetch failed/i.test(message);
      return {
        ok: false,
        status: null,
        requestUrl,
        message: isNetwork ? `连接失败：网络错误（${message}）` : `连接失败：${message}`,
        rawError: message
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function testAnalyzeSpeed(options = {}) {
    const {
      apiEndpoint,
      apiKey,
      modelName,
      lyricsLines,
      thinkingMode,
      fetchImpl,
      timeoutMs = 30000
    } = options;
    const startedAt = Date.now();
    const result = {
      speedTestModel: modelName || "",
      speedTestStartedAt: startedAt,
      speedTestDurationMs: null,
      speedTestStatus: "running",
      speedTestError: null,
      speedTestResponseSample: null,
      speedTestThinkingMode: thinkingMode || "off",
      speedTestPromptCharCount: 0,
      speedTestRequestBodySize: 0,
      speedTestTokens: null
    };

    const fetcher = fetchImpl || root.fetch;
    if (typeof fetcher !== "function") {
      result.speedTestStatus = "error";
      result.speedTestError = "fetch 不可用";
      result.speedTestDurationMs = Date.now() - startedAt;
      return result;
    }

    if (!apiEndpoint || !apiKey || !modelName) {
      result.speedTestStatus = "error";
      result.speedTestError = "缺少 endpoint / key / model";
      result.speedTestDurationMs = Date.now() - startedAt;
      return result;
    }

    const sampleLines = (Array.isArray(lyricsLines) ? lyricsLines : []).slice(0, 8);
    if (!sampleLines.length) {
      result.speedTestStatus = "error";
      result.speedTestError = "无可用的歌词行";
      result.speedTestDurationMs = Date.now() - startedAt;
      return result;
    }

    const miniLyrics = sampleLines.map((line, i) => `[${i}] ${line.text || ""}`).join("\n");
    const miniPrompt = `请为以下歌词生成1-2张学习卡片。严格按JSON返回 {"cards":[{...}]}。\n${miniLyrics}`;
    result.speedTestPromptCharCount = miniPrompt.length;

    const body = buildChatRequestBody({
      modelName,
      language: "en",
      formattedLyrics: miniLyrics,
      maxTokens: 512,
      temperature: 0.2,
      thinkingMode
    });
    const bodyString = JSON.stringify(body);
    result.speedTestRequestBodySize = bodyString.length;

    const requestUrl = normalizeChatCompletionsEndpoint(apiEndpoint);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetcher(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: bodyString,
        signal: controller.signal
      });

      if (!response.ok) {
        result.speedTestStatus = "error";
        result.speedTestError = `HTTP ${response.status}`;
        result.speedTestDurationMs = Date.now() - startedAt;
        return result;
      }

      let responseText = "";
      try { responseText = await response.text(); } catch (_) {}
      let responseJson;
      try { responseJson = JSON.parse(responseText); } catch (_) {
        result.speedTestStatus = "parse-error";
        result.speedTestError = "response not JSON";
        result.speedTestDurationMs = Date.now() - startedAt;
        return result;
      }

      const content = extractAssistantContent(responseJson);
      result.speedTestResponseSample = sampleString(content, 300);
      const usage = responseJson?.usage;
      if (usage) {
        result.speedTestTokens = {
          prompt: usage.prompt_tokens,
          completion: usage.completion_tokens,
          total: usage.total_tokens
        };
      }
      result.speedTestStatus = "success";
      result.speedTestDurationMs = Date.now() - startedAt;
      return result;
    } catch (err) {
      result.speedTestStatus = "error";
      result.speedTestError = err.message || String(err);
      result.speedTestDurationMs = Date.now() - startedAt;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  const api = {
    PROMPT_VERSION,
    ANALYSIS_REQUEST_TIMEOUT_FALLBACK_MS,
    TEST_CONNECTION_TIMEOUT_MS,
    TimeoutError,
    ApiError,
    ApiParseError,
    NetworkError,
    getSystemPrompt,
    buildChatRequestBody,
    stripMarkdownCodeFence,
    parseCompletionJson,
    parseCompletionJsonWithReport,
    rawContentSample,
    extractAssistantContent,
    normalizeCards,
    normalizeCardsWithReport,
    normalizeChatCompletionsEndpoint,
    classifyFetchError,
    describeHttpStatus,
    requestAnalysis,
    testConnection,
    testAnalyzeSpeed
  };

  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Api = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

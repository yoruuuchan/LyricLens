const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChatRequestBody,
  getSystemPrompt,
  parseCompletionJson,
  normalizeCards,
  normalizeCardsWithReport,
  normalizeChatCompletionsEndpoint,
  testConnection,
  requestAnalysis,
  ApiParseError,
  TimeoutError
} = require("../src/api");

test("builds OpenAI compatible chat completions request body", () => {
  const body = buildChatRequestBody({
    modelName: "test-model",
    language: "en",
    formattedLyrics: "[3] Hello"
  });

  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, 0.3);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content, "[3] Hello");
  assert.match(getSystemPrompt("en"), /English learning assistant/);
  assert.match(getSystemPrompt("ja"), /Japanese learning assistant/);
});

test("default prompt requires one card for every input lyric line", () => {
  const body = buildChatRequestBody({
    modelName: "test-model",
    language: "en",
    formattedLyrics: "[0] Hello\n[1] World"
  });
  const systemPrompt = body.messages[0].content;

  assert.match(systemPrompt, /every input lyric line/i);
  assert.match(systemPrompt, /cards\.length must equal input lines\.length/i);
  assert.match(systemPrompt, /lineIndex/);
  assert.doesNotMatch(systemPrompt, /Pick 6-8/);
});

test("selected prompt keeps sparse card behavior when explicitly requested", () => {
  const body = buildChatRequestBody({
    modelName: "test-model",
    language: "en",
    formattedLyrics: "[0] Hello\n[1] World",
    cardGenerationMode: "selected"
  });

  assert.match(body.messages[0].content, /Pick 6-8/);
  assert.doesNotMatch(body.messages[0].content, /cards\.length must equal input lines\.length/i);
});

test("buildChatRequestBody includes max_tokens only when maxTokens is provided", () => {
  const withMaxTokens = buildChatRequestBody({
    modelName: "test-model",
    language: "en",
    formattedLyrics: "[0] Hello",
    maxTokens: 4096
  });
  assert.equal(withMaxTokens.max_tokens, 4096);

  const withoutMaxTokens = buildChatRequestBody({
    modelName: "test-model",
    language: "en",
    formattedLyrics: "[0] Hello"
  });
  assert.equal(Object.hasOwn(withoutMaxTokens, "max_tokens"), false);
});

test("buildChatRequestBody explicit temperature overrides default", () => {
  const body = buildChatRequestBody({
    modelName: "test-model",
    language: "en",
    formattedLyrics: "[0] Hello",
    temperature: 0.2
  });

  assert.equal(body.temperature, 0.2);
});

test("parses completion JSON inside markdown code fence", () => {
  const parsed = parseCompletionJson('```json\n{"cards":[{"index":3,"line":"Hello","translation":"你好","highlights":[]}]}\n```');
  assert.equal(parsed.cards[0].index, 3);
});

test("normalizeChatCompletionsEndpoint appends /chat/completions for /v1 endpoints", () => {
  assert.equal(
    normalizeChatCompletionsEndpoint("https://api.siliconflow.cn/v1"),
    "https://api.siliconflow.cn/v1/chat/completions"
  );
  assert.equal(
    normalizeChatCompletionsEndpoint("https://api.siliconflow.cn/v1/"),
    "https://api.siliconflow.cn/v1/chat/completions"
  );
  assert.equal(
    normalizeChatCompletionsEndpoint("https://api.siliconflow.cn/v1/chat/completions"),
    "https://api.siliconflow.cn/v1/chat/completions"
  );
  assert.equal(
    normalizeChatCompletionsEndpoint("https://example.com/openai/v1"),
    "https://example.com/openai/v1/chat/completions"
  );
  assert.equal(
    normalizeChatCompletionsEndpoint("https://example.com/openai/v1/chat/completions/"),
    "https://example.com/openai/v1/chat/completions"
  );
  assert.equal(normalizeChatCompletionsEndpoint(""), "");
  assert.equal(normalizeChatCompletionsEndpoint("   "), "");
});

test("testConnection bails out with clear errors when endpoint/apiKey/model missing", async () => {
  let fetchCalls = 0;
  const fakeFetch = () => { fetchCalls += 1; throw new Error("must not fetch"); };

  const noEndpoint = await testConnection({ apiEndpoint: "", apiKey: "k", modelName: "m", fetchImpl: fakeFetch });
  assert.equal(noEndpoint.ok, false);
  assert.equal(noEndpoint.requestUrl, null);
  assert.match(noEndpoint.message, /API Endpoint/);

  const noKey = await testConnection({ apiEndpoint: "https://api.siliconflow.cn/v1", apiKey: "", modelName: "m", fetchImpl: fakeFetch });
  assert.equal(noKey.ok, false);
  assert.match(noKey.message, /API Key/);

  const noModel = await testConnection({ apiEndpoint: "https://api.siliconflow.cn/v1", apiKey: "k", modelName: "", fetchImpl: fakeFetch });
  assert.equal(noModel.ok, false);
  assert.match(noModel.message, /Model/);

  assert.equal(fetchCalls, 0, "fetch must not be called when inputs are missing");
});

test("testConnection returns ok:true with normalized requestUrl on HTTP 200", async () => {
  let observedUrl = null;
  let observedBody = null;
  let observedAuth = null;
  const fakeFetch = async (url, init) => {
    observedUrl = url;
    observedBody = JSON.parse(init.body);
    observedAuth = init.headers.Authorization;
    return {
      ok: true,
      status: 200,
      async text() { return "{}"; }
    };
  };

  const result = await testConnection({
    apiEndpoint: "https://api.siliconflow.cn/v1",
    apiKey: "sk-test-abc",
    modelName: "Qwen/Qwen2.5-7B-Instruct",
    fetchImpl: fakeFetch
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.requestUrl, "https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(observedUrl, "https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(observedBody.model, "Qwen/Qwen2.5-7B-Instruct");
  assert.equal(observedBody.max_tokens, 1);
  assert.equal(observedAuth, "Bearer sk-test-abc");
});

test("testConnection HTTP 404 result includes 404 and requestUrl", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 404,
    async text() { return "not found"; }
  });
  const result = await testConnection({
    apiEndpoint: "https://api.siliconflow.cn/v1/chat/completions",
    apiKey: "sk-test",
    modelName: "missing-model",
    fetchImpl: fakeFetch
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.requestUrl, "https://api.siliconflow.cn/v1/chat/completions");
  assert.match(result.message, /404/);
});

test("testConnection surfaces fetch network errors", async () => {
  const fakeFetch = async () => { throw new TypeError("Failed to fetch"); };
  const result = await testConnection({
    apiEndpoint: "https://api.siliconflow.cn/v1",
    apiKey: "sk-test",
    modelName: "Qwen/Qwen2.5-7B-Instruct",
    fetchImpl: fakeFetch
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.requestUrl, "https://api.siliconflow.cn/v1/chat/completions");
  assert.match(result.message, /Failed to fetch|网络/);
  assert.equal(result.rawError, "Failed to fetch");
});

test("testConnection does not leak the API key into the returned message", async () => {
  const sensitiveKey = "sk-supersecret-ABCDEF123456";
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    async text() { return JSON.stringify({ error: { message: "invalid key" } }); }
  });
  const result = await testConnection({
    apiEndpoint: "https://api.siliconflow.cn/v1",
    apiKey: sensitiveKey,
    modelName: "Qwen/Qwen2.5-7B-Instruct",
    fetchImpl: fakeFetch
  });
  assert.ok(!result.message.includes(sensitiveKey));
  assert.ok(!String(result.rawError || "").includes(sensitiveKey));
});

test("normalizes cards by dropping missing or out-of-range indexes", () => {
  const lines = [
    { index: 3, text: "Hello", startTime: 1000 },
    { index: 7, text: "World", startTime: 2000 }
  ];
  const cards = normalizeCards({
    cards: [
      { index: 3, line: "Hello", translation: "你好", highlights: [] },
      { index: 4, line: "Nope", translation: "不该出现", highlights: [] },
      { line: "Missing index", translation: "不该出现", highlights: [] }
    ]
  }, lines);

  assert.equal(cards.length, 1);
  assert.equal(cards[0].index, 3);
});

test("normalizeCardsWithReport reports drop reasons and parsed/normalized counts", () => {
  const lines = [
    { index: 3, text: "Hello", startTime: 1000 },
    { index: 7, text: "World", startTime: 2000 }
  ];
  const report = normalizeCardsWithReport({
    cards: [
      { index: 3, line: "Hello", translation: "你好", highlights: [] },
      { index: 4, line: "Nope", translation: "drop", highlights: [] },
      { line: "no-index", translation: "drop", highlights: [] },
      "not-an-object"
    ]
  }, lines);
  assert.equal(report.parsedCount, 4);
  assert.equal(report.normalizedCount, 1);
  assert.equal(report.cards.length, 1);
  assert.equal(report.cards[0].index, 3);
  assert.equal(report.dropReasons.notObject, 1);
  assert.equal(report.dropReasons.missingIndex, 1);
  assert.equal(report.dropReasons.indexNotInLines, 1);
  assert.equal(report.droppedSamples.length >= 1, true);
});

test("normalizeCardsWithReport backfills lyric timing and original text", () => {
  const lines = [
    { index: 3, text: "Good morning, Night City", startTime: 1000, endTime: 2300 },
    { index: 4, text: "Wake up", startTime: 2300 },
    { index: 7, text: "One more day", startTime: 4000 }
  ];
  const report = normalizeCardsWithReport({
    cards: [
      { index: 3, translation: "早上好，夜之城", highlights: [] },
      { lineIndex: 4, line: "", translation: "醒醒", highlights: [] }
    ]
  }, lines);

  assert.equal(report.cards.length, 2);
  assert.equal(report.cards[0].index, 3);
  assert.equal(report.cards[0].lineIndex, 3);
  assert.equal(report.cards[0].line, "Good morning, Night City");
  assert.equal(report.cards[0].original, "Good morning, Night City");
  assert.equal(report.cards[0].startMs, 1000);
  assert.equal(report.cards[0].endMs, 2300);
  assert.equal(report.cards[1].index, 4);
  assert.equal(report.cards[1].startMs, 2300);
  assert.equal(report.cards[1].endMs, 4000);
});

test("normalizeCardsWithReport maps batch-relative indexes back to lyric line indexes", () => {
  const lines = Array.from({ length: 6 }, (_, offset) => ({
    index: 24 + offset,
    text: "Line " + (24 + offset),
    startTime: 150000 + offset * 2500,
    endTime: 152000 + offset * 2500
  }));
  const report = normalizeCardsWithReport({
    cards: [
      { index: 0, translation: "relative first", highlights: [] },
      { lineIndex: 5, translation: "relative last", highlights: [] }
    ]
  }, lines);

  assert.equal(report.cards.length, 2);
  assert.equal(report.cards[0].index, 24);
  assert.equal(report.cards[0].lineIndex, 24);
  assert.equal(report.cards[0].original, "Line 24");
  assert.equal(report.cards[0].startMs, 150000);
  assert.equal(report.cards[1].index, 29);
  assert.equal(report.cards[1].lineIndex, 29);
  assert.equal(report.cards[1].original, "Line 29");
  assert.equal(report.dropReasons.relativeIndexRecovered, 2);
  assert.equal(report.dropReasons.indexNotInLines, 0);
});

test("normalizeCardsWithReport keeps a displayable last card without endMs", () => {
  const lines = [
    { index: 10, text: "Final line", startTime: 9000 }
  ];
  const report = normalizeCardsWithReport({
    cards: [{ index: 10, translation: "最后一句", highlights: [] }]
  }, lines);

  assert.equal(report.cards.length, 1);
  assert.equal(report.cards[0].startMs, 9000);
  assert.equal(report.cards[0].endMs, null);
  assert.equal(report.dropReasons.indexNotInLines, 0);
});

test("requestAnalysis throws ApiParseError with response sample when body is not JSON", async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    async text() { return "<html>upstream error</html>"; }
  });
  let caught = null;
  try {
    await requestAnalysis({
      apiEndpoint: "https://api.siliconflow.cn/v1",
      apiKey: "sk",
      modelName: "m",
      language: "en",
      formattedLyrics: "[0] Hello",
      fetchImpl: fakeFetch
    });
  } catch (err) { caught = err; }
  assert.ok(caught);
  assert.equal(caught.name, "ApiParseError");
  assert.equal(caught.stage, "response-json");
  assert.match(caught.contentSample, /upstream error/);
  assert.equal(caught.requestUrl, "https://api.siliconflow.cn/v1/chat/completions");
});

test("requestAnalysis throws ApiParseError when content is not parseable JSON", async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: "Sorry, I cannot help with that." } }]
      });
    }
  });
  let caught = null;
  try {
    await requestAnalysis({
      apiEndpoint: "https://api.siliconflow.cn/v1",
      apiKey: "sk",
      modelName: "m",
      language: "en",
      formattedLyrics: "[0] Hello",
      fetchImpl: fakeFetch
    });
  } catch (err) { caught = err; }
  assert.ok(caught);
  assert.equal(caught.name, "ApiParseError");
  assert.equal(caught.stage, "content-json");
  assert.match(caught.contentSample, /cannot help/);
});

test("requestAnalysis auto-retries once when first attempt yields unparseable content", async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        if (callCount === 1) {
          return JSON.stringify({
            choices: [{ message: { content: "Sorry, I cannot help with that." } }]
          });
        }
        return JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ cards: [{ lineIndex: 0, original: "Hello" }] }) } }]
        });
      }
    };
  };
  const result = await requestAnalysis({
    apiEndpoint: "https://api.siliconflow.cn/v1",
    apiKey: "sk",
    modelName: "m",
    language: "en",
    formattedLyrics: "[0] Hello",
    fetchImpl: fakeFetch
  });
  assert.equal(callCount, 2);
  assert.ok(result);
  assert.equal(Array.isArray(result.cards), true);
  assert.equal(result.cards.length, 1);
});

test("requestAnalysis does NOT auto-retry when parse failure is due to length truncation", async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{
            message: { content: '{"cards":[{"lineIndex":0,' },
            finish_reason: "length"
          }]
        });
      }
    };
  };
  let caught = null;
  try {
    await requestAnalysis({
      apiEndpoint: "https://api.siliconflow.cn/v1",
      apiKey: "sk",
      modelName: "m",
      language: "en",
      formattedLyrics: "[0] Hello",
      fetchImpl: fakeFetch
    });
  } catch (err) { caught = err; }
  assert.equal(callCount, 1);
  assert.ok(caught);
  assert.equal(caught.name, "ApiParseError");
  assert.equal(caught.finishReasonWasLength, true);
});

test("requestAnalysis gives up after one parse retry and exposes fullContent on the error", async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: "not json at all" } }]
        });
      }
    };
  };
  let caught = null;
  try {
    await requestAnalysis({
      apiEndpoint: "https://api.siliconflow.cn/v1",
      apiKey: "sk",
      modelName: "m",
      language: "en",
      formattedLyrics: "[0] Hello",
      fetchImpl: fakeFetch
    });
  } catch (err) { caught = err; }
  assert.equal(callCount, 2);
  assert.ok(caught);
  assert.equal(caught.name, "ApiParseError");
  assert.equal(caught.stage, "content-json");
  assert.equal(caught.fullContent, "not json at all");
});

test("requestAnalysis ApiParseError class is exported", () => {
  assert.equal(typeof ApiParseError, "function");
  const e = new ApiParseError("x", { stage: "y", contentSample: "z" });
  assert.equal(e.name, "ApiParseError");
  assert.equal(e.stage, "y");
  assert.equal(e.contentSample, "z");
});

test("requestAnalysis success path writes request diagnostics without API key", async () => {
  const previous = globalThis.LyricLens;
  const updates = [];
  globalThis.LyricLens = {
    diagnostics: {
      updateState(partial) {
        updates.push(partial);
      }
    }
  };
  let observedBody = null;
  const fakeFetch = async (_url, init) => {
    observedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ cards: [] }) } }]
        });
      }
    };
  };

  try {
    await requestAnalysis({
      apiEndpoint: "https://api.siliconflow.cn/v1",
      apiKey: "sk-secret-should-not-leak",
      modelName: "Qwen/Test",
      language: "en",
      formattedLyrics: "[0] Hello",
      maxTokens: 4096,
      temperature: 0.2,
      timeoutMs: 60000,
      fetchImpl: fakeFetch
    });
  } finally {
    globalThis.LyricLens = previous;
  }

  assert.equal(observedBody.max_tokens, 4096);
  assert.equal(observedBody.temperature, 0.2);
  const merged = Object.assign({}, ...updates);
  assert.equal(merged.lastRequestModel, "Qwen/Test");
  assert.equal(merged.lastRequestMaxTokens, 4096);
  assert.equal(merged.lastRequestTemperature, 0.2);
  assert.equal(merged.analyzeTimeoutMs, 60000);
  assert.equal(merged.promptCharCount > 0, true);
  assert.equal(merged.requestBodySize > 0, true);
  assert.equal(Number.isFinite(merged.lastRequestDurationMs), true);
  assert.equal(merged.lastRequestDurationMs >= 0, true);
  assert.equal(merged.timeoutStage, null);
  assert.equal(JSON.stringify(updates).includes("sk-secret-should-not-leak"), false);
});

test("requestAnalysis uses passed timeoutMs and records fetch timeout diagnostics", async () => {
  const previous = globalThis.LyricLens;
  const updates = [];
  globalThis.LyricLens = {
    diagnostics: {
      updateState(partial) {
        updates.push(partial);
      }
    }
  };
  const fakeFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });

  let caught = null;
  try {
    await requestAnalysis({
      apiEndpoint: "https://api.siliconflow.cn/v1",
      apiKey: "sk-secret-should-not-leak",
      modelName: "Qwen/Test",
      language: "en",
      formattedLyrics: "[0] Hello",
      maxTokens: 4096,
      temperature: 0.2,
      timeoutMs: 8,
      fetchImpl: fakeFetch
    });
  } catch (err) {
    caught = err;
  } finally {
    globalThis.LyricLens = previous;
  }

  assert.ok(caught instanceof TimeoutError);
  const merged = Object.assign({}, ...updates);
  assert.equal(merged.analyzeTimeoutMs, 8);
  assert.equal(merged.timeoutStage, "fetch");
  assert.equal(Number.isFinite(merged.lastRequestDurationMs), true);
  assert.equal(merged.lastRequestDurationMs >= 0, true);
  assert.equal(JSON.stringify(updates).includes("sk-secret-should-not-leak"), false);
});

test("parseCompletionJson extracts JSON from fenced code block", () => {
  const { parseCompletionJson } = require("../src/api");
  const parsed = parseCompletionJson('```json\n{"cards":[{"lineIndex":3,"original":"Hello","translation":"你好","points":["greeting"],"note":""}]}\n```');
  assert.equal(parsed.cards[0].lineIndex, 3);
  assert.equal(parsed.cards[0].original, "Hello");
});

test("parseCompletionJson extracts JSON object embedded in text", () => {
  const { parseCompletionJson } = require("../src/api");
  const parsed = parseCompletionJson('Some intro text\n{"cards":[{"lineIndex":0,"original":"x","translation":"y","points":[],"note":""}]}\nMore text');
  assert.equal(parsed.cards.length, 1);
});

test("parseCompletionJson wraps root array as { cards: array }", () => {
  const { parseCompletionJson } = require("../src/api");
  const parsed = parseCompletionJson('[{"lineIndex":0,"original":"x","translation":"y","points":[],"note":""}]');
  assert.equal(parsed.cards.length, 1);
});

test("parseCompletionJson throws when content is unparseable", () => {
  const { parseCompletionJson } = require("../src/api");
  assert.throws(() => parseCompletionJson("not json at all"), /无法解析/);
});

test("buildChatRequestBody includes response_format when mode is json_object", () => {
  const { buildChatRequestBody } = require("../src/api");
  const body = buildChatRequestBody({
    modelName: "Qwen/Test",
    language: "en",
    formattedLyrics: "[0] Hello",
    responseFormatMode: "json_object"
  });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("buildChatRequestBody excludes response_format when mode is off", () => {
  const { buildChatRequestBody } = require("../src/api");
  const body = buildChatRequestBody({
    modelName: "Qwen/Test",
    language: "en",
    formattedLyrics: "[0] Hello",
    responseFormatMode: "off"
  });
  assert.equal(body.response_format, undefined);
});

test("buildChatRequestBody uses selected fallback prompt when selected fallback is true", () => {
  const { buildChatRequestBody, getSystemPrompt } = require("../src/api");
  const fallbackPrompt = getSystemPrompt("en", true, "selected");
  assert.ok(fallbackPrompt.length < 300, "fallback prompt must be short");
  assert.match(fallbackPrompt, /2-4/);
  assert.match(fallbackPrompt, /Return ONLY a JSON/);
});

test("ApiParseError carries finishReasonWasLength flag", () => {
  const { ApiParseError } = require("../src/api");
  const err = new ApiParseError("test");
  err.finishReasonWasLength = true;
  assert.equal(err.finishReasonWasLength, true);
});

test("rawContentSample truncates long content at both ends", () => {
  const { rawContentSample } = require("../src/api");
  const long = "x".repeat(3000);
  const sample = rawContentSample(long);
  assert.ok(sample.length < 2000, "sample must be shorter than original");
  assert.ok(sample.includes("chars"), "sample must indicate truncation");
  assert.match(sample, /^x{500}/);
});

test("createCardsStreamParser emits each card object as its closing brace lands", () => {
  const { createCardsStreamParser } = require("../src/api");
  const collected = [];
  const parser = createCardsStreamParser({ onCard: (card, idx) => collected.push({ card, idx }) });
  const full = '{"cards":[{"lineIndex":0,"original":"Hello","translation":"你好"},{"lineIndex":1,"original":"World"}]}';
  for (const ch of full) parser.append(ch);
  assert.equal(collected.length, 2);
  assert.equal(collected[0].card.lineIndex, 0);
  assert.equal(collected[0].card.original, "Hello");
  assert.equal(collected[1].card.lineIndex, 1);
  assert.equal(parser.isClosed(), true);
});

test("createCardsStreamParser ignores braces inside string values and handles escapes", () => {
  const { createCardsStreamParser } = require("../src/api");
  const cards = [];
  const parser = createCardsStreamParser({ onCard: (c) => cards.push(c) });
  // Card 1 has } inside a translation; card 2 has \" inside a note; card 3 has nested object.
  const payload = '{"cards":[{"lineIndex":0,"translation":"close } here"},{"lineIndex":1,"note":"says \\"hi\\""},{"lineIndex":2,"highlights":[{"phrase":"a"}]}]}';
  parser.append(payload);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].translation, "close } here");
  assert.equal(cards[1].note, 'says "hi"');
  assert.deepEqual(cards[2].highlights, [{ phrase: "a" }]);
});

test("createCardsStreamParser stays partial until brace closes", () => {
  const { createCardsStreamParser } = require("../src/api");
  const cards = [];
  const parser = createCardsStreamParser({ onCard: (c) => cards.push(c) });
  parser.append('{"cards":[{"lineIndex":0,"orig');
  assert.equal(cards.length, 0, "should not emit on partial");
  parser.append('inal":"Hello"');
  assert.equal(cards.length, 0, "still partial without closing brace");
  parser.append('},{"lineIndex":1,"original":"World"}]}');
  assert.equal(cards.length, 2);
});

test("requestAnalysis streams cards via onStreamCard when SSE response arrives", async () => {
  const { requestAnalysis } = require("../src/api");
  const seen = [];
  const sseBody = [
    'data: {"choices":[{"delta":{"content":"{\\"cards\\":["}}]}',
    'data: {"choices":[{"delta":{"content":"{\\"lineIndex\\":0,\\"original\\":\\"A\\"},"}}]}',
    'data: {"choices":[{"delta":{"content":"{\\"lineIndex\\":1,\\"original\\":\\"B\\"}]}"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}',
    'data: [DONE]'
  ].join("\n\n") + "\n\n";

  function makeStreamResponse(text) {
    const encoder = new TextEncoder();
    const reader = {
      buffers: [encoder.encode(text)],
      async read() {
        if (this.buffers.length === 0) return { value: undefined, done: true };
        return { value: this.buffers.shift(), done: false };
      },
      releaseLock() {}
    };
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "content-type" ? "text/event-stream" : null },
      body: { getReader: () => reader },
      async text() { return text; }
    };
  }

  const fakeFetch = async () => makeStreamResponse(sseBody);
  const parsed = await requestAnalysis({
    apiEndpoint: "https://example.com/v1/chat/completions",
    apiKey: "k",
    modelName: "m",
    language: "en",
    formattedLyrics: "[0] A\n[1] B",
    fetchImpl: fakeFetch,
    onStreamCard: (card) => seen.push(card)
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].lineIndex, 0);
  assert.equal(seen[1].original, "B");
  assert.deepEqual(parsed.cards.length, 2);
});

// ── Text-based index rescue (LLM mislabels lineIndex but reports the right text) ──

test("normalizeCardsWithReport rescues a card when LLM mislabels lineIndex but original matches another line", () => {
  // Real lyrics: line 30 = "好きなことを続けること", line 33 = "そう何年だってきっと"
  // LLM analyzed "そう何年だってきっと" but tagged it as lineIndex=30.
  // Expected: code moves the card to lineIndex=33 so original+translation+startMs
  // all line up at the position the LLM actually analyzed.
  const lyricLines = [
    { index: 30, text: "好きなことを続けること", startTime: 90000, endTime: 94000 },
    { index: 31, text: "それが僕の宝物", startTime: 94000, endTime: 98000 },
    { index: 33, text: "そう何年だってきっと", startTime: 119000, endTime: 123000 }
  ];
  const aiOutput = {
    cards: [{
      lineIndex: 30,
      original: "そう何年だってきっと",
      translation: "没错 无论过多少年都一定会",
      points: []
    }]
  };
  const report = normalizeCardsWithReport(aiOutput, lyricLines);
  assert.equal(report.cards.length, 1);
  const card = report.cards[0];
  assert.equal(card.lineIndex, 33, "card.lineIndex should be rescued to 33");
  assert.equal(card.original, "そう何年だってきっと", "original should match the real line at lineIndex 33");
  assert.equal(card.startMs, 119000, "startMs should be the real line 33 startMs");
  assert.equal(card.translation, "没错 无论过多少年都一定会", "translation stays the LLM's");
  assert.equal(report.dropReasons.indexRescuedByText, 1);
});

test("normalizeCardsWithReport leaves a correctly-labeled card alone (no rescue needed)", () => {
  const lyricLines = [
    { index: 30, text: "好きなことを続けること", startTime: 90000, endTime: 94000 },
    { index: 33, text: "そう何年だってきっと", startTime: 119000, endTime: 123000 }
  ];
  const aiOutput = {
    cards: [{ lineIndex: 33, original: "そう何年だってきっと", translation: "没错…", points: [] }]
  };
  const report = normalizeCardsWithReport(aiOutput, lyricLines);
  assert.equal(report.cards[0].lineIndex, 33);
  assert.equal(report.dropReasons.indexRescuedByText, 0);
});

test("normalizeCardsWithReport does not rescue when LLM's text does not match any lyric line", () => {
  // LLM hallucinated text that's nowhere in the lyrics. We keep the labeled
  // index (no rescue) — caller can still use the real lyricLine.text via
  // card.original on render fallback.
  const lyricLines = [
    { index: 30, text: "好きなことを続けること", startTime: 90000, endTime: 94000 },
    { index: 33, text: "そう何年だってきっと", startTime: 119000, endTime: 123000 }
  ];
  const aiOutput = {
    cards: [{ lineIndex: 30, original: "幻のフレーズ", translation: "…", points: [] }]
  };
  const report = normalizeCardsWithReport(aiOutput, lyricLines);
  assert.equal(report.cards.length, 1);
  assert.equal(report.cards[0].lineIndex, 30, "no rescue: kept LLM's labeled index");
  assert.equal(report.dropReasons.indexRescuedByText, 0);
});

test("normalizeCardsWithReport: whitespace differences do not block text rescue", () => {
  const lyricLines = [
    { index: 0, text: "Stay  with me", startTime: 0, endTime: 4000 },
    { index: 1, text: "Until the morning", startTime: 4000, endTime: 8000 }
  ];
  // LLM emits "Stay with me" (single space) but tags lineIndex=1.
  const aiOutput = {
    cards: [{ lineIndex: 1, original: "Stay with me", translation: "陪着我", points: [] }]
  };
  const report = normalizeCardsWithReport(aiOutput, lyricLines);
  assert.equal(report.cards[0].lineIndex, 0, "whitespace-normalized rescue moves card to lineIndex 0");
  assert.equal(report.dropReasons.indexRescuedByText, 1);
});

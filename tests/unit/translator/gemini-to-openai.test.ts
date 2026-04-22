import { describe, expect, test } from "bun:test";
import {
  normalizeSchemaTypes,
  convertGeminiContentsToOpenAI,
  convertGeminiSystemInstructionToOpenAI,
  convertGeminiToolsToOpenAI,
  convertGeminiToolConfigToOpenAI,
  convertGeminiGenerationConfig,
  buildOpenAIRequestFromGemini,
} from "../../../src/translator/gemini-to-openai";

describe("normalizeSchemaTypes", () => {
  test("uppercases -> lowercase type", () => {
    const out = normalizeSchemaTypes({
      type: "OBJECT",
      properties: {
        a: { type: "STRING" },
        b: { type: "INTEGER" },
      },
    }) as any;
    expect(out.type).toBe("object");
    expect(out.properties.a.type).toBe("string");
    expect(out.properties.b.type).toBe("integer");
  });

  test("strips TYPE_UNSPECIFIED", () => {
    const out = normalizeSchemaTypes({ type: "TYPE_UNSPECIFIED", description: "x" }) as any;
    expect(out.type).toBeUndefined();
    expect(out.description).toBe("x");
  });

  test("does not recurse into default/enum/const/example", () => {
    const out = normalizeSchemaTypes({
      type: "OBJECT",
      default: { type: "STRING" },
      enum: ["A", "B"],
      const: { type: "STRING" },
      example: { type: "STRING" },
    }) as any;
    expect(out.default).toEqual({ type: "STRING" });
    expect(out.const).toEqual({ type: "STRING" });
    expect(out.example).toEqual({ type: "STRING" });
    expect(out.enum).toEqual(["A", "B"]);
  });

  test("handles circular refs safely", () => {
    const a: any = { type: "OBJECT" };
    a.self = a;
    const out = normalizeSchemaTypes(a) as any;
    expect(out.type).toBe("object");
  });
});

describe("convertGeminiContentsToOpenAI", () => {
  test("user text -> user string content", () => {
    const msgs = convertGeminiContentsToOpenAI([
      { role: "user", parts: [{ text: "hello" }] },
    ]);
    expect(msgs).toEqual([{ role: "user", content: "hello" }]);
  });

  test("user with image -> array content", () => {
    const msgs = convertGeminiContentsToOpenAI([
      {
        role: "user",
        parts: [
          { text: "caption?" },
          { inlineData: { mimeType: "image/png", data: "abc" } },
        ],
      },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(Array.isArray(msgs[0].content)).toBe(true);
    expect(msgs[0].content[0]).toEqual({ type: "text", text: "caption?" });
    expect(msgs[0].content[1].type).toBe("image_url");
    expect(msgs[0].content[1].image_url.url).toBe("data:image/png;base64,abc");
  });

  test("model text -> assistant message", () => {
    const msgs = convertGeminiContentsToOpenAI([
      { role: "model", parts: [{ text: "hi there" }] },
    ]);
    expect(msgs).toEqual([{ role: "assistant", content: "hi there" }]);
  });

  test("model functionCall -> assistant tool_calls", () => {
    const msgs = convertGeminiContentsToOpenAI([
      {
        role: "model",
        parts: [{ functionCall: { id: "c1", name: "lookup", args: { q: "x" } } }],
      },
    ]);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].tool_calls).toHaveLength(1);
    expect(msgs[0].tool_calls[0].id).toBe("c1");
    expect(msgs[0].tool_calls[0].function.name).toBe("lookup");
    expect(JSON.parse(msgs[0].tool_calls[0].function.arguments)).toEqual({ q: "x" });
  });

  test("user functionResponse -> separate tool message", () => {
    const msgs = convertGeminiContentsToOpenAI([
      {
        role: "user",
        parts: [
          { text: "follow-up" },
          { functionResponse: { id: "c1", name: "lookup", response: { ok: true } } },
        ],
      },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "follow-up" });
    expect(msgs[1].role).toBe("tool");
    expect(msgs[1].tool_call_id).toBe("c1");
    expect(JSON.parse(msgs[1].content)).toEqual({ ok: true });
  });
});

describe("convertGeminiSystemInstructionToOpenAI", () => {
  test("joins multiple text parts", () => {
    const m = convertGeminiSystemInstructionToOpenAI({
      parts: [{ text: "A" }, { text: "B" }],
    });
    expect(m).toEqual({ role: "system", content: "A\nB" });
  });

  test("returns null for empty", () => {
    expect(convertGeminiSystemInstructionToOpenAI(null)).toBeNull();
    expect(convertGeminiSystemInstructionToOpenAI({ parts: [] })).toBeNull();
  });
});

describe("convertGeminiToolsToOpenAI", () => {
  test("converts functionDeclarations with schema normalization", () => {
    const tools = convertGeminiToolsToOpenAI([
      {
        functionDeclarations: [
          {
            name: "search",
            description: "Search",
            parameters: {
              type: "OBJECT",
              properties: { q: { type: "STRING" } },
            },
          },
        ],
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools![0].type).toBe("function");
    expect(tools![0].function.name).toBe("search");
    expect(tools![0].function.parameters.type).toBe("object");
    expect(tools![0].function.parameters.properties.q.type).toBe("string");
  });

  test("empty list returns undefined", () => {
    expect(convertGeminiToolsToOpenAI([])).toBeUndefined();
  });
});

describe("convertGeminiToolConfigToOpenAI", () => {
  test("AUTO -> auto", () => {
    expect(
      convertGeminiToolConfigToOpenAI({ functionCallingConfig: { mode: "AUTO" } }),
    ).toBe("auto");
  });
  test("NONE -> none", () => {
    expect(
      convertGeminiToolConfigToOpenAI({ functionCallingConfig: { mode: "NONE" } }),
    ).toBe("none");
  });
  test("ANY -> required", () => {
    expect(
      convertGeminiToolConfigToOpenAI({ functionCallingConfig: { mode: "ANY" } }),
    ).toBe("required");
  });
  test("ANY with single allowedFunctionName -> forced function", () => {
    expect(
      convertGeminiToolConfigToOpenAI({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["search"] },
      }),
    ).toEqual({ type: "function", function: { name: "search" } });
  });
  test("undefined mode -> undefined", () => {
    expect(convertGeminiToolConfigToOpenAI(undefined)).toBeUndefined();
  });
});

describe("convertGeminiGenerationConfig", () => {
  test("maps all supported fields", () => {
    const out = convertGeminiGenerationConfig({
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 256,
      stopSequences: ["END"],
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      candidateCount: 2,
      seed: 42,
      responseMimeType: "application/json",
    });
    expect(out).toEqual({
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 256,
      stop: ["END"],
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      n: 2,
      seed: 42,
      response_format: { type: "json_object" },
    });
  });
  test("empty config -> empty object", () => {
    expect(convertGeminiGenerationConfig(undefined)).toEqual({});
  });
});

describe("buildOpenAIRequestFromGemini", () => {
  test("end-to-end assembly", () => {
    const req = buildOpenAIRequestFromGemini({
      model: "gemini-2.5-pro",
      stream: true,
      payload: {
        systemInstruction: { parts: [{ text: "Be concise." }] },
        contents: [
          { role: "user", parts: [{ text: "Hello" }] },
          { role: "model", parts: [{ text: "Hi" }] },
        ],
        generationConfig: { temperature: 0.5, maxOutputTokens: 100 },
        tools: [
          {
            functionDeclarations: [
              { name: "ping", description: "", parameters: { type: "OBJECT" } },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      },
    });
    expect(req.model).toBe("gemini-2.5-pro");
    expect(req.stream).toBe(true);
    expect(req.messages[0]).toEqual({ role: "system", content: "Be concise." });
    expect(req.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(req.messages[2]).toEqual({ role: "assistant", content: "Hi" });
    expect(req.temperature).toBe(0.5);
    expect(req.max_tokens).toBe(100);
    expect(req.tools).toHaveLength(1);
    expect(req.tool_choice).toBe("auto");
  });
});

/**
 * Translate Gemini GenerateContentRequest to OpenAI Chat Completions format.
 *
 * Gemini concepts:
 *   - contents: Array<{ role: "user" | "model", parts: Part[] }>
 *   - systemInstruction: { parts: Part[] }
 *   - tools: Array<{ functionDeclarations: FunctionDeclaration[] }>
 *   - toolConfig: { functionCallingConfig: { mode, allowedFunctionNames? } }
 *   - generationConfig: { temperature, topP, maxOutputTokens, stopSequences, ... }
 *
 * Part variants:
 *   - { text: string }
 *   - { functionCall: { id?, name, args } }            (assistant tool call)
 *   - { functionResponse: { id?, name, response } }    (tool result)
 *   - { inlineData: { mimeType, data(base64) } }       (vision)
 */

const TYPE_NORMALIZATION_MAP: Record<string, string> = {
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  ARRAY: "array",
  OBJECT: "object",
  NULL: "null",
  String: "string",
  Number: "number",
  Integer: "integer",
  Boolean: "boolean",
  Array: "array",
  Object: "object",
  Null: "null",
};

const NON_SCHEMA_FIELDS = new Set(["default", "example", "const", "enum"]);
const MAX_SCHEMA_DEPTH = 100;

/**
 * Normalize JSON Schema type values from uppercase (STRING/OBJECT) to
 * lowercase (string/object). Protects against circular refs and deep nesting.
 */
export function normalizeSchemaTypes(
  schema: unknown,
  visited = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (depth >= MAX_SCHEMA_DEPTH) return schema;
  if (visited.has(schema as object)) return schema;
  visited.add(schema as object);

  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeSchemaTypes(item, visited, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "type" && typeof value === "string") {
      const upper = value.toUpperCase();
      if (upper === "TYPE_UNSPECIFIED") continue;
      out[key] = TYPE_NORMALIZATION_MAP[value] ?? value.toLowerCase();
    } else if (NON_SCHEMA_FIELDS.has(key)) {
      out[key] = value;
    } else {
      out[key] = normalizeSchemaTypes(value, visited, depth + 1);
    }
  }
  return out;
}

interface OpenAITextPart {
  type: "text";
  text: string;
}

interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}

type OpenAIUserPart = OpenAITextPart | OpenAIImagePart;

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Convert Gemini contents[] to OpenAI messages[].
 *
 * Gemini roles: "user" | "model"
 * OpenAI roles: "system" | "user" | "assistant" | "tool"
 *
 * Rules:
 *   - "user" + functionResponse part => emit separate `role: "tool"` messages
 *   - "user" + text/inlineData       => `role: "user"` (parts[] if multimodal)
 *   - "model" + text                 => `role: "assistant", content: text`
 *   - "model" + functionCall         => `role: "assistant", tool_calls: [...]`
 */
export function convertGeminiContentsToOpenAI(contents: any[]): any[] {
  const messages: any[] = [];

  for (const content of contents ?? []) {
    const role = content?.role ?? "user";
    const parts = content?.parts ?? [];

    if (role === "model") {
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      for (const p of parts) {
        if (typeof p?.text === "string") {
          textParts.push(p.text);
        } else if (p?.functionCall?.name) {
          toolCalls.push({
            id: p.functionCall.id || `call_${cryptoRandomId()}`,
            type: "function",
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args ?? {}),
            },
          });
        }
      }
      const msg: any = { role: "assistant" };
      const text = textParts.join("");
      if (text) msg.content = text;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      if (!text && toolCalls.length === 0) msg.content = "";
      messages.push(msg);
      continue;
    }

    // role === "user" (default)
    const userParts: OpenAIUserPart[] = [];
    const toolMessages: any[] = [];

    for (const p of parts) {
      if (typeof p?.text === "string") {
        userParts.push({ type: "text", text: p.text });
      } else if (p?.inlineData?.data) {
        const mime = p.inlineData.mimeType || "application/octet-stream";
        userParts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${p.inlineData.data}` },
        });
      } else if (p?.functionResponse) {
        const fr = p.functionResponse;
        let content = "";
        if (fr.response !== undefined) {
          content =
            typeof fr.response === "string"
              ? fr.response
              : JSON.stringify(fr.response);
        }
        toolMessages.push({
          role: "tool",
          tool_call_id: fr.id || fr.name || `call_${cryptoRandomId()}`,
          content,
        });
      }
    }

    if (userParts.length > 0) {
      const hasImage = userParts.some((p) => p.type === "image_url");
      if (hasImage) {
        messages.push({ role: "user", content: userParts });
      } else {
        const text = userParts
          .filter((p): p is OpenAITextPart => p.type === "text")
          .map((p) => p.text)
          .join("");
        messages.push({ role: "user", content: text });
      }
    }
    // Append tool results AFTER user content (matches Gemini semantics where
    // the user turn may contain function responses from a previous tool call).
    for (const tm of toolMessages) messages.push(tm);
  }

  return messages;
}

/**
 * Convert Gemini systemInstruction to a single OpenAI system message.
 * Returns null if the instruction is empty.
 */
export function convertGeminiSystemInstructionToOpenAI(instruction: any): any | null {
  if (!instruction) return null;
  const parts = instruction.parts ?? [];
  const text = parts
    .filter((p: any) => typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("\n");
  if (!text) return null;
  return { role: "system", content: text };
}

/**
 * Convert Gemini tools[] to OpenAI tools[] (function-type only).
 */
export function convertGeminiToolsToOpenAI(tools: any[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const out: any[] = [];
  for (const tool of tools) {
    const decls = tool?.functionDeclarations ?? [];
    for (const decl of decls) {
      if (!decl?.name) continue;
      const rawSchema = decl.parameters ?? decl.parametersJsonSchema ?? {};
      const schema = normalizeSchemaTypes(rawSchema) as Record<string, unknown>;
      out.push({
        type: "function",
        function: {
          name: decl.name,
          description: decl.description ?? "",
          parameters: schema,
        },
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Convert Gemini toolConfig.functionCallingConfig to OpenAI tool_choice.
 *
 * Gemini modes: AUTO | ANY | NONE | VALIDATED
 * OpenAI: "auto" | "required" | "none" | { type: "function", function: { name } }
 */
export function convertGeminiToolConfigToOpenAI(toolConfig: any): any | undefined {
  const mode = toolConfig?.functionCallingConfig?.mode;
  const allowed: string[] | undefined =
    toolConfig?.functionCallingConfig?.allowedFunctionNames;
  if (!mode) return undefined;

  const normalized = String(mode).toUpperCase();
  if (normalized === "NONE") return "none";
  if (normalized === "ANY") {
    if (allowed && allowed.length === 1) {
      return { type: "function", function: { name: allowed[0] } };
    }
    return "required";
  }
  // AUTO / VALIDATED / MODE_UNSPECIFIED
  return "auto";
}

/**
 * Convert Gemini generationConfig to OpenAI sampling fields.
 */
export function convertGeminiGenerationConfig(cfg: any): Record<string, any> {
  if (!cfg) return {};
  const out: Record<string, any> = {};
  if (cfg.temperature != null) out.temperature = cfg.temperature;
  if (cfg.topP != null) out.top_p = cfg.topP;
  if (cfg.maxOutputTokens != null) out.max_tokens = cfg.maxOutputTokens;
  if (Array.isArray(cfg.stopSequences) && cfg.stopSequences.length > 0) {
    out.stop = cfg.stopSequences;
  }
  if (cfg.presencePenalty != null) out.presence_penalty = cfg.presencePenalty;
  if (cfg.frequencyPenalty != null) out.frequency_penalty = cfg.frequencyPenalty;
  if (cfg.candidateCount != null) out.n = cfg.candidateCount;
  if (cfg.seed != null) out.seed = cfg.seed;
  if (cfg.responseMimeType === "application/json") {
    out.response_format = { type: "json_object" };
  }
  return out;
}

interface BuildOpenAIRequestInput {
  model: string;
  stream: boolean;
  payload: {
    contents?: any[];
    systemInstruction?: any;
    tools?: any[];
    toolConfig?: any;
    generationConfig?: any;
  };
}

/**
 * Assemble a full OpenAI chat completions request from a Gemini payload.
 */
export function buildOpenAIRequestFromGemini(input: BuildOpenAIRequestInput): any {
  const { model, stream, payload } = input;
  const messages: any[] = [];

  const sysMsg = convertGeminiSystemInstructionToOpenAI(payload.systemInstruction);
  if (sysMsg) messages.push(sysMsg);

  messages.push(...convertGeminiContentsToOpenAI(payload.contents ?? []));

  const result: any = {
    model,
    messages,
    stream,
    ...convertGeminiGenerationConfig(payload.generationConfig),
  };

  const tools = convertGeminiToolsToOpenAI(payload.tools ?? []);
  if (tools) result.tools = tools;

  const toolChoice = convertGeminiToolConfigToOpenAI(payload.toolConfig);
  if (toolChoice !== undefined) result.tool_choice = toolChoice;

  return result;
}

function cryptoRandomId(): string {
  try {
    return (globalThis as any).crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  } catch {
    return Math.random().toString(36).slice(2, 18);
  }
}

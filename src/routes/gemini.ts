/**
 * Gemini-compatible API routes:
 *   POST /v1beta/models/:modelWithMethod   where :modelWithMethod =
 *     "<model>:generateContent"
 *     "<model>:streamGenerateContent"
 *     "<model>:countTokens"
 *
 * Only Gemini models (id starts with "gemini-") are accepted. All other
 * models yield a Gemini-shaped 400 INVALID_ARGUMENT error.
 *
 * Upstream: Copilot supports Gemini models only via /chat/completions (no
 * native /v1beta endpoint), so we translate to OpenAI Chat Completions.
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { ensureCopilotToken, getCopilotBaseUrl } from "../auth/copilot-token";
import { getState, type CopilotModel } from "../auth/state";
import { getCopilotHeaders } from "../proxy/headers";
import { fetchUpstream } from "../proxy/request";
import { logRequest, type RequestLogEntry } from "../usage/logger";
import { buildOpenAIRequestFromGemini } from "../translator/gemini-to-openai";
import { convertOpenAIResponseToGemini } from "../translator/openai-to-gemini";
import {
  GeminiStreamState,
  translateOpenAIChunkToGemini,
  buildGeminiErrorStreamChunk,
} from "../translator/gemini-streaming";

const geminiRouter = new Hono();

/**
 * Convert a Copilot model entry to Gemini's Model listing shape.
 * See https://ai.google.dev/api/models#Model
 */
function copilotModelToGemini(m: CopilotModel): any {
  const limits = m.capabilities?.limits ?? {};
  return {
    name: `models/${m.id}`,
    baseModelId: m.id,
    version: "001",
    displayName: m.name ?? m.id,
    description: m.name ?? "",
    inputTokenLimit: limits.max_prompt_tokens ?? limits.max_context_window_tokens ?? 0,
    outputTokenLimit: limits.max_output_tokens ?? 0,
    supportedGenerationMethods: [
      "generateContent",
      "streamGenerateContent",
      "countTokens",
    ],
  };
}

function isGeminiModel(model: string): boolean {
  return /^gemini[-.]/i.test(model);
}

// GET /v1beta/models — list Gemini models (Gemini CLI preflights this)
geminiRouter.get("/v1beta/models", (c) => {
  const data = getState().models?.data ?? [];
  const models = data.filter((m) => isGeminiModel(m.id)).map(copilotModelToGemini);
  return c.json({ models });
});

// GET /v1beta/models/:id — fetch a single Gemini model
geminiRouter.get("/v1beta/models/:id", (c) => {
  const id = c.req.param("id");
  if (!isGeminiModel(id)) {
    return new Response(
      JSON.stringify({
        error: {
          code: 404,
          message: `Model "${id}" is not a Gemini model. Use /chat/completions or /v1/messages for other models.`,
          status: "NOT_FOUND",
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  const data = getState().models?.data ?? [];
  const match = data.find((m) => m.id === id);
  if (!match) {
    return new Response(
      JSON.stringify({
        error: {
          code: 404,
          message: `Model "${id}" not found in Copilot model list.`,
          status: "NOT_FOUND",
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  return c.json(copilotModelToGemini(match));
});

function geminiError(
  code: number,
  message: string,
  status: string = "INVALID_ARGUMENT",
): Response {
  return new Response(
    JSON.stringify({ error: { code, message, status } }),
    { status: code, headers: { "Content-Type": "application/json" } },
  );
}

function makeLogEntry(
  requestId: string,
  originalModel: string,
  endpoint: string,
  startTime: number,
): Partial<RequestLogEntry> {
  return {
    timestamp: new Date().toISOString(),
    request_id: requestId,
    model: originalModel,
    translated_model: null,
    endpoint,
    provider: "gemini",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
    duration_ms: 0,
    status_code: 200,
    error: null,
  };
}

/**
 * Extract {model, method} from a path segment like "gemini-2.5-pro:generateContent".
 */
function parseModelAndMethod(modelWithMethod: string): { model: string; method: string } | null {
  const colonIdx = modelWithMethod.lastIndexOf(":");
  if (colonIdx < 0) return null;
  return {
    model: modelWithMethod.slice(0, colonIdx),
    method: modelWithMethod.slice(colonIdx + 1),
  };
}

geminiRouter.post("/v1beta/models/:modelWithMethod{.+}", async (c) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  const raw = c.req.param("modelWithMethod");
  const parsed = parseModelAndMethod(raw);
  if (!parsed) {
    return geminiError(
      404,
      `Invalid URL: expected "<model>:<method>", got "${raw}"`,
      "NOT_FOUND",
    );
  }
  const { model, method } = parsed;

  if (!isGeminiModel(model)) {
    return geminiError(
      400,
      `Unsupported model "${model}". Copilot Proxy only exposes Gemini models ` +
        `via the /v1beta endpoint (try gemini-2.5-pro, gemini-3-flash-preview, ` +
        `or gemini-3.1-pro-preview). For other models use /chat/completions or /v1/messages.`,
      "INVALID_ARGUMENT",
    );
  }

  const endpoint = `/v1beta/models/:${method}`;

  let payload: any = {};
  try {
    payload = await c.req.json();
  } catch {
    // countTokens with empty body is tolerated; others need a body.
    if (method !== "countTokens") {
      return geminiError(400, "Request body must be valid JSON", "INVALID_ARGUMENT");
    }
  }

  switch (method) {
    case "generateContent":
      return handleGenerateContent(c, payload, model, requestId, startTime, endpoint, false);
    case "streamGenerateContent":
      return handleGenerateContent(c, payload, model, requestId, startTime, endpoint, true);
    case "countTokens":
      return handleCountTokens(c, payload, model, requestId, startTime, endpoint);
    default:
      return geminiError(
        404,
        `Unsupported method "${method}". Use generateContent, streamGenerateContent, or countTokens.`,
        "NOT_FOUND",
      );
  }
});

async function handleGenerateContent(
  c: any,
  payload: any,
  model: string,
  requestId: string,
  startTime: number,
  endpoint: string,
  isStreaming: boolean,
): Promise<Response> {
  await ensureCopilotToken();

  const openaiPayload = buildOpenAIRequestFromGemini({
    model,
    stream: isStreaming,
    payload,
  });

  if (isStreaming) {
    openaiPayload.stream_options = {
      ...(openaiPayload.stream_options ?? {}),
      include_usage: true,
    };
  }

  const enableVision = (openaiPayload.messages ?? []).some(
    (m: any) =>
      Array.isArray(m.content) &&
      m.content.some((p: any) => p?.type === "image_url"),
  );
  const headers = getCopilotHeaders(enableVision);
  headers["X-Initiator"] = (openaiPayload.messages ?? []).some(
    (m: any) => m.role === "assistant" || m.role === "tool",
  )
    ? "agent"
    : "user";

  try {
    const resp = await fetchUpstream(
      `${getCopilotBaseUrl()}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify(openaiPayload) },
    );

    if (isStreaming && resp.ok && resp.body) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");
      return stream(c, async (s) => {
        const state = new GeminiStreamState(model);
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              let chunk: any;
              try {
                chunk = JSON.parse(data);
              } catch {
                continue;
              }
              const geminiChunks = translateOpenAIChunkToGemini(chunk, state);
              for (const g of geminiChunks) {
                await s.write(`data: ${JSON.stringify(g)}\n\n`);
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await s.write(
            `data: ${JSON.stringify(buildGeminiErrorStreamChunk(msg, state))}\n\n`,
          );
        } finally {
          logRequest({
            ...makeLogEntry(requestId, model, endpoint, startTime),
            input_tokens: state.totalInputTokens,
            output_tokens: state.totalOutputTokens,
            cache_read_input_tokens: state.cacheReadInputTokens,
            reasoning_tokens: state.reasoningTokens,
            duration_ms: Date.now() - startTime,
          } as RequestLogEntry);
        }
      });
    }

    // Non-streaming (or streaming with a non-OK response)
    const bodyText = await resp.text();
    if (!resp.ok) {
      logRequest({
        ...makeLogEntry(requestId, model, endpoint, startTime),
        duration_ms: Date.now() - startTime,
        status_code: resp.status,
        error: bodyText.slice(0, 500),
      } as RequestLogEntry);
      return geminiError(
        resp.status >= 400 && resp.status < 600 ? resp.status : 500,
        `Upstream error: ${bodyText.slice(0, 300)}`,
        resp.status === 401 || resp.status === 403 ? "PERMISSION_DENIED" : "INTERNAL",
      );
    }

    let openaiResp: any = {};
    try {
      openaiResp = JSON.parse(bodyText);
    } catch {}
    const geminiResp = convertOpenAIResponseToGemini(openaiResp, model);
    const usage = openaiResp.usage ?? {};
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    logRequest({
      ...makeLogEntry(requestId, model, endpoint, startTime),
      input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cachedTokens),
      output_tokens: Math.max(0, (usage.completion_tokens ?? 0) - reasoningTokens),
      cache_read_input_tokens: cachedTokens,
      reasoning_tokens: reasoningTokens,
      duration_ms: Date.now() - startTime,
      status_code: resp.status,
    } as RequestLogEntry);

    return new Response(JSON.stringify(geminiResp), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logRequest({
      ...makeLogEntry(requestId, model, endpoint, startTime),
      duration_ms: Date.now() - startTime,
      status_code: 504,
      error: msg,
    } as RequestLogEntry);
    return geminiError(504, msg, "UNAVAILABLE");
  }
}

/**
 * countTokens: approximate by string-length / 4, mirroring the anthropic route.
 * This avoids an extra upstream round-trip.
 */
async function handleCountTokens(
  c: any,
  payload: any,
  model: string,
  requestId: string,
  startTime: number,
  endpoint: string,
): Promise<Response> {
  const approx = (s: string) => Math.ceil((s ?? "").length / 4);
  let total = 0;

  const contents = payload?.contents ?? payload?.generateContentRequest?.contents ?? [];
  for (const content of contents) {
    for (const part of content?.parts ?? []) {
      if (typeof part?.text === "string") total += approx(part.text);
      else if (part?.functionCall) total += approx(JSON.stringify(part.functionCall));
      else if (part?.functionResponse)
        total += approx(JSON.stringify(part.functionResponse));
    }
  }

  const sys = payload?.systemInstruction?.parts ?? [];
  for (const part of sys) {
    if (typeof part?.text === "string") total += approx(part.text);
  }

  const tools = payload?.tools ?? [];
  for (const tool of tools) {
    for (const decl of tool?.functionDeclarations ?? []) {
      total += approx(decl?.name ?? "");
      total += approx(decl?.description ?? "");
      total += approx(JSON.stringify(decl?.parameters ?? {}));
    }
  }

  logRequest({
    ...makeLogEntry(requestId, model, endpoint, startTime),
    input_tokens: total,
    duration_ms: Date.now() - startTime,
  } as RequestLogEntry);

  return c.json({ totalTokens: total });
}

export { geminiRouter };

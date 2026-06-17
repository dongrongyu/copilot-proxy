/**
 * OpenAI-compatible routes: /v1/chat/completions, /chat/completions, /v1/responses
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { ensureCopilotToken, getCopilotBaseUrl, supportsResponsesApi } from "../auth/copilot-token";
import { getCopilotHeaders, hasVisionContent, isAgentCall } from "../proxy/headers";
import { translateModelName } from "../proxy/model-mapping";
import { fetchUpstream } from "../proxy/request";
import { logRequest, type RequestLogEntry } from "../usage/logger";
import {
  translateResponsesToChat,
  translateChatToResponses,
  translateChatChunkToResponses,
  emitResponsesCompleted,
  ResponsesStreamState,
} from "../translator/responses-to-chat";

const openaiRouter = new Hono();

function makeLogEntry(
  requestId: string, originalModel: string, translatedModel: string,
  endpoint: string, startTime: number
): Partial<RequestLogEntry> {
  return {
    timestamp: new Date().toISOString(),
    request_id: requestId,
    model: originalModel,
    translated_model: translatedModel !== originalModel ? translatedModel : null,
    endpoint,
    provider: "openai",
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    reasoning_tokens: 0,
    effort: "",
    duration_ms: 0, status_code: 200, error: null,
  };
}

/**
 * Extract the 5-category token split from an OpenAI-style usage object.
 * Works for /chat/completions usage and /v1/responses usage (after key
 * normalisation by the caller).
 */
function extractOpenAIUsage(usage: any): {
  input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
} {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    cache_read_input_tokens: cachedTokens,
    output_tokens: Math.max(0, completionTokens - reasoningTokens),
    reasoning_tokens: reasoningTokens,
  };
}

// POST /v1/chat/completions and /chat/completions
for (const path of ["/v1/chat/completions", "/chat/completions"]) {
  openaiRouter.post(path, async (c) => {
    const startTime = Date.now();
    await ensureCopilotToken();
    const payload = await c.req.json();
    const requestId = crypto.randomUUID();

    const originalModel = payload.model ?? "unknown";
    const translatedModel = translateModelName(originalModel);
    if (translatedModel !== originalModel) {
      console.log(`[OpenAI] Model translated: ${originalModel} -> ${translatedModel}`);
      payload.model = translatedModel;
    }

    const messages = payload.messages ?? [];
    const enableVision = messages.some(
      (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
    );
    const headers = getCopilotHeaders(enableVision);
    headers["X-Initiator"] = messages.some((m: any) => m.role === "assistant" || m.role === "tool")
      ? "agent" : "user";

    const isStreaming = payload.stream;

    // Force include_usage for streaming so we can record token counts.
    // Copilot's upstream supports this natively and it has no latency/cost impact.
    if (isStreaming) {
      payload.stream_options = { ...(payload.stream_options ?? {}), include_usage: true };
    }

    try {
      const resp = await fetchUpstream(
        `${getCopilotBaseUrl()}/chat/completions`,
        { method: "POST", headers, body: JSON.stringify(payload) }
      );

      if (isStreaming && resp.ok && resp.body) {
        return stream(c, async (s) => {
          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");
          c.header("X-Accel-Buffering", "no");

          const reader = resp.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let usage: any = {};

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line) continue;
                if (line.startsWith("data: ")) {
                  const data = line.slice(6);
                  if (data === "[DONE]") {
                    await s.write("data: [DONE]\n\n");
                    break;
                  }
                  try {
                    const chunk = JSON.parse(data);
                    if (chunk.usage) usage = chunk.usage;
                  } catch {}
                }
                await s.write(line + "\n\n");
              }
            }
          } finally {
            logRequest({
              ...makeLogEntry(requestId, originalModel, translatedModel, path, startTime),
              ...extractOpenAIUsage(usage),
              duration_ms: Date.now() - startTime,
            } as RequestLogEntry);
          }
        });
      }

      const body = await resp.text();
      let usage: any = {};
      try { usage = JSON.parse(body).usage ?? {}; } catch {}

      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, path, startTime),
        ...extractOpenAIUsage(usage),
        duration_ms: Date.now() - startTime,
        status_code: resp.status,
        error: resp.ok ? null : body.slice(0, 500),
      } as RequestLogEntry);

      return new Response(body, { status: resp.status, headers: { "Content-Type": "application/json" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, path, startTime),
        duration_ms: Date.now() - startTime, status_code: 504, error: msg,
      } as RequestLogEntry);
      return c.json({ error: { message: msg, type: "api_error" } }, 504);
    }
  });
}

// POST /v1/responses
openaiRouter.post("/v1/responses", async (c) => {
  const startTime = Date.now();
  await ensureCopilotToken();
  const payload = await c.req.json();
  const requestId = crypto.randomUUID();

  const originalModel = payload.model ?? "unknown";
  const translatedModel = translateModelName(originalModel);
  if (translatedModel !== originalModel) {
    payload.model = translatedModel;
  }

  // If the model doesn't support /v1/responses, translate to /chat/completions
  // and re-translate the response back to Responses format.
  if (!supportsResponsesApi(translatedModel)) {
    return await handleResponsesViaChat(c, payload, originalModel, translatedModel, requestId, startTime);
  }

  const headers = getCopilotHeaders();
  headers["X-Initiator"] = "agent";

  const isStreaming = payload.stream;

  try {
    const resp = await fetchUpstream(
      `${getCopilotBaseUrl()}/v1/responses`,
      { method: "POST", headers, body: JSON.stringify(payload) }
    );

    if (isStreaming && resp.ok && resp.body) {
      return stream(c, async (s) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let usage: any = {};

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line) continue;
              if (line.startsWith("data: ")) {
                try {
                  const data = line.slice(6);
                  const event = JSON.parse(data);
                  if (event.type === "response.completed") {
                    usage = event.response?.usage ?? {};
                  }
                } catch {}
              }
              await s.write(line + "\n\n");
            }
          }
        } finally {
          const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
          const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
          const rawInput = usage.input_tokens ?? usage.prompt_tokens ?? 0;
          const rawOutput = usage.output_tokens ?? usage.completion_tokens ?? 0;
          logRequest({
            ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/responses", startTime),
            input_tokens: Math.max(0, rawInput - cachedTokens),
            cache_read_input_tokens: cachedTokens,
            output_tokens: Math.max(0, rawOutput - reasoningTokens),
            reasoning_tokens: reasoningTokens,
            duration_ms: Date.now() - startTime,
          } as RequestLogEntry);
        }
      });
    }

    const body = await resp.text();
    let usage: any = {};
    if (resp.ok) {
      try { usage = JSON.parse(body).usage ?? {}; } catch {}
    }
    {
      const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
      const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
      const rawInput = usage.input_tokens ?? 0;
      const rawOutput = usage.output_tokens ?? 0;
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/responses", startTime),
        input_tokens: Math.max(0, rawInput - cachedTokens),
        cache_read_input_tokens: cachedTokens,
        output_tokens: Math.max(0, rawOutput - reasoningTokens),
        reasoning_tokens: reasoningTokens,
        duration_ms: Date.now() - startTime,
        status_code: resp.status,
        error: resp.ok ? null : body.slice(0, 500),
      } as RequestLogEntry);
    }

    return new Response(body, { status: resp.status, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: { message: msg, type: "api_error" } }, 504);
  }
});

export { openaiRouter };

/**
 * Handle a /v1/responses request by translating to /chat/completions
 * for models that don't support the Responses API (e.g. Claude via Copilot).
 */
async function handleResponsesViaChat(
  c: any,
  responsesPayload: any,
  originalModel: string,
  translatedModel: string,
  requestId: string,
  startTime: number,
): Promise<Response> {
  const chatPayload = translateResponsesToChat(responsesPayload);
  chatPayload.model = translatedModel;
  const isStreaming = !!responsesPayload.stream;
  chatPayload.stream = isStreaming;

  const messages = chatPayload.messages ?? [];
  const enableVision = messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
  );
  const headers = getCopilotHeaders(enableVision);
  headers["X-Initiator"] = "agent";

  try {
    const resp = await fetchUpstream(
      `${getCopilotBaseUrl()}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify(chatPayload) }
    );

    if (!resp.ok) {
      const body = await resp.text();
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/responses", startTime),
        duration_ms: Date.now() - startTime,
        status_code: resp.status,
        error: body.slice(0, 500),
      } as RequestLogEntry);
      return new Response(body, { status: resp.status, headers: { "Content-Type": "application/json" } });
    }

    if (isStreaming && resp.body) {
      return stream(c, async (s) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");
        c.header("X-Accel-Buffering", "no");

        const state = new ResponsesStreamState(translatedModel);
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
              if (!line || !line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const chunk = JSON.parse(data);
                const sseOut = translateChatChunkToResponses(chunk, state);
                if (sseOut) await s.write(sseOut);
              } catch {}
            }
          }
          await s.write(emitResponsesCompleted(state));
        } finally {
          logRequest({
            ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/responses", startTime),
            ...extractOpenAIUsage(state.usage),
            duration_ms: Date.now() - startTime,
          } as RequestLogEntry);
        }
      });
    }

    // Non-streaming
    const bodyText = await resp.text();
    let chatResp: any = {};
    try { chatResp = JSON.parse(bodyText); } catch {}
    const responsesObj = translateChatToResponses(chatResp, translatedModel);
    const usage = chatResp?.usage ?? {};

    logRequest({
      ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/responses", startTime),
      ...extractOpenAIUsage(usage),
      duration_ms: Date.now() - startTime,
      status_code: resp.status,
    } as RequestLogEntry);

    return new Response(JSON.stringify(responsesObj), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logRequest({
      ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/responses", startTime),
      duration_ms: Date.now() - startTime, status_code: 504, error: msg,
    } as RequestLogEntry);
    return c.json({ error: { message: msg, type: "api_error" } }, 504);
  }
}

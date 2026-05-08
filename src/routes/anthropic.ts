/**
 * Anthropic-compatible API routes: /v1/messages, /v1/messages/count_tokens
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getState } from "../auth/state";
import {
  ensureCopilotToken,
  getCopilotBaseUrl,
  supportsDirectAnthropicApi,
} from "../auth/copilot-token";
import {
  getAnthropicHeaders,
  getCopilotHeaders,
  hasVisionContent,
  isAgentCall,
} from "../proxy/headers";
import { translateModelName } from "../proxy/model-mapping";
import {
  fetchUpstream,
  isOrphanedToolResultError,
  extractOrphanedToolUseIds,
  removeOrphanedToolResults,
} from "../proxy/request";
import {
  hasWebSearchTool,
  isWebSearchUnsupportedError,
  applyWebSearchFallback,
  buildWebSearchResponseBlocks,
  type WebSearchFallbackResult,
} from "../proxy/web-search";
import { translateAnthropicToOpenai } from "../translator/anthropic-to-openai";
import { translateOpenaiToAnthropic } from "../translator/openai-to-anthropic";
import {
  AnthropicStreamState,
  translateChunkToAnthropicEvents,
  reconstructOpenaiResponse,
} from "../translator/streaming";
import { logRequest, type RequestLogEntry } from "../usage/logger";

const anthropicRouter = new Hono();

// Fields supported by Copilot's Anthropic API endpoint
const COPILOT_SUPPORTED_FIELDS = new Set([
  "model", "messages", "max_tokens", "system", "metadata",
  "stop_sequences", "stream", "temperature", "top_p", "top_k",
  "tools", "tool_choice", "thinking", "service_tier", "output_config",
]);

function filterPayloadForCopilot(payload: any): any {
  const filtered: any = {};
  for (const [key, value] of Object.entries(payload)) {
    if (COPILOT_SUPPORTED_FIELDS.has(key)) {
      filtered[key] = value;
    }
  }
  removeScopeFromCacheControl(filtered);
  return filtered;
}

function removeScopeFromCacheControl(payload: any): void {
  const removeScope = (block: any) => {
    const cc = block?.cache_control;
    if (cc?.type === "ephemeral" && "scope" in cc) {
      delete cc.scope;
    }
  };
  for (const tool of payload.tools ?? []) removeScope(tool);
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) removeScope(block);
  }
  for (const msg of payload.messages ?? []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) removeScope(block);
    }
  }
}

function adjustMaxTokensForThinking(payload: any): any {
  const budget = payload.thinking?.budget_tokens;
  if (!budget) return payload;
  const maxTokens = payload.max_tokens ?? 0;
  if (maxTokens <= budget) {
    const buffer = Math.min(16384, budget);
    return { ...payload, max_tokens: budget + buffer };
  }
  return payload;
}

/**
 * Convert thinking.type "enabled" to "adaptive" for models that require it (e.g. opus-4.7+).
 * These models use thinking.type: "adaptive" + output_config.effort instead.
 *
 * Effort is taken from the model's `capabilities.supports.reasoning_effort`
 * advertised by the Copilot `/models` endpoint — we always send the strongest
 * value the server will accept. Plain `claude-opus-4.7` is pinned to medium
 * server-side; `-xhigh` siblings advertise xhigh; the 1m-internal variant
 * advertises xhigh natively. Falls back to "medium" only when metadata is
 * missing.
 */
function adjustThinkingForModel(payload: any, model: string): any {
  if (payload.thinking?.type !== "enabled") return payload;
  if (!model.includes("4.7") && !model.includes("4-7")) return payload;

  const effort = getMaxEffortFromModelCatalog(model) ?? "medium";

  const result = { ...payload };
  result.thinking = { type: "adaptive" };
  result.output_config = { ...(payload.output_config ?? {}), effort };
  return result;
}

/**
 * Look up the model's strongest supported reasoning effort from the cached
 * Copilot `/models` catalog. Returns null when the model is unknown or has
 * no reasoning_effort capability.
 */
function getMaxEffortFromModelCatalog(model: string): string | null {
  const state = getState();
  const entry = state.models?.data?.find((m: any) => m.id === model);
  const supported: string[] | undefined = (entry as any)?.capabilities?.supports?.reasoning_effort;
  if (!supported || supported.length === 0) return null;
  const priority = ["xhigh", "high", "medium", "low", "minimal", "none"];
  for (const e of priority) {
    if (supported.includes(e)) return e;
  }
  return null;
}

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
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    duration_ms: 0, status_code: 200, error: null,
  };
}

// POST /v1/messages
anthropicRouter.post("/v1/messages", async (c) => {
  const startTime = Date.now();
  await ensureCopilotToken();
  const payload = await c.req.json();
  const requestId = crypto.randomUUID();

  const originalModel = payload.model ?? "unknown";
  const translatedModel = translateModelName(originalModel);
  if (translatedModel !== originalModel) {
    console.log(`[Anthropic] Model translated: ${originalModel} -> ${translatedModel}`);
  }
  payload.model = translatedModel;

  const useDirect = supportsDirectAnthropicApi(translatedModel);
  if (useDirect) {
    console.log(`[Anthropic] Direct path for: ${translatedModel}`);
    return handleDirectAnthropic(c, payload, requestId, startTime, originalModel, translatedModel);
  } else {
    console.log(`[Anthropic] Translation path for: ${translatedModel}`);
    return handleTranslatedAnthropic(c, payload, requestId, startTime, originalModel, translatedModel);
  }
});

async function handleDirectAnthropic(
  c: any, payload: any, requestId: string, startTime: number,
  originalModel: string, translatedModel: string
) {
  const state = getState();
  const messages = payload.messages ?? [];
  const enableVision = hasVisionContent(messages);
  const headers = getAnthropicHeaders(enableVision);
  headers["X-Initiator"] = isAgentCall(messages) ? "agent" : "user";

  let currentPayload = payload;
  const maxRetries = 3;
  let webSearchMeta: WebSearchFallbackResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let filtered = filterPayloadForCopilot(currentPayload);
    filtered = adjustMaxTokensForThinking(filtered);
    filtered = adjustThinkingForModel(filtered, translatedModel);

    const isStreaming = filtered.stream;

    try {
      const resp = await fetchUpstream(
        `${getCopilotBaseUrl()}/v1/messages`,
        { method: "POST", headers, body: JSON.stringify(filtered) }
      );

      if (isStreaming && resp.ok && resp.body) {
        return streamDirectAnthropic(c, resp, requestId, startTime, originalModel, translatedModel, webSearchMeta);
      }

      if (resp.ok) {
        const body = await resp.json() as any;
        if (webSearchMeta) {
          const searchBlocks = buildWebSearchResponseBlocks(webSearchMeta.query, webSearchMeta.results);
          body.content = [...searchBlocks, ...(body.content ?? [])];
        }
        const usage = body.usage ?? {};
        logRequest({
          ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          duration_ms: Date.now() - startTime,
          status_code: resp.status,
        } as RequestLogEntry);
        return c.json(body);
      }

      // Error handling
      const errorText = await resp.text();

      // Web search fallback
      if (state.config.web_search.enabled && hasWebSearchTool(currentPayload) &&
          isWebSearchUnsupportedError(resp.status, errorText)) {
        console.log(`[Anthropic] Web search fallback for ${requestId}`);
        webSearchMeta = await applyWebSearchFallback(currentPayload);
        currentPayload = webSearchMeta.payload;
        continue;
      }

      // Orphaned tool_result
      if (isOrphanedToolResultError(resp.status, errorText)) {
        const ids = extractOrphanedToolUseIds(errorText);
        if (ids.length > 0) {
          console.log(`[Anthropic] Cleaning orphaned tool_results: ${ids.join(", ")}`);
          currentPayload = {
            ...currentPayload,
            messages: removeOrphanedToolResults(currentPayload.messages ?? [], ids),
          };
          continue;
        }
      }

      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
        duration_ms: Date.now() - startTime,
        status_code: resp.status,
        error: errorText.slice(0, 500),
      } as RequestLogEntry);
      return new Response(errorText, { status: resp.status, headers: { "Content-Type": "application/json" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
        duration_ms: Date.now() - startTime,
        status_code: 504,
        error: msg,
      } as RequestLogEntry);
      return c.json({ type: "error", error: { type: "api_error", message: msg } }, 504);
    }
  }

  return c.json({ type: "error", error: { type: "api_error", message: "Max retries exceeded" } }, 502);
}

function streamDirectAnthropic(
  c: any, resp: Response, requestId: string, startTime: number,
  originalModel: string, translatedModel: string,
  webSearchMeta: WebSearchFallbackResult | null = null
) {
  let totalInput = 0, totalOutput = 0, cachCreate = 0, cachRead = 0;

  return stream(c, async (s) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sseEventType = "";
    let searchBlocksEmitted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line) continue;

          if (line.startsWith("event: ")) {
            sseEventType = line.slice(7);
            continue;
          }

          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;

            try {
              const event = JSON.parse(data);
              const eventType = sseEventType || event.type || "";
              sseEventType = "";

              if (eventType === "message_start") {
                const usage = event.message?.usage ?? {};
                totalInput = usage.input_tokens ?? 0;
                cachCreate = usage.cache_creation_input_tokens ?? 0;
                cachRead = usage.cache_read_input_tokens ?? 0;
              } else if (eventType === "message_delta") {
                totalOutput = event.usage?.output_tokens ?? 0;
              }

              await s.write(`event: ${eventType}\ndata: ${data}\n\n`);

              // Emit synthetic web search blocks right after message_start
              if (eventType === "message_start" && webSearchMeta && !searchBlocksEmitted) {
                searchBlocksEmitted = true;
                const searchBlocks = buildWebSearchResponseBlocks(webSearchMeta.query, webSearchMeta.results);
                let idx = 0;
                for (const block of searchBlocks) {
                  await s.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: block })}\n\n`);
                  await s.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`);
                  idx++;
                }
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      console.error(`[Stream] Error: ${err}`);
    } finally {
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
        input_tokens: totalInput, output_tokens: totalOutput,
        cache_creation_input_tokens: cachCreate, cache_read_input_tokens: cachRead,
        duration_ms: Date.now() - startTime,
      } as RequestLogEntry);
    }
  });
}

async function handleTranslatedAnthropic(
  c: any, anthropicPayload: any, requestId: string, startTime: number,
  originalModel: string, translatedModel: string
) {
  const state = getState();
  const messages = anthropicPayload.messages ?? [];
  const enableVision = hasVisionContent(messages);
  let currentPayload = anthropicPayload;
  const maxRetries = 3;
  let webSearchMeta: WebSearchFallbackResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const openaiPayload = translateAnthropicToOpenai(currentPayload);
    const isAgent = openaiPayload.messages?.some(
      (m: any) => m.role === "assistant" || m.role === "tool"
    );
    const headers = getCopilotHeaders(enableVision);
    headers["X-Initiator"] = isAgent ? "agent" : "user";

    if (anthropicPayload.stream) {
      return streamTranslatedAnthropic(
        c, openaiPayload, headers, requestId, startTime, originalModel, translatedModel, webSearchMeta
      );
    }

    try {
      const resp = await fetchUpstream(
        `${getCopilotBaseUrl()}/chat/completions`,
        { method: "POST", headers, body: JSON.stringify(openaiPayload) }
      );

      if (resp.ok) {
        const openaiResp = await resp.json();
        const anthropicResp = translateOpenaiToAnthropic(openaiResp) as any;
        if (webSearchMeta) {
          const searchBlocks = buildWebSearchResponseBlocks(webSearchMeta.query, webSearchMeta.results);
          anthropicResp.content = [...searchBlocks, ...(anthropicResp.content ?? [])];
        }
        const usage = (openaiResp as any).usage ?? {};
        logRequest({
          ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          duration_ms: Date.now() - startTime,
        } as RequestLogEntry);
        return c.json(anthropicResp);
      }

      const errorText = await resp.text();

      if (state.config.web_search.enabled && hasWebSearchTool(currentPayload) &&
          isWebSearchUnsupportedError(resp.status, errorText)) {
        webSearchMeta = await applyWebSearchFallback(currentPayload);
        currentPayload = webSearchMeta.payload;
        continue;
      }

      if (isOrphanedToolResultError(resp.status, errorText)) {
        const ids = extractOrphanedToolUseIds(errorText);
        if (ids.length > 0) {
          currentPayload = {
            ...currentPayload,
            messages: removeOrphanedToolResults(currentPayload.messages ?? [], ids),
          };
          continue;
        }
      }

      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
        duration_ms: Date.now() - startTime,
        status_code: resp.status, error: errorText.slice(0, 500),
      } as RequestLogEntry);
      return new Response(errorText, { status: resp.status, headers: { "Content-Type": "application/json" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
        duration_ms: Date.now() - startTime, status_code: 504, error: msg,
      } as RequestLogEntry);
      return c.json({ type: "error", error: { type: "api_error", message: msg } }, 504);
    }
  }

  return c.json({ type: "error", error: { type: "api_error", message: "Max retries exceeded" } }, 502);
}

function streamTranslatedAnthropic(
  c: any, openaiPayload: any, headers: Record<string, string>,
  requestId: string, startTime: number, originalModel: string, translatedModel: string,
  webSearchMeta: WebSearchFallbackResult | null = null
) {
  return stream(c, async (s) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    const sState = new AnthropicStreamState();
    const chunks: any[] = [];
    let searchBlocksEmitted = false;

    try {
      const resp = await fetchUpstream(
        `${getCopilotBaseUrl()}/chat/completions`,
        { method: "POST", headers, body: JSON.stringify(openaiPayload) }
      );

      if (!resp.ok || !resp.body) {
        const errText = await resp.text();
        await s.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errText } })}\n\n`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;

          try {
            const chunk = JSON.parse(data);
            chunks.push(chunk);
            const events = translateChunkToAnthropicEvents(chunk, sState);
            for (const evt of events) {
              await s.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);

              // Emit synthetic web search blocks right after message_start
              if (evt.type === "message_start" && webSearchMeta && !searchBlocksEmitted) {
                searchBlocksEmitted = true;
                const searchBlocks = buildWebSearchResponseBlocks(webSearchMeta.query, webSearchMeta.results);
                let idx = 0;
                for (const block of searchBlocks) {
                  await s.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: block })}\n\n`);
                  await s.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`);
                  idx++;
                }
                // Adjust the stream state index to account for injected blocks
                sState.contentBlockIndex = searchBlocks.length - 1;
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      console.error(`[Stream Translated] Error: ${err}`);
    } finally {
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime),
        input_tokens: sState.totalInputTokens,
        output_tokens: sState.totalOutputTokens,
        cache_read_input_tokens: sState.cacheReadInputTokens,
        duration_ms: Date.now() - startTime,
      } as RequestLogEntry);
    }
  });
}

// POST /v1/messages/count_tokens
anthropicRouter.post("/v1/messages/count_tokens", async (c) => {
  try {
    await ensureCopilotToken();
    const payload = await c.req.json();
    const modelId = translateModelName(payload.model ?? "");

    // Simple token counting using string length / 4 as approximation
    // TODO: integrate js-tiktoken for accurate counting
    let totalTokens = 0;
    const countStr = (s: string) => Math.ceil(s.length / 4);

    // System prompt
    const system = payload.system;
    if (typeof system === "string") {
      totalTokens += countStr(system);
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block?.type === "text") totalTokens += countStr(block.text ?? "");
      }
    }

    // Messages
    for (const msg of payload.messages ?? []) {
      const content = msg.content;
      if (typeof content === "string") {
        totalTokens += countStr(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") totalTokens += countStr(block.text ?? "");
          else if (block.type === "tool_result") {
            const tc = block.content;
            if (typeof tc === "string") totalTokens += countStr(tc);
          } else if (block.type === "tool_use") {
            totalTokens += countStr(JSON.stringify(block.input ?? {}));
          }
        }
      }
    }

    // Tools overhead
    const tools = payload.tools ?? [];
    if (tools.length > 0) {
      totalTokens += modelId.startsWith("claude") ? 346 : 480;
      for (const tool of tools) {
        totalTokens += countStr(tool.name ?? "");
        totalTokens += countStr(tool.description ?? "");
        totalTokens += countStr(JSON.stringify(tool.input_schema ?? {}));
      }
    }

    // Buffer for non-Anthropic models
    const state = getState();
    const modelData = state.models?.data?.find((m) => m.id === modelId);
    if (modelData?.vendor !== "Anthropic") {
      totalTokens = Math.ceil(totalTokens * (modelId.startsWith("grok") ? 1.03 : 1.05));
    }

    return c.json({ input_tokens: totalTokens });
  } catch (err) {
    console.error(`[count_tokens] Error: ${err}`);
    return c.json({ input_tokens: 1 });
  }
});

export { anthropicRouter };

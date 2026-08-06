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
  supportsResponsesApi,
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
  configuredEffortForModel,
} from "../proxy/reasoning-effort";
import {
  hasWebSearchTool,
  isWebSearchUnsupportedError,
  applyWebSearchFallback,
  buildWebSearchResponseBlocks,
  type WebSearchFallbackResult,
} from "../proxy/web-search";
import { translateAnthropicToOpenai } from "../translator/anthropic-to-openai";
import { translateOpenaiToAnthropic } from "../translator/openai-to-anthropic";
import { chatToResponsesRequest } from "../translator/chat-to-responses";
import {
  ResponsesChunkState,
  responsesEventToChatChunks,
  finalizeResponsesStream,
  responsesToChatResponse,
} from "../translator/responses-to-anthropic-chunks";
import {
  AnthropicStreamState,
  translateChunkToAnthropicEvents,
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
 * Convert thinking.type "enabled" to "adaptive" and attach the configured
 * reasoning effort, for any model that advertises a `reasoning_effort`
 * capability (claude-opus-4.6/4.7/4.8, claude-sonnet-4.6, …). These models use
 * thinking.type: "adaptive" + output_config.effort instead of budget_tokens.
 *
 * The effort comes from `config.effort` (default "high"), clamped to the
 * nearest value the model actually supports — see resolveEffort. Models with no
 * reasoning_effort capability are left untouched.
 */
function adjustThinkingForModel(payload: any, model: string): any {
  const effort = resolveEffort(payload, model);
  if (!effort) return payload;

  const result = { ...payload };
  result.thinking = { type: "adaptive" };
  result.output_config = { ...(payload.output_config ?? {}), effort };
  return result;
}
export { clampEffortToSupported } from "../proxy/reasoning-effort";

/**
 * Resolve the reasoning effort to send (and log) for a (payload, model) pair.
 *
 * Returns "" — meaning "inject nothing" — when the request carries no thinking
 * (type must be enabled/adaptive) or the model advertises no reasoning_effort
 * capability. Otherwise it takes the globally configured target effort
 * (config.effort, default "high") and clamps it to the nearest value the model
 * supports via clampEffortToSupported.
 *
 * This is the single source of truth: both the wire value (adjustThinkingForModel)
 * and the logged value go through here, so they can never diverge.
 */
function resolveEffort(payload: any, model: string): string {
  const tType = payload?.thinking?.type;
  if (tType !== "enabled" && tType !== "adaptive") return "";
  return configuredEffortForModel(model);
}

function makeLogEntry(
  requestId: string, originalModel: string, translatedModel: string,
  endpoint: string, startTime: number, effort = ""
): Partial<RequestLogEntry> {
  const useDirect = supportsDirectAnthropicApi(translatedModel);
  return {
    timestamp: new Date().toISOString(),
    request_id: requestId,
    model: originalModel,
    translated_model: translatedModel !== originalModel ? translatedModel : null,
    endpoint,
    provider: useDirect ? "anthropic" : "openai",
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    reasoning_tokens: 0,
    effort,
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
  }

  // Copilot's strongest GPT models are served on /responses only and reject
  // /chat/completions outright, so the upstream shape is picked per model.
  const mode: TranslatedMode = supportsResponsesApi(translatedModel) ? "responses" : "chat";
  console.log(`[Anthropic] Translation path (${mode}) for: ${translatedModel}`);
  return handleTranslatedAnthropic(
    c, payload, requestId, startTime, originalModel, translatedModel, mode
  );
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
  const effort = resolveEffort(payload, translatedModel);

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
        return streamDirectAnthropic(c, resp, requestId, startTime, originalModel, translatedModel, webSearchMeta, effort);
      }

      if (resp.ok) {
        const body = await resp.json() as any;
        if (webSearchMeta) {
          const searchBlocks = buildWebSearchResponseBlocks(webSearchMeta.query, webSearchMeta.results);
          body.content = [...searchBlocks, ...(body.content ?? [])];
        }
        const usage = body.usage ?? {};
        logRequest({
          ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
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
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
        duration_ms: Date.now() - startTime,
        status_code: resp.status,
        error: errorText.slice(0, 500),
      } as RequestLogEntry);
      return new Response(errorText, { status: resp.status, headers: { "Content-Type": "application/json" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
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
  webSearchMeta: WebSearchFallbackResult | null = null,
  effort = ""
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
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
        input_tokens: totalInput, output_tokens: totalOutput,
        cache_creation_input_tokens: cachCreate, cache_read_input_tokens: cachRead,
        duration_ms: Date.now() - startTime,
      } as RequestLogEntry);
    }
  });
}

/**
 * Which upstream wire format a non-Anthropic model is reached through.
 * Copilot serves its strongest GPT models on /responses only; the rest of the
 * translated models take /chat/completions.
 */
type TranslatedMode = "chat" | "responses";

/**
 * Build the upstream request for a translated (non-Anthropic) model.
 *
 * Both modes start from the same Anthropic -> chat translation; the Responses
 * mode then converts that at the boundary, so the Anthropic translator stays
 * shared and untouched.
 */
function buildTranslatedRequest(
  anthropicPayload: any,
  model: string,
  mode: TranslatedMode,
  enableVision: boolean,
): { body: any; headers: Record<string, string>; effort: string } {
  const chat = translateAnthropicToOpenai(anthropicPayload);

  const isAgent = chat.messages?.some(
    (m: any) => m.role === "assistant" || m.role === "tool"
  );
  const headers = getCopilotHeaders(enableVision);
  headers["X-Initiator"] = isAgent ? "agent" : "user";

  // Unlike the direct path this does not gate on `thinking` being present:
  // GPT-5.x reasons unconditionally, so gating there would mean the configured
  // effort never applied whenever the client had thinking switched off.
  // configuredEffortForModel already returns "" for models with no such
  // capability, which is the real gate.
  const effort = configuredEffortForModel(model);
  if (effort) chat.reasoning_effort = effort;

  const body = mode === "responses" ? chatToResponsesRequest(chat) : chat;
  return { body, headers, effort };
}

async function handleTranslatedAnthropic(
  c: any, anthropicPayload: any, requestId: string, startTime: number,
  originalModel: string, translatedModel: string, mode: TranslatedMode
) {
  const state = getState();
  const messages = anthropicPayload.messages ?? [];
  const enableVision = hasVisionContent(messages);
  let currentPayload = anthropicPayload;
  const maxRetries = 3;
  let webSearchMeta: WebSearchFallbackResult | null = null;

  // No non-Anthropic model implements Anthropic's server-side web_search, so
  // run the search up front rather than waiting for a rejection that may never
  // come. This also strips the tool before translation — it carries no
  // input_schema and would otherwise reach the model as a parameterless
  // function.
  if (state.config.web_search.enabled && hasWebSearchTool(currentPayload)) {
    console.log(`[Anthropic] Web search (translated path) for ${requestId}`);
    webSearchMeta = await applyWebSearchFallback(currentPayload);
    currentPayload = webSearchMeta.payload;
  }

  const url = mode === "responses"
    ? `${getCopilotBaseUrl()}/v1/responses`
    : `${getCopilotBaseUrl()}/chat/completions`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { body, headers, effort } = buildTranslatedRequest(
      currentPayload, translatedModel, mode, enableVision
    );

    try {
      // The request is issued before the streaming branch so that retries,
      // web-search fallback and orphaned-tool_result repair apply to streaming
      // and non-streaming alike.
      const resp = await fetchUpstream(url, {
        method: "POST", headers, body: JSON.stringify(body),
      });

      if (body.stream && resp.ok && resp.body) {
        return streamTranslatedAnthropic(
          c, resp, mode, requestId, startTime, originalModel, translatedModel,
          webSearchMeta, effort
        );
      }

      if (resp.ok) {
        const upstream = await resp.json() as any;
        const chatShaped = mode === "responses" ? responsesToChatResponse(upstream) : upstream;
        const anthropicResp = translateOpenaiToAnthropic(chatShaped) as any;
        if (webSearchMeta) {
          const searchBlocks = buildWebSearchResponseBlocks(webSearchMeta.query, webSearchMeta.results);
          anthropicResp.content = [...searchBlocks, ...(anthropicResp.content ?? [])];
        }
        const usage = chatShaped.usage ?? {};
        const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
        const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
        logRequest({
          ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
          input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cachedTokens),
          output_tokens: Math.max(0, (usage.completion_tokens ?? 0) - reasoningTokens),
          cache_read_input_tokens: cachedTokens,
          reasoning_tokens: reasoningTokens,
          duration_ms: Date.now() - startTime,
        } as RequestLogEntry);
        return c.json(anthropicResp);
      }

      const errorText = await resp.text();

      // Only reachable when the proactive pass above was skipped (web search
      // disabled at request time, or the tool appeared after a retry).
      if (!webSearchMeta && state.config.web_search.enabled && hasWebSearchTool(currentPayload) &&
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
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
        duration_ms: Date.now() - startTime,
        status_code: resp.status, error: errorText.slice(0, 500),
      } as RequestLogEntry);
      return new Response(errorText, { status: resp.status, headers: { "Content-Type": "application/json" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
        duration_ms: Date.now() - startTime, status_code: 504, error: msg,
      } as RequestLogEntry);
      return c.json({ type: "error", error: { type: "api_error", message: msg } }, 504);
    }
  }

  return c.json({ type: "error", error: { type: "api_error", message: "Max retries exceeded" } }, 502);
}

function streamTranslatedAnthropic(
  c: any, resp: Response, mode: TranslatedMode,
  requestId: string, startTime: number, originalModel: string, translatedModel: string,
  webSearchMeta: WebSearchFallbackResult | null = null,
  effort = ""
) {
  return stream(c, async (s) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    const sState = new AnthropicStreamState();
    // Responses events are adapted into chat-completion chunks first, so the
    // Anthropic stream translator below is shared by both modes.
    const rState = mode === "responses" ? new ResponsesChunkState() : null;
    let searchBlocksEmitted = false;

    const emit = async (chunk: any) => {
      for (const evt of translateChunkToAnthropicEvents(chunk, sState)) {
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
    };

    try {
      const reader = resp.body!.getReader();
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
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          let parsed: any;
          try { parsed = JSON.parse(data); } catch { continue; }

          const chunks = rState ? responsesEventToChatChunks(parsed, rState) : [parsed];
          for (const chunk of chunks) await emit(chunk);
        }
      }

      // A Responses stream that ends without response.completed would otherwise
      // leave the client waiting on message_stop forever.
      if (rState) {
        for (const chunk of finalizeResponsesStream(rState)) await emit(chunk);
      }
    } catch (err) {
      console.error(`[Stream Translated] Error: ${err}`);
    } finally {
      logRequest({
        ...makeLogEntry(requestId, originalModel, translatedModel, "/v1/messages", startTime, effort),
        input_tokens: sState.totalInputTokens,
        output_tokens: sState.totalOutputTokens,
        cache_creation_input_tokens: sState.cacheCreationInputTokens,
        cache_read_input_tokens: sState.cacheReadInputTokens,
        reasoning_tokens: sState.reasoningTokens,
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

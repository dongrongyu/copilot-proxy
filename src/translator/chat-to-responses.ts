/**
 * Translate an OpenAI Chat Completions request into an OpenAI Responses request.
 *
 * Copilot serves its strongest GPT models on `/responses` only — they reject
 * `/chat/completions` outright ("not accessible via the /chat/completions
 * endpoint"). The Anthropic route reaches those models by composing
 * `translateAnthropicToOpenai` (Anthropic -> chat) with this function, so the
 * well-tested Anthropic translator stays untouched and only the wire format at
 * the boundary changes.
 *
 * This is the inverse of `translateResponsesToChat` in responses-to-chat.ts;
 * the two round-trip for everything the Anthropic translator can produce.
 */

interface ResponsesItem {
  type: string;
  [key: string]: any;
}

/**
 * Flatten a chat `content` value to plain text. Chat content is either a bare
 * string or an array of parts; only text parts contribute.
 */
function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
}

/**
 * Convert a chat user `content` value to Responses input parts.
 * Text becomes `input_text`; an `image_url` part becomes `input_image` whose
 * `image_url` is the flat URL string (Responses does not nest it in an object).
 */
function userContentToParts(content: any): ResponsesItem[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: ResponsesItem[] = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (url) parts.push({ type: "input_image", image_url: url });
    }
  }
  return parts;
}

/**
 * Convert chat-shaped tools `{type:"function", function:{...}}` to the flat
 * Responses shape `{type:"function", name, description, parameters}`.
 */
function toolsToResponses(tools: any[]): any[] {
  const converted: any[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    // Already flat — pass through.
    if (t.type === "function" && !t.function && t.name) {
      converted.push(t);
      continue;
    }
    if (t.type === "function" && t.function?.name) {
      const fn = t.function;
      const out: any = { type: "function", name: fn.name };
      if (fn.description !== undefined) out.description = fn.description;
      if (fn.parameters !== undefined) out.parameters = fn.parameters;
      if (fn.strict !== undefined) out.strict = fn.strict;
      converted.push(out);
    }
    // Unknown tool types are dropped rather than forwarded, to avoid a 400.
  }
  return converted;
}

/**
 * `tool_choice` is mostly shared between the two APIs. Only the explicit
 * named-function form differs: chat nests the name, Responses keeps it flat.
 */
function toolChoiceToResponses(choice: any): any {
  if (choice && typeof choice === "object" && choice.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  return choice;
}

export function chatToResponsesRequest(chat: any): any {
  const input: ResponsesItem[] = [];
  const instructions: string[] = [];

  for (const msg of chat.messages ?? []) {
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      // Responses carries the system prompt out-of-band, not as an input item.
      const text = contentToText(msg.content);
      if (text) instructions.push(text);
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: contentToText(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      // One chat message can carry both text and tool calls; Responses needs
      // them as separate items, text first so the transcript reads in order.
      const text = contentToText(msg.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tc of msg.tool_calls ?? []) {
        if (!tc) continue;
        input.push({
          type: "function_call",
          // Preserved verbatim: the client's next turn addresses its
          // tool_result to this id, so it has to survive the round trip.
          call_id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        });
      }
      continue;
    }

    const parts = userContentToParts(msg.content);
    if (parts.length > 0) {
      input.push({ type: "message", role: "user", content: parts });
    }
  }

  const out: any = {
    model: chat.model,
    input,
    stream: chat.stream ?? false,
  };

  if (instructions.length > 0) out.instructions = instructions.join("\n\n");

  const tools = Array.isArray(chat.tools) ? toolsToResponses(chat.tools) : [];
  if (tools.length > 0) out.tools = tools;

  if (chat.tool_choice !== undefined) out.tool_choice = toolChoiceToResponses(chat.tool_choice);
  if (chat.parallel_tool_calls !== undefined) out.parallel_tool_calls = chat.parallel_tool_calls;

  if (chat.temperature !== undefined) out.temperature = chat.temperature;
  if (chat.top_p !== undefined) out.top_p = chat.top_p;

  // Both chat spellings collapse onto the single Responses field.
  const maxTokens = chat.max_completion_tokens ?? chat.max_tokens;
  if (maxTokens !== undefined) out.max_output_tokens = maxTokens;

  // Chat expresses effort as a scalar; Responses nests it.
  if (chat.reasoning_effort) out.reasoning = { effort: chat.reasoning_effort };

  // Deliberately dropped: `stop` and `stream_options` have no Responses
  // equivalent, and forwarding either draws a 400.

  return out;
}

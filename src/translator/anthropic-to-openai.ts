/**
 * Translate Anthropic message format to OpenAI chat completion format.
 */

export function translateAnthropicToOpenai(payload: any): any {
  const messages: any[] = [];

  // System prompt -> system message
  const system = payload.system;
  if (system) {
    if (typeof system === "string") {
      messages.push({ role: "system", content: system });
    } else if (Array.isArray(system)) {
      const parts: string[] = [];
      for (const block of system) {
        if (block?.type === "text" && !block.text?.startsWith("x-anthropic-billing-header:")) {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) {
        messages.push({ role: "system", content: parts.join("\n\n") });
      }
    }
  }

  // Convert messages
  for (const msg of payload.messages ?? []) {
    if (msg.role === "user") {
      const converted = convertUserMessage(msg);
      messages.push(...converted);
    } else if (msg.role === "assistant") {
      messages.push(convertAssistantMessage(msg));
    }
  }

  const result: any = {
    model: payload.model,
    messages,
    stream: payload.stream ?? false,
  };

  // GPT-5.x rejects `max_tokens` on /chat/completions with a bare 400 and
  // requires `max_completion_tokens`. Gemini accepts either, so this is
  // unconditional rather than per-model.
  if (payload.max_tokens != null) result.max_completion_tokens = payload.max_tokens;
  if (payload.temperature != null) result.temperature = payload.temperature;
  if (payload.top_p != null) result.top_p = payload.top_p;
  if (payload.stop_sequences) result.stop = payload.stop_sequences;

  // Convert tools
  if (payload.tools?.length > 0) {
    result.tools = payload.tools.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? {},
      },
    }));
  }

  // Convert tool_choice
  if (payload.tool_choice) {
    if (payload.tool_choice.type === "any") {
      result.tool_choice = "required";
    } else if (payload.tool_choice.type === "auto") {
      result.tool_choice = "auto";
    } else if (payload.tool_choice.type === "none") {
      result.tool_choice = "none";
    } else if (payload.tool_choice.type === "tool") {
      result.tool_choice = {
        type: "function",
        function: { name: payload.tool_choice.name },
      };
    }
  }

  // Stream options for usage in streaming
  if (result.stream) {
    result.stream_options = { include_usage: true };
  }

  return result;
}

function convertUserMessage(msg: any): any[] {
  const content = msg.content;
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }

  const results: any[] = [];
  const userParts: any[] = [];

  for (const block of content ?? []) {
    if (block.type === "text") {
      userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const source = block.source;
      if (source?.type === "base64") {
        userParts.push({
          type: "image_url",
          image_url: {
            url: `data:${source.media_type};base64,${source.data}`,
          },
        });
      }
    } else if (block.type === "tool_result") {
      // Flush accumulated user parts first
      if (userParts.length > 0) {
        results.push({ role: "user", content: [...userParts] });
        userParts.length = 0;
      }

      let toolContent = "";
      if (typeof block.content === "string") {
        toolContent = block.content;
      } else if (Array.isArray(block.content)) {
        toolContent = block.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }

      results.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: toolContent,
      });
    }
  }

  if (userParts.length > 0) {
    results.push({ role: "user", content: userParts });
  }

  return results;
}

function convertAssistantMessage(msg: any): any {
  const content = msg.content;
  if (typeof content === "string") {
    return { role: "assistant", content };
  }

  let textContent = "";
  const toolCalls: any[] = [];

  for (const block of content ?? []) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "thinking") {
      textContent += block.thinking ?? "";
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const result: any = { role: "assistant" };
  if (textContent) result.content = textContent;
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  if (!textContent && toolCalls.length === 0) result.content = "";

  return result;
}

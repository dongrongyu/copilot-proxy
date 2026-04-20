import { getState } from "../auth/state";

/**
 * Check if the backend response indicates web_search is unsupported.
 */
export function isWebSearchUnsupportedError(
  statusCode: number,
  responseText: string
): boolean {
  if (statusCode !== 400 && statusCode !== 422) return false;
  const lower = responseText.toLowerCase();
  return (
    lower.includes("web search") &&
    (lower.includes("unsupported") || lower.includes("not supported"))
  );
}

/**
 * Check if payload contains any web_search-type tool.
 */
export function hasWebSearchTool(payload: any): boolean {
  for (const tool of payload.tools ?? []) {
    if (typeof tool.type === "string" && tool.type.startsWith("web_search")) {
      return true;
    }
  }
  return false;
}

/**
 * Extract search query from the last user message.
 */
export function extractSearchQuery(payload: any): string {
  for (const msg of [...(payload.messages ?? [])].reverse()) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content.slice(0, 200).trim();
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block?.type === "text") parts.push(block.text ?? "");
      }
      return parts.join(" ").trim().slice(0, 200);
    }
  }
  return "";
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

async function searchWithTavily(
  query: string,
  apiKey: string
): Promise<SearchResult[]> {
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      console.error(`[WebSearch] Tavily error: ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as {
      results?: { title: string; url: string; content: string }[];
    };
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    }));
  } catch (err) {
    console.error(`[WebSearch] Tavily call failed: ${err}`);
    return [];
  }
}

async function searchWithSearxng(
  query: string,
  baseUrl: string
): Promise<SearchResult[]> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=en`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      console.error(`[WebSearch] SearXNG error: ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as {
      results?: { title: string; url: string; content: string }[];
    };
    return (data.results ?? []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    }));
  } catch (err) {
    console.error(`[WebSearch] SearXNG call failed: ${err}`);
    return [];
  }
}

async function doSearch(query: string): Promise<SearchResult[]> {
  const { config } = getState();
  const ws = config.web_search;

  if (ws.provider === "tavily") {
    return searchWithTavily(query, ws.tavily_api_key);
  }
  return searchWithSearxng(query, ws.searxng_url);
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `[Web Search Results]\nNo results found for "${query}".`;
  }
  const lines = [`[Web Search Results]`, `Search results for "${query}":`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. ${r.title}`);
    if (r.url) lines.push(`   URL: ${r.url}`);
    if (r.content) lines.push(`   ${r.content}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Inject search results as simulated tool_use/tool_result messages.
 * This preserves prompt caching (system prompt untouched).
 * Uses the original web_search tool's ID if available.
 */
export function injectSearchResults(payload: any, text: string, query: string): any {
  const toolUseId = findWebSearchToolUseId(payload) ?? `toolu_web_search_${crypto.randomUUID().slice(0, 8)}`;

  const messages = [...(payload.messages ?? [])];

  // Append simulated assistant tool_use + user tool_result at the end
  messages.push({
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: "web_search",
        input: { query },
      },
    ],
  });
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: text,
      },
    ],
  });

  return { ...payload, messages };
}

/**
 * Find an existing web_search tool_use ID from the last assistant message, if any.
 */
function findWebSearchToolUseId(payload: any): string | null {
  for (const msg of [...(payload.messages ?? [])].reverse()) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name === "web_search") {
        return block.id;
      }
    }
    break; // only check last assistant message
  }
  return null;
}

export function removeWebSearchTools(payload: any): any {
  const tools = payload.tools;
  if (!tools) return payload;

  const filtered = tools.filter(
    (t: any) => !(typeof t.type === "string" && t.type.startsWith("web_search"))
  );

  const result = { ...payload };
  if (filtered.length > 0) {
    result.tools = filtered;
  } else {
    delete result.tools;
    delete result.tool_choice;
  }
  return result;
}

export interface WebSearchFallbackResult {
  payload: any;
  query: string;
  results: SearchResult[];
}

/**
 * Apply web search fallback: search, inject results, remove web_search tools.
 * Returns modified payload and search metadata for response synthesis.
 */
export async function applyWebSearchFallback(payload: any): Promise<WebSearchFallbackResult> {
  const query = extractSearchQuery(payload);
  console.log(`[WebSearch] Extracted query: "${query}"`);

  const results = await doSearch(query);
  console.log(`[WebSearch] Got ${results.length} results`);

  const formatted = formatSearchResults(query, results);
  let modified = injectSearchResults(payload, formatted, query);
  modified = removeWebSearchTools(modified);
  return { payload: modified, query, results };
}

/**
 * Build synthetic server_tool_use + web_search_tool_result content blocks
 * to prepend to the response, so clients see search results.
 */
export function buildWebSearchResponseBlocks(query: string, results: SearchResult[]): any[] {
  const toolUseId = `srvtoolu_web_search_${crypto.randomUUID().slice(0, 8)}`;
  const blocks: any[] = [];

  blocks.push({
    type: "server_tool_use",
    id: toolUseId,
    name: "web_search",
    input: { query },
  });

  blocks.push({
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: results.map((r) => ({
      type: "web_search_result",
      url: r.url,
      title: r.title,
      snippet: r.content,
    })),
  });

  return blocks;
}

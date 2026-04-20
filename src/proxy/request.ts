import { getState } from "../auth/state";
import { ensureCopilotToken } from "../auth/copilot-token";

interface RetryOptions {
  maxRetries?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Make a request to the upstream Copilot API with exponential backoff retry.
 * Refreshes token on each retry attempt.
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const state = getState();
  const maxRetries = options?.maxRetries ?? state.config.max_connection_retries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(1200_000), // 20 min timeout
      });
      return resp;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const isRetryable =
        error.name === "TimeoutError" ||
        error.message.includes("ECONNRESET") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("fetch failed");

      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }

      console.log(
        `[Upstream] Connection error (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`
      );
      options?.onRetry?.(attempt, error);

      // Refresh token in case it expired
      await ensureCopilotToken();

      // Exponential backoff: min(2^attempt, 8) seconds
      const delay = Math.min(2 ** attempt, 8) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Should not reach here
  throw new Error("Exhausted retries");
}

/**
 * Check if an error response indicates orphaned tool_result IDs.
 */
export function isOrphanedToolResultError(
  statusCode: number,
  responseText: string
): boolean {
  return statusCode === 400 && responseText.includes("unexpected tool_use_id");
}

/**
 * Extract orphaned tool_use_ids from error message.
 */
export function extractOrphanedToolUseIds(responseText: string): string[] {
  const matches = responseText.match(/toolu_[a-zA-Z0-9_-]+/g);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Remove orphaned tool_result blocks from messages.
 */
export function removeOrphanedToolResults(
  messages: any[],
  orphanedIds: string[]
): any[] {
  const idSet = new Set(orphanedIds);
  return messages.map((msg: any) => {
    if (!Array.isArray(msg.content)) return msg;

    const filtered = msg.content.filter((block: any) => {
      if (block.type === "tool_result" && idSet.has(block.tool_use_id)) {
        console.log(`[Cleanup] Removed orphaned tool_result: ${block.tool_use_id}`);
        return false;
      }
      return true;
    });

    if (filtered.length === 0 && msg.role === "user") return null;
    return { ...msg, content: filtered };
  }).filter(Boolean);
}

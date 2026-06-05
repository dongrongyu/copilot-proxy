/**
 * Per-million-token list prices (USD) for the models exposed through the
 * Copilot proxy. Numbers are the public, list-price figures published by
 * each vendor — they do NOT reflect what GitHub Copilot actually charges
 * (Copilot bills per "premium request", not per token). Use these as a
 * rough "if you ran this directly against the vendor API" cost estimate.
 *
 * Sources (verified Jan 2026 — update when vendor pricing changes):
 *   - Anthropic: https://www.anthropic.com/pricing
 *   - OpenAI:    https://openai.com/api/pricing/
 *   - Gemini:    https://ai.google.dev/gemini-api/docs/pricing
 *
 * Fields:
 *   - input:        $/MTok for fresh (uncached) input tokens
 *   - cached_read:  $/MTok for cache-read input tokens (Anthropic cache hits,
 *                   OpenAI prompt-cache hits, Gemini context cache)
 *   - cache_write:  $/MTok for cache-creation tokens (Anthropic 5m write
 *                   tier; OpenAI/Gemini do not bill separately for writes)
 *   - output:       $/MTok for output tokens (Anthropic rolls thinking
 *                   into output; OpenAI bills reasoning at the output rate)
 */
export interface ModelPrice {
  input: number;
  cached_read: number;
  cache_write: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  // ---- Anthropic ----
  // Opus 4.x list price: $15 in / $75 out, 5m cache write 1.25x, read 0.10x
  "claude-opus-4.5": { input: 15, cached_read: 1.5, cache_write: 18.75, output: 75 },
  "claude-opus-4.6": { input: 15, cached_read: 1.5, cache_write: 18.75, output: 75 },
  "claude-opus-4.7": { input: 15, cached_read: 1.5, cache_write: 18.75, output: 75 },
  "claude-opus-4.8": { input: 15, cached_read: 1.5, cache_write: 18.75, output: 75 },
  // Sonnet 4.x list price: $3 in / $15 out
  "claude-sonnet-4": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-sonnet-4.5": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-sonnet-4.6": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  // Haiku 4.5 list price: $1 in / $5 out
  "claude-haiku-4.5": { input: 1, cached_read: 0.1, cache_write: 1.25, output: 5 },

  // ---- OpenAI ----
  // GPT-5 family: $1.25 in / $10 out, cached input 0.125
  "gpt-5": { input: 1.25, cached_read: 0.125, cache_write: 0, output: 10 },
  "gpt-5-mini": { input: 0.25, cached_read: 0.025, cache_write: 0, output: 2 },
  "gpt-5-nano": { input: 0.05, cached_read: 0.005, cache_write: 0, output: 0.4 },
  // GPT-4.1 family
  "gpt-4.1": { input: 2, cached_read: 0.5, cache_write: 0, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cached_read: 0.1, cache_write: 0, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cached_read: 0.025, cache_write: 0, output: 0.4 },
  // GPT-4o family
  "gpt-4o": { input: 2.5, cached_read: 1.25, cache_write: 0, output: 10 },
  "gpt-4o-mini": { input: 0.15, cached_read: 0.075, cache_write: 0, output: 0.6 },
  // o-series
  "o3": { input: 2, cached_read: 0.5, cache_write: 0, output: 8 },
  "o3-mini": { input: 1.1, cached_read: 0.55, cache_write: 0, output: 4.4 },
  "o4-mini": { input: 1.1, cached_read: 0.275, cache_write: 0, output: 4.4 },

  // ---- Google Gemini ----
  // Gemini 2.5 Pro: $1.25 in / $10 out (<=200K prompt); we use the base tier
  "gemini-2.5-pro": { input: 1.25, cached_read: 0.31, cache_write: 0, output: 10 },
  "gemini-2.5-flash": { input: 0.3, cached_read: 0.075, cache_write: 0, output: 2.5 },
};

const PREFIX_FALLBACKS: Array<[string, string]> = [
  // pinned-effort siblings (e.g. claude-opus-4.7-xhigh) share base price
  ["claude-opus-4.5-", "claude-opus-4.5"],
  ["claude-opus-4.6-", "claude-opus-4.6"],
  ["claude-opus-4.7-", "claude-opus-4.7"],
  ["claude-opus-4.8-", "claude-opus-4.8"],
  ["claude-sonnet-4-", "claude-sonnet-4"],
  ["claude-sonnet-4.5-", "claude-sonnet-4.5"],
  ["claude-sonnet-4.6-", "claude-sonnet-4.6"],
  ["claude-haiku-4.5-", "claude-haiku-4.5"],
  ["gpt-5-", "gpt-5"],
  ["gpt-4.1-", "gpt-4.1"],
  ["gpt-4o-", "gpt-4o"],
  ["gemini-2.5-pro-", "gemini-2.5-pro"],
  ["gemini-2.5-flash-", "gemini-2.5-flash"],
];

export function lookupPrice(model: string): ModelPrice | null {
  const base = normalizeName(model);
  if (PRICES[base]) return PRICES[base]!;
  for (const [prefix, target] of PREFIX_FALLBACKS) {
    if (base.startsWith(prefix) && PRICES[target]) return PRICES[target]!;
  }
  return null;
}

/**
 * Normalize a logged model id to its canonical Copilot form:
 *   - drop trailing `[1m]` marker (Claude-Code-only)
 *   - convert dashed Claude-Code naming `claude-X-4-8` into dotted
 *     Copilot naming `claude-X-4.8` so logs written with either form
 *     resolve to the same price row
 */
function normalizeName(model: string): string {
  let m = model.replace(/\[1m\]$/, "");
  m = m.replace(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)/, "$1-$2.$3");
  return m;
}

export interface TokenUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

export interface CostEstimate {
  cost: number;
  priced: boolean;
}

/**
 * Estimate the USD cost of a token bundle for `model`. Returns `priced=false`
 * (and cost=0) when the model is not in the price table — callers should
 * render `-` and skip the entry when summing totals.
 *
 * Token treatment:
 *   - input_tokens use `input` rate (fresh, uncached input)
 *   - cache_creation_input_tokens use `cache_write` rate
 *   - cache_read_input_tokens use `cached_read` rate
 *   - output_tokens AND reasoning_tokens both use `output` rate
 *     (OpenAI charges reasoning at output; Anthropic rolls it in already
 *     and reports reasoning_tokens=0)
 */
export function estimateCost(model: string, usage: TokenUsage): CostEstimate {
  const price = lookupPrice(model);
  if (!price) return { cost: 0, priced: false };

  const cost =
    (usage.input_tokens / 1_000_000) * price.input +
    (usage.cache_creation_input_tokens / 1_000_000) * price.cache_write +
    (usage.cache_read_input_tokens / 1_000_000) * price.cached_read +
    (usage.output_tokens / 1_000_000) * price.output +
    (usage.reasoning_tokens / 1_000_000) * price.output;

  return { cost, priced: true };
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

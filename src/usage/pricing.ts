/**
 * Per-million-token prices (USD) for the models GitHub Copilot bills under
 * its token-based plan. These numbers come straight from Copilot's official
 * models-and-pricing page — they are *what Copilot actually charges* on the
 * usage-based plan (1 AI Credit = $0.01 USD), not just vendor list price.
 *
 * Source (verified 2026-06):
 *   https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing
 *
 * Fields:
 *   - input:        $/MTok for fresh (uncached) input tokens
 *   - cached_read:  $/MTok for cached input ("Cached input" column)
 *   - cache_write:  $/MTok for cache-creation tokens. Copilot publishes a
 *                   separate "Cache write" column ONLY for Anthropic models;
 *                   for all other vendors this is 0 (the cost is folded into
 *                   the input rate by the provider).
 *   - output:       $/MTok for output tokens. Copilot does not bill thinking
 *                   tokens separately, so for OpenAI/Gemini we still charge
 *                   reasoning_tokens at this rate to stay conservative.
 */
export interface ModelPrice {
  input: number;
  cached_read: number;
  cache_write: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  // ---- Anthropic (only family Copilot bills a separate Cache write for) ----
  "claude-opus-4.5": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-opus-4.6": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-opus-4.7": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-opus-4.8": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-sonnet-4": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-sonnet-4.5": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-sonnet-4.6": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-haiku-4.5": { input: 1, cached_read: 0.1, cache_write: 1.25, output: 5 },

  // ---- OpenAI (Copilot lineup; plain gpt-5/gpt-4.1/gpt-4o/o3 are NOT
  //      billed through Copilot and are intentionally omitted) ----
  "gpt-5-mini": { input: 0.25, cached_read: 0.025, cache_write: 0, output: 2 },
  "gpt-5.2": { input: 1.75, cached_read: 0.175, cache_write: 0, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cached_read: 0.175, cache_write: 0, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cached_read: 0.175, cache_write: 0, output: 14 },
  "gpt-5.4": { input: 2.5, cached_read: 0.25, cache_write: 0, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached_read: 0.075, cache_write: 0, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cached_read: 0.02, cache_write: 0, output: 1.25 },
  "gpt-5.5": { input: 5, cached_read: 0.5, cache_write: 0, output: 30 },

  // ---- Google Gemini ----
  "gemini-2.5-pro": { input: 1.25, cached_read: 0.125, cache_write: 0, output: 10 },
  "gemini-3-flash": { input: 0.5, cached_read: 0.05, cache_write: 0, output: 3 },
  "gemini-3.1-pro": { input: 2, cached_read: 0.2, cache_write: 0, output: 12 },
  "gemini-3.5-flash": { input: 1.5, cached_read: 0.15, cache_write: 0, output: 9 },

  // ---- Microsoft ----
  "mai-code-1-flash": { input: 0.75, cached_read: 0.075, cache_write: 0, output: 4.5 },

  // ---- GitHub fine-tuned ----
  "raptor-mini": { input: 0.25, cached_read: 0.025, cache_write: 0, output: 2 },
};

const PREFIX_FALLBACKS: Array<[string, string]> = [
  // pinned-effort and 1m siblings share base price
  ["claude-opus-4.5-", "claude-opus-4.5"],
  ["claude-opus-4.6-", "claude-opus-4.6"],
  ["claude-opus-4.7-", "claude-opus-4.7"],
  ["claude-opus-4.8-", "claude-opus-4.8"],
  ["claude-sonnet-4-", "claude-sonnet-4"],
  ["claude-sonnet-4.5-", "claude-sonnet-4.5"],
  ["claude-sonnet-4.6-", "claude-sonnet-4.6"],
  ["claude-haiku-4.5-", "claude-haiku-4.5"],
  ["gpt-5.4-mini-", "gpt-5.4-mini"],
  ["gpt-5.4-nano-", "gpt-5.4-nano"],
  ["gpt-5.4-", "gpt-5.4"],
  ["gpt-5.5-", "gpt-5.5"],
  ["gpt-5-mini-", "gpt-5-mini"],
  ["gemini-2.5-pro-", "gemini-2.5-pro"],
  ["gemini-3.1-pro-", "gemini-3.1-pro"],
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

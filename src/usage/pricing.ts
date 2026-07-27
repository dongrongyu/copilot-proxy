/**
 * Per-million-token prices (USD) for the models GitHub Copilot bills under
 * its token-based plan. These numbers come straight from Copilot's official
 * models-and-pricing page — they are *what Copilot actually charges* on the
 * usage-based plan (1 AI Credit = $0.01 USD), not just vendor list price.
 *
 * Source (verified 2026-07-27):
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
export interface TierRates {
  input: number;
  cached_read: number;
  cache_write: number;
  output: number;
}

export interface ModelPrice extends TierRates {
  /**
   * Long-context tier. The OpenAI and Google tables carry two extra columns,
   * `Tier` and `Threshold (input tokens)`, and list such models twice: a
   * "Default" row at or below the threshold and a "Long context" row above it.
   * When present here, a request whose input exceeds `threshold` is billed
   * entirely at these rates instead of the default ones.
   *
   * The Anthropic table has no Tier/Threshold columns at all, so no Claude
   * model carries this field.
   *
   * The docs state the threshold in "input tokens" but never define which
   * categories count. We use every token the provider had to process as
   * input — `input + cache_creation + cache_read` — which is the disjoint sum
   * documented in usage/logger.ts. That is our reading, not a published rule.
   */
  long_context?: TierRates & { threshold: number };
}

const PRICES: Record<string, ModelPrice> = {
  // ---- Anthropic (only family Copilot bills a separate Cache write for;
  //      no Tier/Threshold columns, so never a long_context tier) ----
  "claude-opus-4.5": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-opus-4.6": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-opus-4.7": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-opus-4.8": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-opus-5": { input: 5, cached_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-sonnet-4": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-sonnet-4.5": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-sonnet-4.6": { input: 3, cached_read: 0.3, cache_write: 3.75, output: 15 },
  // PROMOTIONAL until 2026-08-31 (docs footnote 1). After that date these rates
  // lapse and the row needs re-checking against the pricing page.
  "claude-sonnet-5": { input: 2, cached_read: 0.2, cache_write: 2.5, output: 10 },
  "claude-haiku-4.5": { input: 1, cached_read: 0.1, cache_write: 1.25, output: 5 },
  // Priced at 2x the Opus tier. Both rows below are UNVERIFIED model ids: the
  // pricing page lists them by display name only ("Claude Fable 5", "Claude
  // Opus 4.8 (fast mode) (preview)") and neither appears in this account's
  // /models catalog, so the id is inferred from the claude-opus-5 /
  // claude-sonnet-5 naming convention. A wrong key here is inert — it simply
  // never matches. The fast-mode key matters even so: without it the
  // "claude-opus-4.8-" prefix below would silently bill fast mode at half rate.
  "claude-fable-5": { input: 10, cached_read: 1, cache_write: 12.5, output: 50 },
  "claude-opus-4.8-fast": { input: 10, cached_read: 1, cache_write: 12.5, output: 50 },

  // ---- OpenAI (Copilot lineup; plain gpt-5/gpt-4.1/gpt-4o/o3 are NOT
  //      billed through Copilot and are intentionally omitted).
  //      gpt-5.2* are retired from the pricing page but kept so historical
  //      JSONL entries still price. ----
  "gpt-5-mini": { input: 0.25, cached_read: 0.025, cache_write: 0, output: 2 },
  "gpt-5.2": { input: 1.75, cached_read: 0.175, cache_write: 0, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cached_read: 0.175, cache_write: 0, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cached_read: 0.175, cache_write: 0, output: 14 },
  "gpt-5.4": {
    input: 2.5, cached_read: 0.25, cache_write: 0, output: 15,
    long_context: { threshold: 272_000, input: 5, cached_read: 0.5, cache_write: 0, output: 22.5 },
  },
  "gpt-5.4-mini": { input: 0.75, cached_read: 0.075, cache_write: 0, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cached_read: 0.02, cache_write: 0, output: 1.25 },
  "gpt-5.5": {
    input: 5, cached_read: 0.5, cache_write: 0, output: 30,
    long_context: { threshold: 272_000, input: 10, cached_read: 1, cache_write: 0, output: 45 },
  },
  "gpt-5.6-luna": {
    input: 1, cached_read: 0.1, cache_write: 0, output: 6,
    long_context: { threshold: 200_000, input: 2, cached_read: 0.2, cache_write: 0, output: 9 },
  },
  "gpt-5.6-sol": {
    input: 5, cached_read: 0.5, cache_write: 0, output: 30,
    long_context: { threshold: 272_000, input: 10, cached_read: 1, cache_write: 0, output: 45 },
  },
  "gpt-5.6-terra": {
    input: 2.5, cached_read: 0.25, cache_write: 0, output: 15,
    long_context: { threshold: 272_000, input: 5, cached_read: 0.5, cache_write: 0, output: 22.5 },
  },

  // ---- Google Gemini ----
  "gemini-2.5-pro": { input: 1.25, cached_read: 0.125, cache_write: 0, output: 10 },
  "gemini-3-flash": { input: 0.5, cached_read: 0.05, cache_write: 0, output: 3 },
  "gemini-3.1-pro": {
    input: 2, cached_read: 0.2, cache_write: 0, output: 12,
    long_context: { threshold: 200_000, input: 4, cached_read: 0.4, cache_write: 0, output: 18 },
  },
  "gemini-3.5-flash": { input: 1.5, cached_read: 0.15, cache_write: 0, output: 9 },
  "gemini-3.6-flash": { input: 1.5, cached_read: 0.15, cache_write: 0, output: 7.5 },

  // ---- Microsoft ----
  "mai-code-1-flash": { input: 0.75, cached_read: 0.075, cache_write: 0, output: 4.5 },

  // ---- GitHub fine-tuned ----
  "raptor-mini": { input: 0.25, cached_read: 0.025, cache_write: 0, output: 2 },
};

// Ordered; first match wins. Catches pinned-effort, `-preview`, `-picker`,
// `-1m` and dated siblings that share a base model's price.
const PREFIX_FALLBACKS: Array<[string, string]> = [
  // Must precede "claude-opus-4.8-", otherwise fast mode bills at half rate.
  ["claude-opus-4.8-fast", "claude-opus-4.8-fast"],
  ["claude-opus-4.5-", "claude-opus-4.5"],
  ["claude-opus-4.6-", "claude-opus-4.6"],
  ["claude-opus-4.7-", "claude-opus-4.7"],
  ["claude-opus-4.8-", "claude-opus-4.8"],
  ["claude-opus-5-", "claude-opus-5"],
  ["claude-sonnet-4-", "claude-sonnet-4"],
  ["claude-sonnet-4.5-", "claude-sonnet-4.5"],
  ["claude-sonnet-4.6-", "claude-sonnet-4.6"],
  ["claude-sonnet-5-", "claude-sonnet-5"],
  ["claude-haiku-4.5-", "claude-haiku-4.5"],
  ["claude-fable-5-", "claude-fable-5"],
  ["gpt-5.4-mini-", "gpt-5.4-mini"],
  ["gpt-5.4-nano-", "gpt-5.4-nano"],
  ["gpt-5.4-", "gpt-5.4"],
  ["gpt-5.5-", "gpt-5.5"],
  ["gpt-5.6-luna-", "gpt-5.6-luna"],
  ["gpt-5.6-sol-", "gpt-5.6-sol"],
  ["gpt-5.6-terra-", "gpt-5.6-terra"],
  ["gpt-5.3-codex-", "gpt-5.3-codex"],
  ["gpt-5-mini-", "gpt-5-mini"],
  ["gemini-2.5-pro-", "gemini-2.5-pro"],
  ["gemini-3-flash-", "gemini-3-flash"],
  ["gemini-3.1-pro-", "gemini-3.1-pro"],
  ["gemini-3.5-flash-", "gemini-3.5-flash"],
  ["gemini-3.6-flash-", "gemini-3.6-flash"],
  ["mai-code-1-flash-", "mai-code-1-flash"],
  ["raptor-mini-", "raptor-mini"],
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
 *
 * The lookahead keeps single-component names intact: without it
 * `claude-opus-5-1m` would read `5-1` as a major.minor pair and normalize to
 * `claude-opus-5.1m`, which matches nothing. Requiring the pair to be followed
 * by end-of-string or `-` leaves `claude-opus-5-1m` alone (so the
 * `claude-opus-5-` prefix catches it) while `claude-opus-4-8-1m` still folds
 * to `claude-opus-4.8-1m`.
 */
function normalizeName(model: string): string {
  let m = model.replace(/\[1m\]$/, "");
  m = m.replace(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)(?=$|-)/, "$1-$2.$3");
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
 * ⚠️ Call this with ONE request's tokens, never with a summed bundle. Models
 * carrying a `long_context` tier are priced off the total input size, so a
 * month's worth of small requests added together would cross the threshold and
 * bill the whole lot at long-context rates. Aggregate the returned cost, not
 * the tokens (see readMonthlyUsage in usage/logger.ts).
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

  // Every token the provider had to process as input. The three categories are
  // disjoint by the logger's contract, so this is a plain sum.
  const totalInput =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const rates: TierRates =
    price.long_context && totalInput > price.long_context.threshold
      ? price.long_context
      : price;

  const cost =
    (usage.input_tokens / 1_000_000) * rates.input +
    (usage.cache_creation_input_tokens / 1_000_000) * rates.cache_write +
    (usage.cache_read_input_tokens / 1_000_000) * rates.cached_read +
    (usage.output_tokens / 1_000_000) * rates.output +
    (usage.reasoning_tokens / 1_000_000) * rates.output;

  return { cost, priced: true };
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

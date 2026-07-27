import { readMonthlyUsage } from "../usage/logger";
import { lookupPrice, formatUsd } from "../usage/pricing";

export async function usageCommand(opts: { month?: string }) {
  const month = opts.month ?? new Date().toISOString().slice(0, 7);
  const usage = readMonthlyUsage(month);

  if (!usage) {
    console.log(`No usage data for ${month}`);
    return;
  }

  const fmt = (n: number) => n.toLocaleString();
  const fmtTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  };

  console.log(`\nMonth: ${usage.month}`);
  console.log(`Total Requests: ${fmt(usage.total_requests)}`);
  const t = usage.totals;
  console.log(`Input:          ${fmt(t.input_tokens)}`);
  console.log(`Cache creation: ${fmt(t.cache_creation_input_tokens)}`);
  console.log(`Cache read:     ${fmt(t.cache_read_input_tokens)}`);
  console.log(`Output:         ${fmt(t.output_tokens)}`);
  console.log(`Reasoning:      ${fmt(t.reasoning_tokens)}`);

  const models = Object.entries(usage.by_model);
  let totalCost = 0;
  let pricedModels = 0;
  let unpricedModels = 0;

  if (models.length > 0) {
    console.log(`\nBy Model:`);
    console.log(
      `  ${"".padEnd(28)}   reqs |    in |    cc |    cr |   out |     r |     cost`
    );
    for (const [name, m] of models.sort((a, b) => b[1].requests - a[1].requests)) {
      // m.cost is already the sum of per-request estimates; re-pricing the
      // aggregated tokens here would mis-tier long-context models.
      const priced = lookupPrice(name) !== null;
      const costCell = priced ? formatUsd(m.cost) : "-";
      if (priced) {
        totalCost += m.cost;
        pricedModels++;
      } else {
        unpricedModels++;
      }
      console.log(
        `  ${name.padEnd(28)} ${String(m.requests).padStart(6)} | ` +
          `${fmtTokens(m.input_tokens).padStart(5)} | ` +
          `${fmtTokens(m.cache_creation_input_tokens).padStart(5)} | ` +
          `${fmtTokens(m.cache_read_input_tokens).padStart(5)} | ` +
          `${fmtTokens(m.output_tokens).padStart(5)} | ` +
          `${fmtTokens(m.reasoning_tokens).padStart(5)} | ` +
          `${costCell.padStart(8)}`
      );
    }
  }

  const days = Object.entries(usage.by_day);
  if (days.length > 0) {
    console.log(`\nBy Day:`);
    console.log(
      `  ${"".padEnd(5)}  reqs |    in |    cc |    cr |   out |     r |     cost`
    );
    for (const [day, d] of days.sort()) {
      const shortDay = day.slice(5); // MM-DD
      const costCell = d.cost > 0 ? formatUsd(d.cost) : "-";
      console.log(
        `  ${shortDay} ${String(d.requests).padStart(5)} | ` +
          `${fmtTokens(d.input_tokens).padStart(5)} | ` +
          `${fmtTokens(d.cache_creation_input_tokens).padStart(5)} | ` +
          `${fmtTokens(d.cache_read_input_tokens).padStart(5)} | ` +
          `${fmtTokens(d.output_tokens).padStart(5)} | ` +
          `${fmtTokens(d.reasoning_tokens).padStart(5)} | ` +
          `${costCell.padStart(8)}`
      );
    }
  }

  if (pricedModels > 0) {
    console.log(
      `\nTotal Cost: ${formatUsd(totalCost)} (GitHub Copilot token-based rate; ` +
        `${pricedModels} model(s) priced` +
        (unpricedModels > 0 ? `, ${unpricedModels} unpriced` : "") +
        `)`,
    );
  }

  console.log("");
}

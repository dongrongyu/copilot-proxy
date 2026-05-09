import { readMonthlyUsage } from "../usage/logger";

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
  if (models.length > 0) {
    console.log(`\nBy Model:`);
    console.log(
      `  ${"".padEnd(28)}   reqs |    in |    cc |    cr |   out |     r`
    );
    for (const [name, m] of models.sort((a, b) => b[1].requests - a[1].requests)) {
      console.log(
        `  ${name.padEnd(28)} ${String(m.requests).padStart(6)} | ` +
          `${fmtTokens(m.input_tokens).padStart(5)} | ` +
          `${fmtTokens(m.cache_creation_input_tokens).padStart(5)} | ` +
          `${fmtTokens(m.cache_read_input_tokens).padStart(5)} | ` +
          `${fmtTokens(m.output_tokens).padStart(5)} | ` +
          `${fmtTokens(m.reasoning_tokens).padStart(5)}`
      );
    }
  }

  const days = Object.entries(usage.by_day);
  if (days.length > 0) {
    console.log(`\nBy Day:`);
    console.log(
      `  ${"".padEnd(5)}  reqs |    in |    cc |    cr |   out |     r`
    );
    for (const [day, d] of days.sort()) {
      const shortDay = day.slice(5); // MM-DD
      console.log(
        `  ${shortDay} ${String(d.requests).padStart(5)} | ` +
          `${fmtTokens(d.input_tokens).padStart(5)} | ` +
          `${fmtTokens(d.cache_creation_input_tokens).padStart(5)} | ` +
          `${fmtTokens(d.cache_read_input_tokens).padStart(5)} | ` +
          `${fmtTokens(d.output_tokens).padStart(5)} | ` +
          `${fmtTokens(d.reasoning_tokens).padStart(5)}`
      );
    }
  }

  console.log("");
}

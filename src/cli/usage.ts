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
  console.log(`Input tokens:   ${fmt(usage.total_input_tokens)}`);
  console.log(`Output tokens:  ${fmt(usage.total_output_tokens)}`);
  console.log(`Cache creation: ${fmt(usage.total_cache_creation_tokens)}`);
  console.log(`Cache read:     ${fmt(usage.total_cache_read_tokens)}`);

  const models = Object.entries(usage.by_model);
  if (models.length > 0) {
    console.log(`\nBy Model:`);
    for (const [name, m] of models.sort((a, b) => b[1].requests - a[1].requests)) {
      console.log(`  ${name.padEnd(28)} ${String(m.requests).padStart(6)} reqs | ${fmtTokens(m.input_tokens)} in | ${fmtTokens(m.output_tokens)} out`);
    }
  }

  const days = Object.entries(usage.by_day);
  if (days.length > 0) {
    console.log(`\nBy Day:`);
    for (const [day, d] of days.sort()) {
      const shortDay = day.slice(5); // MM-DD
      console.log(`  ${shortDay}:  ${String(d.requests).padStart(4)} reqs | ${fmtTokens(d.input_tokens)} in | ${fmtTokens(d.output_tokens)} out`);
    }
  }

  console.log("");
}

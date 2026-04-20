import { readRequestLogs, listLogDates } from "../usage/logger";

export async function logsCommand(opts: {
  limit?: string;
  errors?: boolean;
  model?: string;
  date?: string;
}) {
  const limit = parseInt(opts.limit ?? "20", 10);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  let entries = readRequestLogs(date);

  if (opts.errors) {
    entries = entries.filter((e) => e.status_code >= 400 || e.error);
  }

  if (opts.model) {
    const filter = opts.model.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.model.toLowerCase().includes(filter) ||
        (e.translated_model ?? "").toLowerCase().includes(filter)
    );
  }

  // Take last N entries
  const shown = entries.slice(-limit);

  if (shown.length === 0) {
    console.log(`No logs found for ${date}`);
    if (!opts.date) {
      const dates = listLogDates();
      if (dates.length > 0) {
        console.log(`Available dates: ${dates.slice(-5).join(", ")}`);
      }
    }
    return;
  }

  console.log(`\nRequest logs for ${date} (showing ${shown.length}/${entries.length}):\n`);

  for (const e of shown) {
    const time = e.timestamp.slice(11, 19); // HH:MM:SS
    const model = e.translated_model ?? e.model;
    const shortModel = model.length > 22 ? model.slice(0, 22) : model;

    if (e.error) {
      console.log(
        `[${time}] ${String(e.status_code).padEnd(3)}  ${shortModel.padEnd(24)} ${e.endpoint.padEnd(20)} ERROR: ${e.error.slice(0, 60)}`
      );
    } else {
      const inK = e.input_tokens >= 1000
        ? `${(e.input_tokens / 1000).toFixed(1)}K`
        : String(e.input_tokens);
      const outK = e.output_tokens >= 1000
        ? `${(e.output_tokens / 1000).toFixed(1)}K`
        : String(e.output_tokens);
      const dur = (e.duration_ms / 1000).toFixed(1);
      console.log(
        `[${time}] ${String(e.status_code).padEnd(3)}  ${shortModel.padEnd(24)} ${e.endpoint.padEnd(20)} ${inK.padStart(6)} in ${outK.padStart(6)} out  ${dur}s`
      );
    }
  }

  console.log("");
}

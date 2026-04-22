import { Hono } from "hono";
import { anthropicRouter } from "./routes/anthropic";
import { openaiRouter } from "./routes/openai";
import { modelsRouter } from "./routes/models";
import { geminiRouter } from "./routes/gemini";

export function createApp(): Hono {
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Mount routes
  app.route("/", anthropicRouter);
  app.route("/", openaiRouter);
  app.route("/", geminiRouter);
  app.route("/", modelsRouter);

  return app;
}

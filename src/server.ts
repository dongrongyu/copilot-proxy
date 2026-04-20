import { Hono } from "hono";
import { anthropicRouter } from "./routes/anthropic";
import { openaiRouter } from "./routes/openai";
import { modelsRouter } from "./routes/models";

export function createApp(): Hono {
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Mount routes
  app.route("/", anthropicRouter);
  app.route("/", openaiRouter);
  app.route("/", modelsRouter);

  return app;
}

import { Hono } from "hono";
import { anthropicRouter } from "./routes/anthropic";
import { openaiRouter } from "./routes/openai";
import { modelsRouter } from "./routes/models";
import { geminiRouter } from "./routes/gemini";
import { portalRouter } from "./portal/routes";

export function createApp(): Hono {
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Mount proxy routes
  app.route("/", anthropicRouter);
  app.route("/", openaiRouter);
  app.route("/", geminiRouter);
  app.route("/", modelsRouter);

  // Config portal (GET / + /api/portal/*). Mounted last so it can never
  // shadow /health or the proxy routes above.
  app.route("/", portalRouter);

  return app;
}

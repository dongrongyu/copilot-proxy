import { Hono } from "hono";
import { PORTAL_HTML } from "./page";
import {
  dashboardData,
  modelsData,
  usageData,
  logsData,
  webSearchData,
  applyWebSearch,
  testWebSearch,
  effortData,
  applyEffort,
  modelMappingsData,
  applyModelMappings,
  configFileData,
  applyConfigFile,
  setupPreview,
  applySetup,
  type SetupTarget,
} from "./api";

/**
 * Config Portal: a browser UI served from the SAME Hono app / port as the proxy
 * API. `GET /` returns the single-page app; `/api/portal/*` are its JSON
 * data/action endpoints. All paths here are unclaimed by the proxy routers
 * (which live under /v1, /v1beta, /chat, /models, /health).
 */
const portalRouter = new Hono();

portalRouter.get("/", (c) => c.html(PORTAL_HTML));

portalRouter.get("/api/portal/dashboard", (c) => c.json(dashboardData()));
portalRouter.get("/api/portal/models", (c) => c.json(modelsData()));

portalRouter.get("/api/portal/usage", (c) => {
  const month = c.req.query("month") || new Date().toISOString().slice(0, 7);
  return c.json(usageData(month));
});

portalRouter.get("/api/portal/logs", (c) => {
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  return c.json(logsData(date));
});

portalRouter.get("/api/portal/web-search", (c) => c.json(webSearchData()));

portalRouter.post("/api/portal/web-search", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = applyWebSearch(body);
  return c.json(result, result.ok ? 200 : 400);
});

portalRouter.post("/api/portal/web-search/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await testWebSearch(body.query ?? "", body.provider, body.key);
  return c.json(result, result.ok ? 200 : 400);
});

portalRouter.get("/api/portal/effort", (c) => c.json(effortData()));

portalRouter.post("/api/portal/effort", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = applyEffort(body);
  return c.json(result, result.ok ? 200 : 400);
});

portalRouter.get("/api/portal/model-mappings", (c) => c.json(modelMappingsData()));

portalRouter.post("/api/portal/model-mappings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = applyModelMappings(body);
  return c.json(result, result.ok ? 200 : 400);
});

portalRouter.get("/api/portal/config-file", (c) => c.json(configFileData()));

portalRouter.post("/api/portal/config-file", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = applyConfigFile(body);
  return c.json(result, result.ok ? 200 : 400);
});

portalRouter.get("/api/portal/setup", (c) => {
  const target = (c.req.query("target") || "claude") as SetupTarget;
  const opts = {
    model: c.req.query("model") || undefined,
    codexMode: c.req.query("codexMode") || undefined,
    aoaiBaseUrl: c.req.query("aoaiBaseUrl") || undefined,
    aoaiModel: c.req.query("aoaiModel") || undefined,
    aoaiEnvKey: c.req.query("aoaiEnvKey") || undefined,
  };
  return c.json(setupPreview(target, opts));
});

portalRouter.post("/api/portal/setup", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const target = (body.target || "claude") as SetupTarget;
  const result = applySetup(target, body);
  return c.json(result, result.ok ? 200 : 400);
});

export { portalRouter };

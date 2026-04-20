/**
 * Model listing route: /v1/models, /models
 */
import { Hono } from "hono";
import { getState } from "../auth/state";

const modelsRouter = new Hono();

for (const path of ["/v1/models", "/models"]) {
  modelsRouter.get(path, (c) => {
    const state = getState();
    if (state.models) {
      return c.json(state.models);
    }
    return c.json({ data: [] });
  });
}

export { modelsRouter };

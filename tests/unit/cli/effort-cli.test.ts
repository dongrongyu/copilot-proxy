import { describe, expect, test, beforeAll, afterAll, beforeEach, spyOn, mock } from "bun:test";
import { serve, type Server } from "bun";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import * as realLoader from "../../../src/config/loader";

// fetchLiveEffort/pushLiveEffort derive the proxy URL from loadConfig().address
// /port and call /api/portal/effort. We stub loadConfig so the helpers point at
// a throwaway local server (never the real proxy or real config file). We use
// spyOn (NOT mock.module) so the stub reverts cleanly in afterAll — mock.module
// is process-global and unrestorable, which previously leaked stubs across files.
let testPort = 0;
let lastPosted: string | null = null;
let postShouldFail = false;

spyOn(realLoader, "loadConfig").mockImplementation(
  () => ({ ...DEFAULT_CONFIG, address: "127.0.0.1", port: testPort }) as ReturnType<typeof realLoader.loadConfig>,
);

const { fetchLiveEffort, pushLiveEffort } = await import("../../../src/cli/effort");

describe("cli effort live-API helpers", () => {
  let server: Server;
  let liveEffort = "high";

  beforeAll(() => {
    server = serve({
      port: 0, // ephemeral
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/api/portal/effort") {
          return new Response("not found", { status: 404 });
        }
        if (req.method === "GET") {
          return Response.json({ effort: liveEffort, options: ["low", "medium", "high", "xhigh", "max"] });
        }
        if (req.method === "POST") {
          if (postShouldFail) return new Response(JSON.stringify({ ok: false, error: "bad" }), { status: 400 });
          const body = (await req.json()) as { effort?: string };
          lastPosted = body.effort ?? null;
          liveEffort = body.effort ?? liveEffort;
          return Response.json({ ok: true, state: { effort: liveEffort, options: [] } });
        }
        return new Response("method", { status: 405 });
      },
    });
    testPort = server.port;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    liveEffort = "high";
    lastPosted = null;
    postShouldFail = false;
  });

  test("fetchLiveEffort returns the running proxy's value", async () => {
    liveEffort = "xhigh";
    expect(await fetchLiveEffort()).toBe("xhigh");
  });

  test("pushLiveEffort POSTs the value and the server records it", async () => {
    const ok = await pushLiveEffort("max");
    expect(ok).toBe(true);
    expect(lastPosted).toBe("max");
    // The mock proxy now reports the new value, proving the round-trip.
    expect(await fetchLiveEffort()).toBe("max");
  });

  test("pushLiveEffort returns false when the server rejects (non-2xx)", async () => {
    postShouldFail = true;
    expect(await pushLiveEffort("max")).toBe(false);
  });
});

describe("cli effort fallback when proxy is unreachable", () => {
  // Point the helpers at a port nothing is listening on → connection refused.
  beforeEach(() => {
    testPort = 1; // privileged/unused; fetch will fail fast
  });

  test("fetchLiveEffort returns null when nothing is listening", async () => {
    expect(await fetchLiveEffort()).toBeNull();
  });

  test("pushLiveEffort returns false when nothing is listening", async () => {
    expect(await pushLiveEffort("high")).toBe(false);
  });
});

// Revert the loadConfig spy only after every describe in this file has run, so
// the stub stays active for the fallback suite too.
afterAll(() => mock.restore());

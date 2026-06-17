import { describe, expect, test, beforeEach, mock } from "bun:test";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import * as realLoader from "../../../src/config/loader";

// applyEffort/effortData touch the real ~/.copilot-proxy/config.yaml through
// loadConfig/updateEffortConfig (resolved via os.homedir(), which bun caches at
// process start so a runtime HOME override does NOT redirect it). To exercise
// the orchestration logic WITHOUT touching the user's real config, we keep every
// real loader export EXCEPT the two that read/write disk, which we replace with
// an in-memory store.
let diskEffort = "high";
mock.module("../../../src/config/loader", () => ({
  ...realLoader,
  loadConfig: () => ({ ...DEFAULT_CONFIG, effort: diskEffort }),
  updateEffortConfig: (value: string) => {
    diskEffort = value;
    return "/tmp/fake-config.yaml";
  },
}));

const { effortData, applyEffort } = await import("../../../src/portal/api");

describe("portal effort api", () => {
  beforeEach(() => {
    diskEffort = "high";
    initState({ ...DEFAULT_CONFIG });
  });

  test("effortData exposes the on-disk value and the full option list", () => {
    const d = effortData();
    expect(d.effort).toBe("high");
    expect(d.options).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("applyEffort with a valid value persists to disk AND hot-updates memory", () => {
    const res = applyEffort({ effort: "max" });
    expect(res.ok).toBe(true);
    expect(res.state?.effort).toBe("max");
    // In-memory config (what the running proxy actually reads) is updated...
    expect(getState().config.effort).toBe("max");
    // ...and the change is persisted (our stub records the write).
    expect(diskEffort).toBe("max");
  });

  test("applyEffort lowercases the incoming value", () => {
    const res = applyEffort({ effort: "XHigh" });
    expect(res.ok).toBe(true);
    expect(res.state?.effort).toBe("xhigh");
    expect(getState().config.effort).toBe("xhigh");
  });

  test("applyEffort rejects an invalid value without touching disk or memory", () => {
    getState().config.effort = "high";
    const res = applyEffort({ effort: "ultra" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid effort");
    expect(getState().config.effort).toBe("high");
    expect(diskEffort).toBe("high");
  });

  test("applyEffort rejects a missing value", () => {
    const res = applyEffort({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid effort");
    expect(diskEffort).toBe("high");
  });

  test("applyEffort preserves other in-memory config fields (no whole-object replace)", () => {
    getState().config.port = 9999;
    getState().config.address = "0.0.0.0";
    applyEffort({ effort: "low" });
    // Only effort changed; runtime overrides like -p/-H survive.
    expect(getState().config.effort).toBe("low");
    expect(getState().config.port).toBe(9999);
    expect(getState().config.address).toBe("0.0.0.0");
  });
});

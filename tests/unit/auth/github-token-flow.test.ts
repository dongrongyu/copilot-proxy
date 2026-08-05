import { describe, expect, test, afterEach } from "bun:test";
import { initState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { loginWithDeviceFlow } from "../../../src/auth/github-token";

describe("GitHub Token - Device Flow", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("loginWithDeviceFlow succeeds on immediate approval", async () => {
    let callNum = 0;
    globalThis.fetch = (async (url: string) => {
      callNum++;
      if (callNum === 1) {
        // Device code request
        return {
          ok: true,
          json: async () => ({
            device_code: "dc_test",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 0,
            expires_in: 60,
          }),
        };
      }
      // Token poll - immediate success
      return {
        ok: true,
        json: async () => ({ access_token: "gho_test_token_123" }),
      };
    }) as any;

    const token = await loginWithDeviceFlow();
    expect(token).toBe("gho_test_token_123");
  });

  test("GHE Device Flow uses the configured tenant for both requests", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/login/device/code")) {
        return {
          ok: true,
          json: async () => ({
            device_code: "dc_ghe",
            user_code: "MSFT-CODE",
            verification_uri: "https://msft.ghe.com/login/device",
            interval: 0,
            expires_in: 60,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ access_token: "ghe_token" }),
      };
    }) as any;

    const token = await loginWithDeviceFlow("https://api.msft.ghe.com");
    expect(token).toBe("ghe_token");
    expect(urls).toEqual([
      "https://msft.ghe.com/login/device/code",
      "https://msft.ghe.com/login/oauth/access_token",
    ]);
  });

  test("loginWithDeviceFlow handles authorization_pending", async () => {
    let pollCount = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("device/code")) {
        return {
          ok: true,
          json: async () => ({
            device_code: "dc_test", user_code: "CODE",
            verification_uri: "https://github.com/login/device",
            interval: 0, expires_in: 60,
          }),
        };
      }
      pollCount++;
      if (pollCount < 3) {
        return { ok: true, json: async () => ({ error: "authorization_pending" }) };
      }
      return { ok: true, json: async () => ({ access_token: "gho_delayed" }) };
    }) as any;

    const token = await loginWithDeviceFlow();
    expect(token).toBe("gho_delayed");
    expect(pollCount).toBe(3);
  });

  test("loginWithDeviceFlow handles slow_down", async () => {
    let pollCount = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("device/code")) {
        return {
          ok: true,
          json: async () => ({
            device_code: "dc", user_code: "C",
            verification_uri: "https://github.com/login/device",
            interval: 0, expires_in: 60,
          }),
        };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ({ error: "slow_down" }) };
      }
      return { ok: true, json: async () => ({ access_token: "gho_slow" }) };
    }) as any;

    const token = await loginWithDeviceFlow();
    expect(token).toBe("gho_slow");
  });

  test("loginWithDeviceFlow throws on expired_token", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("device/code")) {
        return {
          ok: true,
          json: async () => ({
            device_code: "dc", user_code: "C",
            verification_uri: "https://github.com/login/device",
            interval: 0, expires_in: 60,
          }),
        };
      }
      return { ok: true, json: async () => ({ error: "expired_token" }) };
    }) as any;

    await expect(loginWithDeviceFlow()).rejects.toThrow("expired");
  });

  test("loginWithDeviceFlow throws on device code failure", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as any;
    await expect(loginWithDeviceFlow()).rejects.toThrow("Device code request failed");
  });

  test("loginWithDeviceFlow throws on unknown OAuth error", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("device/code")) {
        return {
          ok: true,
          json: async () => ({
            device_code: "dc", user_code: "C",
            verification_uri: "https://github.com/login/device",
            interval: 0, expires_in: 60,
          }),
        };
      }
      return { ok: true, json: async () => ({ error: "access_denied" }) };
    }) as any;

    await expect(loginWithDeviceFlow()).rejects.toThrow("OAuth error: access_denied");
  });
});

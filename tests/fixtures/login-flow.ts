import { loginCommand } from "../../src/cli/login";
import { MSFT_GHE_ENDPOINT } from "../../src/auth/github-endpoints";

type LoginMode = "public" | "ghe" | "ghe-fail";

const mode = process.argv[2] as LoginMode | undefined;
if (mode !== "public" && mode !== "ghe" && mode !== "ghe-fail") {
  throw new Error("Expected login fixture mode: public | ghe | ghe-fail");
}

const requestedUrls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  requestedUrls.push(url);

  if (mode === "ghe-fail") {
    return new Response("", { status: 500 });
  }

  if (url.endsWith("/login/device/code")) {
    return Response.json({
      device_code: "fixture-device-code",
      user_code: "TEST-CODE",
      verification_uri: url.replace(/\/code$/, ""),
      interval: 0,
      expires_in: 60,
    });
  }

  return Response.json({ access_token: "fixture-token" });
}) as typeof fetch;

await loginCommand(
  mode === "public" ? {} : { gheEndpoint: MSFT_GHE_ENDPOINT },
);
console.log(`REQUESTED_URLS=${JSON.stringify(requestedUrls)}`);

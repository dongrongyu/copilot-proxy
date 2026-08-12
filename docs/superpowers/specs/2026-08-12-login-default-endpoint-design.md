# Login Default Endpoint Design

## Context

Version `0.1.31` added Microsoft GHE Device Flow support. The explicit GHE login path persists its API endpoints in `config.yaml`, and the current plain `login` path subsequently reads that persisted endpoint. As a result, `copilot-proxy login` can unexpectedly continue using `https://msft.ghe.com` after an earlier GHE login.

The command itself must be authoritative: no flag means public GitHub, while `--msft-ghe-endpoint` means Microsoft's GHE tenant.

## Required Behavior

- `copilot-proxy login` always starts Device Flow on `https://github.com`, regardless of previously persisted endpoint values.
- `copilot-proxy login --msft-ghe-endpoint` starts Device Flow on `https://msft.ghe.com`.
- Endpoint configuration is not changed before Device Flow succeeds.
- After successful public GitHub authentication, write these explicit values to `config.yaml`:

  ```yaml
  github_api_base_url: "https://api.github.com"
  copilot_api_base_url: "https://api.githubcopilot.com"
  ```

- After successful MSFT GHE authentication, write these values to `config.yaml`:

  ```yaml
  github_api_base_url: "https://api.msft.ghe.com"
  copilot_api_base_url: "https://copilot-api.msft.ghe.com"
  ```

- If Device Flow fails, leave the existing endpoint configuration unchanged.
- Preserve the existing token location, CLI flag, standalone endpoint-configuration behavior, comments, and line-ending handling.

## Design

`src/index.ts` continues translating `--msft-ghe-endpoint` into the existing optional `gheEndpoint` login option.

`src/cli/login.ts` resolves the endpoint set from the current command rather than loading the saved GitHub API endpoint:

- Without `gheEndpoint`, use the public GitHub and Copilot endpoint constants.
- With `gheEndpoint`, use `resolveGheEndpoints` to derive the tenant's web, REST, and Copilot origins.

The resolved GitHub API origin is passed directly to `loginWithDeviceFlow`. After that function returns a token, the command writes the token and persists the resolved REST and Copilot API origins through the existing configuration updater. The success message is emitted only after these post-authentication writes complete.

This keeps endpoint selection explicit, makes authentication independent of stale configuration, and aligns subsequent proxy traffic with the account used for the latest successful login.

## Error Handling

- Endpoint validation errors follow the existing login failure path.
- OAuth or Device Flow failure occurs before any endpoint mutation, so the previous endpoint configuration is preserved.
- Existing filesystem/configuration write failures remain visible through the current `Login failed` error path.
- No new fallback silently reuses a persisted endpoint.

## Testing

Add CLI login orchestration tests using an isolated temporary `HOME` and mocked network requests:

1. Seed GHE endpoints, run plain login, assert both OAuth requests use `github.com`, and assert public endpoints are persisted after success.
2. Run login with `gheEndpoint`, assert both OAuth requests use `msft.ghe.com`, and assert the MSFT GHE endpoints are persisted after success.
3. Seed an existing endpoint configuration, make Device Flow fail, and assert the configuration remains unchanged.

Then run the targeted login/auth tests, the complete unit suite, type checking, and the production build. All tests must avoid the live user configuration and service.

## Alternatives Considered

- Override only the OAuth URL for plain login: rejected because the new public token could be used against still-persisted GHE APIs.
- Update configuration before Device Flow: rejected because a failed login would replace a previously working endpoint selection.
- Infer the endpoint from the saved token: rejected because the token file does not provide a reliable, durable upstream selection for future service processes.

## Out of Scope

- Adding more endpoint flags or arbitrary GHE tenant CLI options.
- Changing the config schema or the token storage format.
- Changing service installation or restart behavior.


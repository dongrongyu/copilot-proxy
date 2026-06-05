---
description: Publish @ascdong/copilot-proxy to npm
allowed-tools: Bash, Read
---

You are publishing the current version of `@ascdong/copilot-proxy` to npm.

## Steps

1. **Show what will be published**
   - Read `package.json` and print the `name` + `version`.
   - Confirm with the user before running `npm publish`.

2. **Publish**
   - Run `npm publish`. The `prepublishOnly` hook runs `typecheck` + `test:unit` + `build` automatically.
   - On success, print the install command:
     ```
     npm i -g @ascdong/copilot-proxy@<version>
     ```

## Guardrails

- Do NOT bump the version, edit files, commit, or push — this command only publishes whatever is already in `package.json`.
- Do NOT use `--no-verify` or any flag that skips hooks.
- If `prepublishOnly` fails, report the failure and stop — do not retry against a broken state.
- If npm rejects with "version already exists", report it and stop — the user needs to bump first.
- Do not ask for feedback or rating after publishing.

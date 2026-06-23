---
description: Bump patch version (in its own commit), publish to npm, and push
allowed-tools: Bash, Read, Edit
---

You are bumping the patch version of `@ascdong/copilot-proxy`, committing
the bump as a release commit, publishing to npm, and pushing everything
to origin.

## Steps

1. **Show current state and handle any pending changes**
   - Run `git status` and `git diff` to see what's pending.
   - Read `package.json` and print current `name` + `version`.
   - Compute the next patch version (X.Y.Z -> X.Y.(Z+1)).
   - If there are uncommitted changes:
     - Summarize them for the user.
     - Ask the user to confirm a commit message (or accept your suggestion).
     - Commit those pending changes FIRST as a separate commit. Use the
       repository's existing commit-message style (terse, lowercase first
       word, no trailing period).
   - If there are no pending changes, skip the pre-commit.
   - Then confirm the version bump (current -> new) with the user.

2. **Bump the version (release commit — its own commit)**
   - Edit `package.json` to update the `version` field. This is the SINGLE
     source of truth. At build time the `build` script passes it to
     `bun build --define __APP_VERSION__="$npm_package_version"`, which
     inlines it as a compile-time literal that `src/version.ts` exposes as
     `VERSION` (the CLI and config portal both read that). Runtime code
     never imports `package.json`, so no source file hardcodes the version.
   - Sanity-check there are no stray hardcoded copies with:
     `grep -rn "<old-version>" src/` — it should return nothing.
   - Do NOT use `npm version` — it auto-creates its own commit/tag and
     uses a non-standard message.
   - Stage ONLY the version-bump files (`package.json` + any updated
     source file) and commit with a message of the form:
       `<new-version>: release` — match the style of past release commits
       like `0.1.10: rework usage logging`. If the changes being released
       are best captured by a more descriptive summary, use that instead
       (e.g. `0.1.12: bump pricing table to GitHub Copilot rates`).
   - The version bump must live in its own commit, separate from any
     feature/fix commits.

3. **Publish**
   - Run `npm publish`. The `prepublishOnly` hook runs `typecheck` +
     `test:unit` + `build` automatically.
   - On success, print the install command:
     ```
     npm i -g @ascdong/copilot-proxy@<new-version>
     ```

4. **Push**
   - After a successful publish, run `git push` to push all new local
     commits to origin (the current branch only; do NOT push tags or
     use `--force`).
   - Print the final summary: the new version is live on npm and pushed
     to origin.

## Guardrails

- Only bump the patch segment. Never bump minor or major unless the user
  explicitly asks.
- Do NOT create git tags.
- Do NOT use `npm version` (auto-commits with a non-standard message).
- Do NOT use `--no-verify`, `--force`, or any flag that skips hooks or
  rewrites remote history.
- If `prepublishOnly` fails, report the failure and stop. The release
  commit is already made locally but nothing was published or pushed —
  the user can amend or revert it after fixing.
- If npm rejects with "version already exists", report it and stop. Do
  not push in that case — the release commit is wrong and needs amending.
- Only push if publish succeeded. Never push first.
- Do not ask for feedback or rating after publishing.


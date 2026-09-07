# Core source publication validation — 2026-09-07

This source snapshot preserves the pending changes in the
`agenc-core-meta-provider` worktree, based on `ba45da9`. It is published on
`publish/core-pending-2026-09-07`, not merged into `main` or released.

## Scope

- Daemon-managed browser Connections, private Telegram agents, and routines,
  including their protocol and SDK contracts.
- Explicit provider authentication selection, model/reasoning capabilities,
  and client-aware system prompts.
- MCP authentication/management, plugin network authority and publisher-key
  rollover, with associated documentation and regression tests.

The interdependent changes are retained as one source snapshot. A test-only
portability correction uses a canonical disposable home path instead of
assuming `/home/user` has identical filesystem spelling on macOS and Linux.

## Checks performed

- Runtime source: `node node_modules/typescript/bin/tsc --noEmit -p runtime/tsconfig.json`.
- Runtime test support: `node node_modules/typescript/bin/tsc --noEmit -p runtime/tsconfig.test-support.json`.
- SDK: `node node_modules/typescript/bin/tsc --noEmit -p packages/agenc-sdk/tsconfig.json`.
- Generated SDK consistency: `node runtime/scripts/check-sdk-generated-types.mjs`.
- All 35 changed test files were selected from the pending tracked/untracked
  file inventory. The ordinary hermetic launcher ran 34 files with
  `run --maxWorkers=2 --reporter=dot`: **783 tests passed**.
- The remaining file belongs to the explicit cross-repository lane:
  `node runtime/scripts/run-hermetic-vitest.mjs run --config vitest.cross-repo.config.ts tests/app-server/protocol.contract.test.ts --maxWorkers=1 --reporter=dot`:
  **12 tests passed**.
- Staged whitespace checks passed. A redacted pattern scan of staged source
  found only two deliberate example-host credential-URL rejection fixtures;
  no identified real credentials or binary payloads were staged.

The `npm run typecheck` wrapper rejected the installed npm 11.19.0 because this
repository pins npm 11.17.0. The underlying local TypeScript checks listed above
were run directly and passed; no package-manager requirement was weakened.

## Boundaries and limitations

This is not full-suite, platform-matrix, live-provider, or release validation.
No normal runtime build or actual-daemon smoke was run: those could replace the
runtime artifacts used by an existing local Core process. Its binary, process,
credentials, sessions, and configuration were not changed by this publication.

Ignored dependencies and generated `dist` directories remain local and are not
published. The credential scan is a heuristic review, not an exhaustive security
audit. Provider-key trust entries in source are public verification keys.

The checked-in workflows run ordinary push tests only on `main`, PR checks on
pull requests, and release/npm/installer jobs only on explicit dispatch. This
feature-branch push creates no PR, tag, merge, package publication, or deployment.

## Pull-request integration

PR #2261 integrates current main `6b6e78e` in a separate worktree while retaining
publication commit `719f2c527f219b0c31d9522faf751558dc03ce69` as ancestry.
The dispatcher conflict retains both the remote/routine typed errors and main's
operation-timeout mapping. Memory extraction retains main's canonical home
resolver and its injected-no-home regression.

Review found a semantic integration issue: main's refreshed-Grok-OAuth factory
could override the publication's explicit API-key selection. The integrated
resolver records that choice in factory options; the factory honors it across
provider recreation without changing automatic OAuth refresh. Two added tests
failed before the fix and pass afterward.

- The integration regression run passed **382 tests in 16 files**, covering the
  dispatcher, agent-create deadlines, background runner, memory extraction,
  provider credentials/OAuth, remote access, and routines.
- All three no-emit TypeScript checks and generated SDK consistency passed.
- Protocol index/schema, routine types, and SDK protocol/routine source bytes
  remain identical to `719f2c5`.
- An initial multi-file run encountered a missing native-helper error in one
  credential fixture. Its isolated rerun and the complete integration rerun
  passed; no native helper was built or installed. Hosted Linux CI remains the
  independent gate, not a claimed result of these local checks.

Only the isolated worktree and feature branch are updated. The original worktree
and running Core remain unchanged; this is not release or deployment evidence.

A subsequent changed-file sweep selected 44 test files from the integrated PR
diff; the default hermetic configuration ran **1,216 tests in 42 files**, all
passing. Configuration-excluded lanes are not included in that count.
SonarCloud then requested an explicit alphabetical comparator for MCP
environment names. That bounded change retains redaction, adds a mixed-case
ordering/redaction regression, and passed all **14 MCP management tests** plus
the three no-emit TypeScript checks. Hosted checks remain pending until their
results appear on the PR.

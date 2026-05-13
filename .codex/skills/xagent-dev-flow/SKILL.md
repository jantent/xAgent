---
name: xagent-dev-flow
description: Repository-specific workflow for working in the xAgent codebase. Use when the task is in this repository or mentions xAgent, Meteora DLMM agent, dry_run, live_sdk, live_gateway, orchestrator, execution backend, provider fallback, runtime wiring, or repo-specific validation. Guides Codex to read AGENT.md first, preserve the repo's layering and fallback semantics, choose the correct validation commands, and report what was verified.
---

# xagent-dev-flow

## Workflow

1. Read the repo root `AGENT.md` before making changes.
2. Treat `AGENT.md` as the source of truth for repo facts, code map, guardrails, and validation expectations.
3. Classify the task before editing:
- docs only
- config only
- TypeScript code
- entry/runtime/config/execution backend changes
- `live_sdk` changes
4. Apply the matching workflow below.

## Task Rules

### Docs Only

- Verify that referenced commands, paths, config names, and API routes still exist.
- If the change affects runtime behavior, configuration, or user-facing operation, update `README.md` and `AGENT.md` together when appropriate.

### Config Only

- Keep config structure changes aligned across `src/config/types.ts`, `src/config/loader.ts`, `config/agent.yaml`, `config/agent.live-sdk.yaml`, and `src/app/runtime.ts`.
- Run at least `npm run check`.
- If the config change affects runtime wiring, execution mode, provider fallback, persistence backend, or control plane behavior, run `npm run verify`.

### TypeScript Code

- Preserve the current layering; do not mix provider, manager, execution, API, and persistence concerns into one file.
- Keep TypeScript import paths using `.js` suffixes.
- Prefer adding or updating `node:test` coverage when logic is non-trivial.
- Run `npm run verify`.

### Entry, Runtime, Config, or Execution Backend Changes

- Run `npm run verify`.
- Then run `npm run start:once` with the default safe config to confirm bootstrap, orchestration, and fallback behavior still work.

### `live_sdk` Changes

- Default to validating graceful degradation first: missing RPC, missing wallet secret, or missing external credentials should fail safely or mark the backend unhealthy without breaking control-plane startup.
- Do not run real-chain execution unless the user explicitly asks for it and provides the needed credentials.

## Repo Guardrails

- Default to `dry_run` for development and regression work.
- Preserve provider and pool-source fallback semantics; real dependency failures should still degrade to mock or sample data where the repo already supports it.
- Do not hardcode secrets, tokens, RPC URLs, or wallet material.
- Do not “fix” logic by editing `runtime/state.json`, `runtime/audit/`, or other generated artifacts unless the task explicitly targets those artifacts.
- Do not revert or discard user changes in the working tree.

## Coupling Checklist

- Config structure change:
  Update `src/config/types.ts`, `src/config/loader.ts`, `config/agent.yaml`, `config/agent.live-sdk.yaml`, and `src/app/runtime.ts`.
- Execution mode or execution contract change:
  Review `src/domain/models.ts`, `src/domain/contracts.ts`, `src/execution/`, `src/services/`, `src/api/server.ts`, and `src/dashboard/page.ts`.
- `live_sdk` path change:
  Review `src/execution/backends/`, `src/execution/clients/`, `src/execution/solana/`, `src/wallet/`, `.env.live-sdk.example`, and the related YAML config.

## Final Response

- State what changed.
- List the verification commands that were run.
- State whether validation stayed on `dry_run` / fallback paths or touched live paths.
- Call out any residual risk, especially around execution, persistence, or config coupling.

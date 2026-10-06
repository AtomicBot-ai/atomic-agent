# Backend acquisition, platform choice and GPU facts

Status: current
Owner: src/local-llm/backend/

This area resolves and installs the external llama-server backend, chooses platform assets and exposes hardware observations. Read the inherited [local-llm instructions](../AGENTS.md) and [managed ownership contract](../docs/lifecycle.md). The [public local-llm entry](../index.ts) retains its named-export contract; [backend-paths.ts](../backend-paths.ts) remains the shared disk-layout owner for model, download and daemon files.

## Acquisition and state

[backend-installer.ts](backend-installer.ts) resolves releases by platform asset, owns the established process-local release cache and uses the shared [download transfer](../downloads/download-file.ts). Its bounded release lookup is distinct from a cancellable asset transfer. Keep asset-key cache isolation, force refresh, timestamp ordering and explicit rate-limit outcomes.

[backend-staging.ts](backend-staging.ts) extracts and normalizes a staged install, then swaps it into the live backend only when usable; preserve rollback and cleanup paths. [backend-version.ts](backend-version.ts) reads/writes installed version metadata. [ensure-latest-backend.ts](ensure-latest-backend.ts) owns the persisted check record and update/defer/failure decisions. It coordinates with server lifecycle and live-session registry before stopping daemons; a usable old install remains a meaningful outcome when an update fails.

[platform-assets.ts](platform-assets.ts), [windows-backend-variant.ts](windows-backend-variant.ts) and [linux-arm64-backend-variant.ts](linux-arm64-backend-variant.ts) choose supported archives and variants. [cpu-backend-fallback.ts](cpu-backend-fallback.ts) owns the existing fallback decision and operation after backend failure. These modules consume [server management](../server/README.md) for update/fallback; directory ownership does not grant authority over external processes.

## Device information

[gpu-devices.ts](gpu-devices.ts) parses device tables, selects devices and shares a launch-local table lookup. [gpu-memory-budget.ts](gpu-memory-budget.ts) derives its budget from the established platform/total-memory policy. [nvidia-smi-vram.ts](nvidia-smi-vram.ts) parses and probes NVIDIA memory. Unknown observations and unified-memory handling stay explicit; do not invent capacity or alter configured tensor-split/device semantics while reorganizing code.

These helpers own observations and caches, not the runtime launch itself. [Server](../server/README.md) owns process records and context/slot decisions, config owns stored defaults, and TUI/CLI own requests and presentation.

## Validation

Run `npx vitest run src/local-llm/backend` and affected config/local-models/CLI lifecycle seams. Adjacent suites cover acquisition/staging through installer fixtures, version/update outcomes, CPU fallback, platform choices and hardware parsers. No standalone staging suite or real hardware/backend install verification is implied. Use disposable fixtures and mocked release/transfer calls; run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check` after cross-owner paths are integrated.

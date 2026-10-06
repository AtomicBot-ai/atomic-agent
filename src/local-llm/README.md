# Managed local model/server lifecycle

Status: current
Owner: src/local-llm/

This area owns managed local model/server lifecycle. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [daemon-lifecycle.ts](server/daemon-lifecycle.ts)
- [download-jobs.ts](downloads/download-jobs.ts)
- [download-worker.ts](downloads/download-worker.ts)
- [download-file.ts](downloads/download-file.ts)
- [models-catalog.ts](catalog/models-catalog.ts)

## Ownership and dependencies

Catalog/backend selection resolves model and server assets; download operations own resumable acquisition. Server management owns subprocesses and readiness; runtime/TUI consume these operations and supply cancellation and settings. External mode connects without owning the external server process. Read lifecycle or download details for the operation being changed.

## Task-specific reading

Read docs/lifecycle.md for daemon edits and docs/downloads.md for download edits; ../tui/AGENTS.md for their UI.

## Validation

`npx vitest run src/local-llm`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

## Operation owners

- [Downloads](downloads/README.md): transfers, durable jobs, detached spawn/workers and paired model/projector acquisition.
- [Server](server/README.md): process/port/session/key/health ownership, launch policy, slots/context/SWA and throughput.
- [Backend](backend/README.md): installation/staging/version/update, platform assets and hardware selection/probes.
- [Catalog](catalog/README.md): model IDs/metadata, GGUF and Hugging Face resolution/endpoint.

Root [index](index.ts) remains the intentional compatible named-export API. [backend-paths.ts](backend-paths.ts) remains the sole shared disk layout; [chat-templates.ts](chat-templates.ts) remains at its existing source depth because import.meta.url determines dev/npm asset lookup. Its resolver and SEA lookup behavior are unchanged. Adjacent root tests stay with those contracts. No new barrels or forwarding modules were added.

Backend and server have existing cross-owner dependencies, but individual runtime modules remain acyclic; directory grouping does not imply a strict layer order. [Dependency policy](../../docs/architecture/import-boundaries.md) protects domain/interface boundaries. GGUF byte fixtures belong to tests rather than metadata implementation.

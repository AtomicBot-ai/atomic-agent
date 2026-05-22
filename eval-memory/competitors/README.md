# External memory competitors

This folder hosts the **scaffolding** for running external long-term
memory products through the same LoCoMo / LongMemEval scenarios we
benchmark Memory Fabric v2 on. The shared shape lives in
[`competitor-adapter.ts`](competitor-adapter.ts); concrete adapters
live in subfolders ([`mem0/`](mem0/), [`zep/`](zep/),
[`langmem/`](langmem/)).

## Status

| Adapter | SDK / surface | Implementation |
|---|---|---|
| `mem0` | Mem0 cloud HTTP API at `https://api.mem0.ai` | Skeleton — request bodies + JSON parsing TODO |
| `zep` | Zep local docker REST API | Skeleton — request bodies + JSON parsing TODO |
| `langmem` | LangMem Python package via FastAPI bridge | Skeleton — bridge process management TODO |

Every adapter implements the same minimal surface:

```ts
ensureSession(sessionId) → Promise<void>
ingest(turn)             → Promise<{ durationMs }>
recall({ sessionId, query, k }) → Promise<{ items, durationMs }>
reset(sessionId)         → Promise<void>
close()                  → Promise<void>
```

The campaign orchestrator iterates over the list in
[`index.ts`](index.ts) and skips any adapter whose
`probeAdapterRequirements` returns a non-empty list of missing env
vars — a missing API key never kills a long run silently, it lands
in the summary as a recorded `skipped` reason.

## Apples-to-apples contract

Competitors do **not** own a tool-calling agent. The harness in
[`competitor-runner.ts`](competitor-runner.ts) routes recall output
into a stock `POST /v1/chat/completions` call against the same
llama-server we use for our own profiles, with the same `temperature`
/ `top_p` / `seed` from `CAMPAIGN_SAMPLING`. This isolates the
memory layer as the only variable.

L2 benchmarks (Phase 6) are out of scope here because L2 demands a
tool-using agent; competitors that only own a memory store have no
fair way to compete on `tasks completed`. The PLAN.md flags this
honestly — "this is a comparison of designs, not a verdict that
their memory is bad".

## Wiring a new competitor

1. Create `competitors/<name>/<name>-adapter.ts` implementing
   `CompetitorAdapter`.
2. Export a `<name>Factory: CompetitorAdapterFactory` with
   `requirements.envVars` declaring everything the adapter needs.
3. Register the factory in [`index.ts`](index.ts)'s
   `COMPETITOR_FACTORIES` list.
4. Colocate a `<name>-adapter.test.ts` next to the implementation,
   following the unit-test pattern in
   [`competitor-adapter.test.ts`](competitor-adapter.test.ts).

## Why these aren't fully implemented yet

- **Mem0** — cloud SDK requires a paid plan above the campaign's
  rate-limit budget; OSS variant needs a `docker compose` stack
  (Qdrant + worker). The orchestrator that manages that stack lives
  outside this scaffold.
- **Zep** — local docker REST is the right path but the container
  lifecycle is best owned by a dedicated `scripts/run-zep-docker.mjs`
  orchestrator (deferred).
- **LangMem** — the canonical surface is Python; a faithful bridge
  needs a FastAPI sidecar and an `OPENAI_API_KEY` for langmem's own
  extraction LLM call.

When you finish an adapter, the existing
`runCompetitorScenario(adapter, …)` is the only entry point the
LoCoMo and LongMemEval Vitest specs need to call — replace the
`"_competitor"` profile loop in those specs with a call into
`COMPETITOR_FACTORIES.filter(f => probeAdapterRequirements(f).length === 0)`.

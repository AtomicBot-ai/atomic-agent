# Agent turn and step execution

Status: current
Owner: src/agent/

This area owns agent turn and step execution. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [agent-loop.ts](agent-loop.ts)
- [step-executor.ts](step-executor.ts)
- [batch-executor.ts](batch-executor.ts)
- [tool-resource-class.ts](tool-resource-class.ts)
- [loop-detector.ts](loop-detector.ts)

## Ownership and dependencies

[agent-contract.ts](agent-contract.ts) and [step contracts](step/step-contract.ts) own the public data interfaces without loading executors. AgentLoop and executeStep remain the orchestration entry points; their existing root exports stay compatible.

- [Turn](turn/README.md): preparation, memory context, retry decisions, mutable turn state and finalization.
- [Step](step/README.md): request/stream, synchronous parse/repair, batch policy, evidence admission and ordered commit.
- [Dispatch](dispatch/README.md): synchronous gates and resource scheduling; batch-executor is a compatibility facade.
- [Progress](progress/README.md): fingerprints, notices, thresholds and observation helpers. ToolLoopTracker remains the single state owner in loop-detector.ts.
- [Policies](policies/README.md): plan/fusion restrictions, claim/link evidence and tool-set admission.

Session state and dependencies are passed explicitly. Root orchestration retains the original await points: synchronous parse and recovery must not yield before dispatch, retry or steering closure. Read the mechanism documents before changing these decisions.

The 13 core filesystem taxonomy entries select their unchanged classes from [import-free operation contracts](../tools/os/fs/docs/contracts.md). The taxonomy still owns classification lookup and batching policy; it does not import execution/registry or infer role permissions from readonly metadata. Other tools retain their explicit existing entries. [Global conformance](../tools/tool-contract-conformance.test.ts) checks canonical classes and unknown-name behavior alongside actual registrations.

## Task-specific reading

Read docs/batching.md for dispatch, docs/recovery.md for failures/progress, and ../prompt/AGENTS.md plus ../llm/AGENTS.md for inference changes.

## Validation

`npx vitest run src/agent`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

[Stage 07 acceptance](../../docs/testing/stage-07-validation.md) records extraction/API evidence, callback-order tests and the paired development case study. Its observed source output is not total model context or a performance guarantee.

The injected [compaction control](compaction-control.ts) runs at a safe boundary before inference, after completed batches. The loop supplies the same pure prompt input as step inference, then drains late steering. Runtime owns subcalls and persistence; see [context compaction](../runtime/docs/compaction.md).

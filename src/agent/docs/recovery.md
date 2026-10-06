# Recovery, progress and evidence

Status: current
Owner: src/agent/

## Distinct failures

Completion parse/validation recovery, transport retry, request-size repair and provider fallback are separate layers. Preserve their attempt budgets and cancellation semantics; a tool error is an ordinary result, not permission to replay its side effects. The streamed parser and unary repair must not emit an already committed delta twice.

A turn uses bounded continuation legs and task-wide limits, not an unlimited inference loop. Progress policy includes repeated calls, result-aware no-progress, read coverage, repeated test commands, wandering and review stalls. Its warnings/refusals are dispatch behavior, not merely prompt suggestions. Graceful no-progress closure is distinct from infrastructure failure.

Evidence checks prevent unverified check claims, unsourced links and fabricated transcripts from becoming a closing answer. Keep actual observations as the basis for evidence. Read-scope and declared-input guards must survive both solo and batch paths.

## Ownership and asynchronous boundaries

[Turn recovery](../turn/turn-recovery.ts) returns synchronous decisions; the loop performs the existing provider-outage wait explicitly. [Preparation](../turn/turn-preparation.ts) surrounds the original memory/profile awaits. [Finalization](../turn/turn-finalization.ts) keeps completion events and steering drain order. Adding an unconditional async wrapper would allow queued event callbacks to run before dispatch or turn closure, even when no recovery wait is needed.

Step parsing and repair preparation/finish are synchronous; the actual repair completion await remains in [step-executor.ts](../step-executor.ts). Stream consumption still owns iterator cleanup. [Progress helpers](../progress/README.md) are independent of the tracker state; [policies](../policies/README.md) do not own resources.

## Sources and tests

- [Loop](../agent-loop.ts), [detector](../loop-detector.ts), [parse recovery](../turn/parse-failure-recovery.ts), [empty recovery](../turn/empty-completion-recovery.ts), [size repair](../turn/size-rejection-recovery.ts), [truncation repair](../turn/truncation-recovery.ts).
- [Claims](../policies/claim-evidence.ts), [links](../policies/link-evidence.ts), [read coverage](../progress/read-coverage.ts), [review stall](../review-stall.ts).
- [Loop tests](../agent-loop.test.ts), [detector tests](../loop-detector.test.ts), [step tests](../step-executor.test.ts).

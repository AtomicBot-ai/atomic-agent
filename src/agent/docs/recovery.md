# Recovery, progress and evidence

Status: current
Owner: src/agent/

## Distinct failures

Completion parse/validation recovery, transport retry, request-size repair and provider fallback are separate layers. Preserve their attempt budgets and cancellation semantics; a tool error is an ordinary result, not permission to replay its side effects. The streamed parser and unary repair must not emit an already committed delta twice.

A reply cut short is retried by truncation repair with a notice to think less and write a large file in parts. Cloud keeps the cap (two retries per step); local raises it two-fold once, unless the reply ended in a loop. A filled window repacks once per step; six retries over back-to-back cut steps end the turn.

A turn uses bounded continuation legs and task-wide limits, not an unlimited inference loop. Progress policy includes repeated calls, result-aware no-progress, read coverage, repeated test commands, wandering and review stalls. Its warnings/refusals are dispatch behavior, not merely prompt suggestions. Graceful no-progress closure is distinct from infrastructure failure. User cancellation records a stopped-turn marker without emitting a second assistant reply; the next request and memory extraction treat the withdrawn task as closed. Ephemeral worker turns do not retain this marker. Subscription CLI installation/sign-in errors are setup failures, rather than waitable provider outages.

Loop gates key on the exact call: the repeat, no-progress and veto-streak counters belong to one `(tool, args)` signature, so a call failing over and over never blocks a different call that succeeds beside it (the composite batch observation only warns). The `tool executed` log line names, for an os.fs call, the path it acted on and, for a failure, the first line of its error, never file contents; other tools log only the error name, since a shell error echoes its command line and output ([fields](../tool-log-fields.ts)).

Evidence checks prevent unverified check claims, unsourced links and fabricated transcripts from becoming a closing answer. Keep actual observations as the basis for evidence. Read-scope and declared-input guards must survive both solo and batch paths.

## Ownership and asynchronous boundaries

[Turn recovery](../turn/turn-recovery.ts) returns synchronous decisions; the loop performs the existing provider-outage wait explicitly. [Preparation](../turn/turn-preparation.ts) surrounds the original memory/profile awaits. [Finalization](../turn/turn-finalization.ts) keeps completion events and steering drain order. A turn that closes `max_steps` never got the model's summary (the reserved final step overran its deadline or was refused), so its stop reply carries a [digest](../turn/pause-digest.ts) built from the turn's own records, with no model call. Adding an unconditional async wrapper would allow queued event callbacks to run before dispatch or turn closure, even when no recovery wait is needed.

Step parsing and repair preparation/finish are synchronous; the actual repair completion await remains in [step-executor.ts](../step-executor.ts). The one-shot repair runs under `repairReplyCap` ([step parsing](../step/step-parsing.ts)): 1024 tokens on a grammar link as an anti-loop guard, plus the enforced reasoning budget for a thinking profile (the step's cap when the budget is unbounded), and the step's cap on native tools. Stream consumption still owns iterator cleanup. [Progress helpers](../progress/README.md) are independent of the tracker state; [policies](../policies/README.md) do not own resources.

## Sources and tests

- [Loop](../agent-loop.ts), [detector](../loop-detector.ts), [parse recovery](../turn/parse-failure-recovery.ts), [empty recovery](../turn/empty-completion-recovery.ts), [size repair](../turn/size-rejection-recovery.ts), [truncation repair](../turn/truncation-recovery.ts).
- [Claims](../policies/claim-evidence.ts), [links](../policies/link-evidence.ts), [read coverage](../progress/read-coverage.ts), [review stall](../review-stall.ts).
- [Loop tests](../agent-loop.test.ts), [detector tests](../loop-detector.test.ts), [step tests](../step-executor.test.ts), [repair cap tests](../step/step-parsing.test.ts).

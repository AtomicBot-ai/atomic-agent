# Memory formation and lifecycle

Status: current
Owner: src/memory/

## Write path

Reflection forms bounded profile facts and notes from completed turn observations. Typed notes, segmented reflection and any-speaker extraction are optional and disabled by default. Query rewriting has a different default: it is enabled. Do not describe all v2.5 features as opt-in.

Reflection skips probe-only and one-off instruction turns and rejects ungrounded user names, assistant identity and instruction-as-preference writes. [Grounding](../reflection/reflection-grounding.ts) checks actual user messages. At boot, [name verification](../name-grounding.ts) walks stored user messages without blocking startup; `ProfileStore.listForPrompt()` omits unchecked or ungrounded name-like facts while retaining their history.

ProfileStore retains temporal history; note content is not rewritten by tag evolution. Link generation, neighbor evolution and vote curation operate through their stores and bounded runners. After a link-generation timeout the session skips the next few link calls (doubling on repeat timeouts, reset by a call that completes) instead of retrying on the next turn. Consolidation groups old notes by link component, then groups the notes no link cluster took by a shared topic tag (rarest first, at most 12 per group; `reflection` and `superseded` never group), distills durable lessons/procedures and manages lifecycle/deprecation; its timer has explicit shutdown ownership. Each tick reads one page of 200 candidates and the next tick reads the page after it (the cursor lives in `schema_meta`), so older notes are reached over ticks. Clusters form only within one page: related notes that always land on different pages are not grouped together (a known limit). When the model abstains from a cluster, its notes sit out for one interval, doubling on each repeat abstain up to 7 days (persisted on the note rows); an edit to a note's content or tags makes it due again; timeouts and failures retry on the next tick. The cluster lease is the distill timeout plus 15 s, never under 60 s. Every tick writes one `consolidator.tick` summary log line, the no-op tick included.

Sub-runners must isolate errors, cancellation, provider/session identity and slots from the main turn. Credentials and other secrets must not become durable facts. Preserve dedup, utility eviction, capacity caps and leases; config controls the actual limits.

Repeated failures/timeouts are observed per session and sub-call kind by the memory health tracker. Runtime emits the operator warning once for the affected streak; these fire-and-forget calls do not turn the main agent step into an infrastructure failure. Keep the session attribution when wiring a runner or forwarding its warning.

With `memory.notes.reconcile` on (off by default), [note reconciliation](../reconcile/index.ts) runs after reflection: one bounded background call compares the first new note with a few similar older notes and tags the ones it replaces (or the new note, when it only repeats one) `superseded`; the context provider then leaves those out of recall and the index. No candidates means no call; a timeout gives up.

## Sources

- [Reflection](../reflection/reflection-runner.ts), [profile history](../profile-store.ts), [evolution](../evolution/index.ts), [links](../links/index.ts).
- [Consolidator](../consolidator/index.ts), [lessons](../lessons/index.ts), [procedures](../procedures/index.ts), [voting](../voting/index.ts).
- [Current defaults](../../config/docs/compatibility.md), [runtime lifecycle](../../runtime/docs/lifecycle.md).

## Historical rationale

The archived memory-fabric ledgers explain rollout decisions, not current defaults. Read them only for that history: [v2](../../../docs/archive/2026-10-06/MEMORY_FABRIC_V2.md), [v2.5](../../../docs/archive/2026-10-06/MEMORY_FABRIC_V2.5.md).

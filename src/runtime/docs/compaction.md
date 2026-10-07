# Context compaction

Status: current
Owner: src/runtime/

Compaction preserves an append-only session transcript while replacing its older
part in the model input with a semantic checkpoint. It is independent of durable
memory, reflection, session titles and the mechanical conversation packer.

## Entry points and ownership

`runtime.compactSession(id, { signal? })` returns `compacted`, `noop`, `busy`,
`failed` or `cancelled`, with a reason and available size estimates.
`getSessionCompaction(id)` reads the saved checkpoint without inference.
Neither operation adds a user message, increments turn/step counters, nor runs
reflection. Unknown persisted session IDs raise `SessionNotFoundError`.

TUI exposes `/compact` and `/compact show`.
Other arguments are rejected. HTTP exposes authenticated
`POST /api/sessions/{id}/compact` (waits for the result; concurrent requests get
409) and `GET /api/sessions/{id}/compaction` (`{sessionId, compaction}`, null when
absent). POST consumes the body through the normal size limiter. Disconnecting
that HTTP request cancels its compaction, not the main turn. NDJSON exposes
`compact_session` and `get_compaction`, both with `{sessionId}` and ordinary
request/response correlation. Desktop UI and channel-specific commands are not
part of these surfaces.

The runtime control inbox accepts manual requests during inference, tool work
and approval waits. The loop consumes a request before its next inference, after
the previous batch has been committed. A request left at turn exit is enqueued
without awaiting it while holding the lock. Idle operations load the session
inside FIFO. Duplicate pending/running compactions return `busy`. Turn abort and
runtime shutdown cancel owned operations. Steers arriving during a subcall are
drained and budgeted before the next inference.

## State and prompt

The optional version-1 `SessionState.compaction` lives in the existing SQLite JSON
payload. It contains summary text, an exclusive `coveredThrough` transcript index,
a boundary-record hash, timestamp, reason, model, before/after token estimates,
usage/call count, and estimated cost when pricing is available. Loading rejects
unsupported versions, invalid boundaries and cuts through tool/result pairs;
`compactionWarning` carries the diagnostic. Transcript records are never rewritten.

`projectSessionConversation` supplies checkpoint plus original suffix to both flat
and native prompts, token estimates and pure preview. The summary is historical
conversation context outside the stable system prefix, ahead of fresh history.
The current task's opening request and latest user message are retained verbatim
when covered. Earlier complete steps of that task can therefore be compacted.
The checkpoint text/boundary stay fixed until the next successful compaction.
`conversationPackStart` remains a distinct mechanical cut, reset on successful
compaction. Disabling auto or failing to summarize retains the packer fallback.

Checkpoint and corresponding transcript are saved before the next inference,
without ending the turn or clearing its owner. A deferred first session receives
an owner when its first checkpoint creates the row. Fusion workers retain their
checkpoint only in memory. Sidecar reloads saved state inside the next turn lock;
completion of a manual operation never replaces the running loop's live state.

## Budget and model calls

Defaults are owned by [compaction-config.ts](../../config/agent/compaction-config.ts):
`auto=true`, `triggerRatio=0.9`, `targetRatio=0.65`, `summaryMaxTokens=2048`,
`timeoutMs=600000`, `maxTotalTimeoutMs=600000`.
Validation requires `0 < targetRatio < triggerRatio < 1`.
Older configs receive these defaults.

The pure planner checks projected history **before** mechanical trimming against
the prompt builder's remaining history budget, including non-history sections
and reply reserve. Token pressure at the trigger ratio or impending
`conversationMaxPairs` eviction triggers auto compaction. The target is the
target ratio of that allowance; manual requests use the smaller of allowance and
current volume. Summary reserve is bounded by the configured maximum, 20% of the
history allowance, and half the target so small manual operations remain useful.
When no safe reduction with a fresh complete tail exists, the result is `noop`.

The runtime summarizes the prior checkpoint plus newly covered **original**
records, including rows previously hidden by the packer. If the complete request
fits the model window, it is sent in one call, without an artificial input cap.
Otherwise large inputs (including an oversized individual record) are sent as
sequential pieces bounded by the model window, including instructions and the
largest previous summary. Boundaries are planned
before generation; all source fragments are retained in order. These are token
estimates, not tokenizer measurements or a guarantee of model speed.
Each fragment identifies the original record it starts in and, for a tool result,
the owning call and recorded path/URL. This metadata is budgeted too, so a result
continued across requests keeps its source rather than borrowing a filename
from the user request.

Every piece also includes the original conversation request, current task opening
request and latest user correction verbatim, with duplicates removed and counted
against the same input budget. These are orientation, not evidence of completed
actions. Repeating them keeps tool-heavy pieces from redefining the goal through
successive summaries. If they leave no safe input room, the operation fails
without replacing the checkpoint rather than silently truncating the requests.

`timeoutMs` limits each call; old configs retain explicit values and gain the new
defaults for missing fields. The overall deadline is the smaller of `maxTotalTimeoutMs` and
`timeoutMs` times the planned call count. Small histories keep a single-call
budget; by default the whole operation has a ten-minute ceiling. Timeouts
report the failing part or total deadline and completed-call count. Cancellation
aborts the current provider request; neither partial progress nor a late response
can publish a checkpoint. No intermediate checkpoint is published. The current provider route or
worker pin is retained; no fallback chain is started for this subcall. It uses
the existing completion/cancellation infrastructure, provider-specific framing,
no tools, and a side-call slot when available. The ordinary step still has one
inference. A smaller model/window is rebudgeted on the next build.

The prompt asks for goal, constraints/preferences, decisions/reasons, completed
work with evidence, unfinished work/blockers, next actions and essential paths,
IDs/errors, in the conversation's language. Intentions must be distinguished from
actions and verified results. Empty, truncated, oversized and non-reducing
summaries are rejected, as are failed checkpoint writes. Automatic failures warn
and suppress further automatic attempts until the next turn; manual requests
remain available. Cancellation is reported distinctly. A provider context-size
refusal allows one compaction retry of the inference; committed tools are not
replayed, and repeat refusal follows ordinary error handling.

## Observability and validation

Session-scoped `compaction_started`, `compaction_progress`, `compaction_completed` and
`compaction_failed` events reach hosts and traces. TUI shows status and estimates,
and refreshes the context readout after persistence. Progress reports the current
part, exact planned part count, completed parts and estimated **raw source** size,
which may exceed the rendered conversation estimate. TUI does not infer progress
inside a model call. Full summary text is shown
only on request. Subcalls use `compaction:<sessionId>` for separate usage and
ordinary provider cost accounting. Local token usage falls back to completion
timing counts when no provider usage block is returned.

Contract tests: [planner/service](../context-compaction.test.ts),
[HTTP/runtime/persistence](../../http/route-compaction.test.ts),
[NDJSON](../../sidecar/compaction.test.ts),
[TUI commands](../../tui/commands/slash-command-handler.test.ts).
These tests use scripted completions; they establish mechanics, not summary
quality. Real local and cloud models require separate repeated-compaction
evaluations for retention of constraints, done/planned distinctions and resumption.

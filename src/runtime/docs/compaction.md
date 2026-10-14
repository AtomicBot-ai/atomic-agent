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
request/response correlation. The desktop calls the HTTP POST from its `/compact`
command and the context popover's "Compact now". Channel-specific commands are
not part of these surfaces.

The runtime control inbox accepts manual requests during inference, tool work
and approval waits. The loop consumes a request before its next inference, after
the previous batch has been committed. A request left at turn exit is enqueued
without awaiting it while holding the lock. Idle operations load the session
inside FIFO. Duplicate pending/running compactions return `busy`. Turn abort and
runtime shutdown cancel owned operations. A started compaction that ends
`failed` logs a warning and one that ends `cancelled` an info line
(`logCompactionOutcome`); a request cancelled while still queued logs nothing. Steers arriving during a subcall are
drained and budgeted before the next inference.

## State and prompt

The optional version-1 `SessionState.compaction` lives in the existing SQLite JSON
payload. It contains summary text, an exclusive `coveredThrough` transcript index,
a boundary-record hash, timestamp, reason, model, before/after token estimates,
usage/call count, and estimated cost when pricing is available. An extractive
checkpoint has `model: null` and the optional `kind: "extractive"`; one made from a
rolling summary has `kind: "rolling"`. Loading rejects
unsupported versions, invalid boundaries and cuts through tool/result pairs;
`compactionWarning` carries the diagnostic. Transcript records are never rewritten.
The optional `SessionState.rollingSummary` (see Rolling summary) is never part of
the prompt; loading drops it silently when stale.

`projectSessionConversation` supplies checkpoint plus original suffix to both flat
and native prompts, token estimates and pure preview. The summary is historical
conversation context outside the stable system prefix, ahead of fresh history.
The current task's opening request and latest user message are retained verbatim
when covered. Earlier complete steps of that task can therefore be compacted.
The checkpoint text/boundary stay fixed until the next successful compaction.
`conversationPackStart` remains a distinct mechanical cut, reset on successful
compaction. In `local`, disabling auto or failing to summarize retains the packer fallback.
When that cut leaves rows out, the loop emits `history_trimmed` (dropped messages,
dropped user turns, bound) once per cut: again only when the dropped count changes,
re-armed by a build that drops nothing. Fusion workers do not emit it.

In `cloud`, both prompts project the saved message journal through that checkpoint.
Active loaded instructions and state are carried in full; older state updates also
enter the summarizer source. Neither transcript nor journal is rewritten. There is
no mechanical packer fallback: an oversized cloud request fails without hidden
clipping if no useful checkpoint can be made. The journal candidate is committed
before inference, including when there is no compaction to perform.

Checkpoint and corresponding transcript are saved before the next inference,
without ending the turn or clearing its owner. A deferred first session receives
an owner when its first checkpoint creates the row. Fusion workers retain their
checkpoint only in memory. Sidecar reloads saved state inside the next turn lock;
completion of a manual operation never replaces the running loop's live state.

## Budget and model calls

Defaults are owned by [compaction-config.ts](../../config/agent/compaction-config.ts):
`auto=true`, `mode="auto"`, `triggerRatio=0.9`, `targetRatio=0.65`, `summaryMaxTokens=2048`,
`timeoutMs=600000`, `maxTotalTimeoutMs=600000`, `background=true` (optional; absent means on).
Validation requires `0 < targetRatio < triggerRatio < 1` and a known mode.
Older configs receive these defaults; adding `mode` and `background` did not change the config version.

The pure planner checks projected history **before** mechanical trimming against
the prompt builder's remaining history budget, including non-history sections
and reply reserve. Token pressure at the trigger ratio or impending
`conversationMaxPairs` eviction triggers auto compaction in `local`. Cloud uses
window pressure after schemas, message overhead, reply reserve and safety margin;
the local pair/section caps do not trigger it. The target is the
target ratio of that allowance; manual requests use the smaller of allowance and
current volume. When the step's model profile has prefix reuse `none` (and
applies to that step's route), the ratio is at most 0.35: every later step
re-reads the whole prompt there, so a smaller kept tail is cheaper per step and
postpones the next compaction. Summary reserve is bounded by the configured maximum, 20% of the
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
budget; by default the whole operation has a ten-minute ceiling. Each call
carries `timeoutMs` (plus a few seconds, so the part limit reports first) as its own request deadline, replacing the provider's
`requestTimeoutMs` (five minutes for local llama-server by default) for that
request only, and the process transport ceiling is raised to cover it. Timeouts
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
summaries are rejected, as are failed checkpoint writes. Automatic failures that
leave no checkpoint warn
and suppress further automatic attempts until the next turn; manual requests
remain available. An automatic attempt that timed out is held longer, across
turns: the next automatic attempt waits until projected history has grown by 25%
over the timed-out attempt's size, or the provider, model, window, `timeoutMs` or
`mode` changed.
A success (manual included) or runtime restart clears the hold. Cancellation is reported distinctly. A provider context-size
refusal allows one compaction retry of the inference; committed tools are not
replayed, and repeat refusal follows ordinary error handling.

## Summary method

`mode` chooses how the summary is made. `model` asks the active model, as described
below. `extractive` builds it in one pass without inference
([builder](../compaction-extractive.ts), [tool step lines](../compaction-extractive-steps.ts)):
every user request in the covered records verbatim (over 1200 characters, the
middle is cut), one line per tool step with its target and outcome (`read X`,
`edited Y`, ``ran `cmd` → exit N: first error line``), assistant replies trimmed
to 600 characters, files changed and read, URLs, and the first line of each error.
Tool output bodies, written content and reasoning are dropped. The previous
checkpoint is carried as a bounded block. Sections have fixed shares of
`summaryMaxTokens` and keep the newest entries when the share binds, so the text
never exceeds the planned summary reserve and passes the same reduction check.
It runs in milliseconds on a 150k-token history, makes no calls and reports no
progress events. Cloud state updates are not part of it.

`auto` ([choice](../compaction-mode.ts)) extracts when the serving link is a
llama-server whose prefix reuse is `none`, or whose serialized source is at least
32k estimated tokens: prompt evaluation speed is unknown in advance and that much
input already takes minutes on a laptop model. Cloud and other routes keep the
model summary. Under `auto`, a model summary that fails or times out (not a
cancellation) is replaced by an extractive checkpoint instead of leaving the
packer's mechanical cut, and the completed result says so. After a model summary
times out on a provider/model/window, later `auto` compactions on it extract
directly until the runtime restarts or `timeoutMs`/`mode` change. A fallback is
logged as a warning. `model` keeps the original failure behavior.

## Rolling summary

Under `auto`, with `auto` and `background` on, the runtime extends a per-session
rolling summary between turns ([scheduler](../compaction-background.ts),
[records and checkpoint](../compaction-rolling.ts)) so that a later compaction
needs no model call. A turn's end schedules a job after 2 s of quiet (not for
Fusion worker sessions). It runs only
while no turn runs on any session, one job at a time across the runtime; any turn
or step start, compaction request or shutdown aborts it (timers cleared, request
cancelled) and nothing is written. A job never blocks a turn.

A job starts once projected history reaches half the automatic trigger (cloud
routes, which bill per call: also half the history allowance). It never runs on a
local llama-server route without a free side slot: a side call on the main slot
would evict the conversation's cache. It reads the previous rolling summary (or the
current checkpoint) plus only the records after its watermark, rendered as
history (the prompt's capped renderer, each record at most 2000 characters), up to
the cut a compaction would make now and at most 12k estimated tokens; the rest is
left to the next job. Fewer than 256 tokens of new records do not start a call. The call uses the compaction route, provider framing, side
slot and `compaction:<sessionId>` usage, with `timeoutMs` capped at five minutes
per job; a job that times out stops jobs for that session until restart. The
summary may use 60% of the planned summary size. It is saved only if no turn runs
on that session and the checkpoint, boundary record and watermark are unchanged.

`SessionState.rollingSummary` holds the text, the checkpoint it extends (`from` and
a hash of its summary), the exclusive watermark `coveredThrough`, the boundary
record hash and the model. It is valid only while all of these still match and the
watermark is a safe cut, so edits, forks and compaction make it stale. At
compaction under `auto`, a valid one is used without a call: its text plus an
extractive summary of the records from its watermark to the cut (a watermark past
the planned cut becomes the cut, keeping at least one record outside it). When it
is stale, too large, leaves under 96 tokens for those records, covers less than
half of the checkpoint's records (by rendered size), or its checkpoint would not
reach the target, compaction proceeds as described above. Every successful compaction removes it; an applied
checkpoint is never replaced later by a rolling summary. Cloud state updates are
not in it. Its background calls are counted as they run, not in the checkpoint's
`calls`.

## Observability and validation

Session-scoped `compaction_started`, `compaction_progress`, `compaction_completed` and
`compaction_failed` events reach hosts and traces; HTTP chat streams forward them
and `history_trimmed` as extension-only named frames. TUI shows status and estimates,
and refreshes the context readout after persistence. Progress reports the current
part, exact planned part count, completed parts and estimated **raw source** size,
which may exceed the rendered conversation estimate. TUI does not infer progress
inside a model call. Full summary text is shown
only on request. Subcalls use `compaction:<sessionId>` for separate usage and
ordinary provider cost accounting. Local token usage falls back to completion
timing counts when no provider usage block is returned.

Contract tests: [planner/service](../context-compaction.test.ts),
[extractive/auto service](../context-compaction-extractive.test.ts),
[extractive builder](../compaction-extractive.test.ts),
[rolling summary](../context-compaction-rolling.test.ts),
[rolling records](../compaction-rolling.test.ts),
[rolling state](../../session/session-compaction-rolling.test.ts),
[HTTP/runtime/persistence](../../http/route-compaction.test.ts),
[NDJSON](../../sidecar/compaction.test.ts),
[TUI commands](../../tui/commands/slash-command-handler.test.ts),
[trim notice](../../agent/history-trim-warning.test.ts),
[stream frames](../../http/stream-maintenance-frame.test.ts).
These tests use scripted completions; they establish mechanics, not summary
quality. Real local and cloud models require separate repeated-compaction
evaluations for retention of constraints, done/planned distinctions and resumption.

# atomic-agent — engineering guide for agents

This is the source-of-truth for automated contributors (LLM agents, codegen, etc.). Human-facing docs live in `README.md`.

## Mission

`atomic-agent` is a lightweight local operator agent runtime that:

- Embeds as a **sidecar** in Tauri desktop apps (stdin/stdout NDJSON).
- Ships a **CLI** (`atomic-agent`) for local debugging.
- Connects to an **external** `llama-server` (llama.cpp) over HTTP — the LLM runtime, model weights, and binaries are **not** part of this project.
- Keeps every LLM step under ~2.5k tokens by externalising session state, summarising results, and keeping the stable prompt prefix small.

## Architectural invariants

1. **Project ≠ Prompt.** Session state, compressed tool results, and world snapshots live outside the model; the prompt is always a small slice.
2. **Stable prefix.** The prompt is `buildStablePrefix` (persona + `### rules` + skill catalog under `### skills` + `### tools` + `### capabilities` + `### instructions`) followed by a **variable tail** in mutability order: `### loaded-skills` (optional) → `### loaded-tools` (optional) → `### profile` (optional) → `### memory-index` (optional) → `### session-facts` (optional) → `### recalled` (optional) → `### world` → `### conversation` → optional `### notice` (written by the no-progress loop detector and by mid-turn steering, composed in that order) → `### respond` (+ optional reasoning prefill). Only the stable-prefix bytes must stay stable within a session for KV-cache — this is what `cache_prompt + slot_id` on `llama-server` relies on.
3. **One inference per step.** No reasoning loops inside a single LLM call — the runtime drives the loop. A single inference always emits a JSON **array** of `1..N` tool calls (`[{tool, args}, ...]`); a "solo" step is just a length-1 array (`[{...}]`). `N` is capped by `agent.maxParallelToolCalls` (default 8, hard ceiling 16 in the grammar). See §"Parallel tool calls per step" for the rationale (GBNF first-token bias) and the executor pipeline.
4. **Grammar-constrained tool calls.** The sidecar sends a GBNF grammar with every completion request that must produce a tool call. The root collapsed to **array-only** (`root ::= tool-call-array`) so the model cannot fall into the single-object form via first-token bias even when it only needs one call. Reasoning-prelude profiles (`qwen-think`, `gemma4-think`) prepend a `<think>...</think>` / `<|channel>thought...<channel|>` block to the array; the seam between the close sentinel and the leading `[` of the array routes through a dedicated **bounded** `prelude-trail-ws ::= ( [ \t\n\r] ){0,8}` rule rather than the global unbounded `ws`. This is the structural anti-degenerate-loop guard — small reasoning-capable models (Gemma 4 26B-A4B in particular) used to slide into a whitespace-only tail after a long reasoning block because the sampler could keep emitting newlines indefinitely. Pinned by [src/llm/grammar/build-grammar.test.ts](src/llm/grammar/build-grammar.test.ts) "bounds the whitespace between the reasoning-close sentinel and the tool-call array".

   **Reasoning-open ownership differs by profile (`reasoningOpenEmittedByModel` in [src/llm/model-profile.ts](src/llm/model-profile.ts)).** `qwen-think` **prefills** its open tag at the end of the prompt (`### respond` → `<think>`); the grammar prelude starts after the open tag (`think-prelude ::= think-body "</think>" …`) and `step-executor` prepends the open tag back onto the completion before parsing. `gemma4-think` is the opposite: Gemma 4's QAT template treats a prefilled `<|channel>thought\n` as the *thinking-disabled* marker and immediately closes the channel, dumping its reasoning into `reply.text`. The fix is **native turn-framing** — the profile carries `turnFraming { systemOpen: "<|turn>system\n", turnClose: "<turn|>\n", assistantOpen: "<|turn>model\n" }` and `reasoningEmittedByModel: true`. `buildStablePrefix` opens the prompt with `<|turn>system\n<|think|>\n### system…` (the `<|think|>` token must sit at the very top of a real system turn to activate the channel — a one-time gemma-only stable-prefix byte change / KV invalidation), `buildPrompt` ends the tail with `…### respond\nRespond now.\n\n<turn|>\n<|turn>model\n` instead of a channel prefill, and the grammar prelude **includes the open sentinel** (`channel-prelude ::= "<|channel>thought\n" channel-body "<channel|>" prelude-trail-ws`) so the model emits its own `<|channel>thought` block. `step-executor.normalizeContent` does **not** prepend the open tag for `reasoningEmittedByModel` profiles (it is already in `completion.content`), the stream parser runs with `preOpenedThink: false` so it detects the open tag live, and the repair prompt strips/re-appends `<turn|>\n<|turn>model` rather than the bare open tag. `checkProfilePromptAligned` asserts a turn-framed prompt ends with the model-turn opener (not the open tag). Pinned by [src/agent/profile-matrix.test.ts](src/agent/profile-matrix.test.ts), [src/llm/grammar/build-grammar.test.ts](src/llm/grammar/build-grammar.test.ts), [src/prompt/build-prompt.test.ts](src/prompt/build-prompt.test.ts), [src/llm/profile-invariants.test.ts](src/llm/profile-invariants.test.ts), [src/llm/grammar/stream-parser.test.ts](src/llm/grammar/stream-parser.test.ts).
5. **No global singletons.** Dependencies are passed explicitly. `getConfig()` is the only exception.
6. **Session is multi-turn chat only.** A session is a long-lived chat: `user message → 0..N tool steps → reply` is a macro-turn, multiple turns share one `SessionState.turns[]`. Two terminals exist — `reply` ends the turn, `finish` ends the whole session. All three frontends (CLI `run`, TUI, sidecar) go through `runtime.runTurn` only; there is no one-shot goal mode.

## Rare tools: `tool.view` and `### loaded-tools`

The stable-prefix `### tools` block lists **frequent** tools with full `args` schemas in `# common (full)` and **rare** tools as one-line entries under `# extras` (tier `rare`), keeping the cache-hot prefix small. The model does not see full `args` for a rare tool until that tool is **loaded** into the session and rendered in the **variable** tail as `### loaded-tools` (not part of the stable prefix, so it does not pollute KV-cache for steps that do not use rare tools).

- **Discovery tool.** `tool.view { name }` (see `src/tools/tool-view/`) appends the full descriptor for `name` to `SessionState.loadedTools` (LRU-evicted, cap `config.agent.loadedToolsCap`). The next step’s `buildPrompt` includes `### loaded-tools` with capped token budget `config.agent.loadedToolsMaxTokens`; the effective conversation cap subtracts that budget (see `src/prompt/token-budget.ts`). Optional `config.agent.autoExpandRareOnError` re-invokes a rare tool with autoloaded schema after an invalid-args failure (`src/agent/step-executor.ts`).

- **Contract.** Follow the same idea as `skill.view`: do not call a rare tool with precise arguments until its schema is present under `### loaded-tools` (call `tool.view` first, or rely on autoload on error if enabled). GBNF allows `tool.view` alongside other tools (`grammars/tool-call.gbnf`).

## Skills enable / disable

Installed skills can be turned off without removing their files via `skills.disabled: string[]` in `<stateDir>/config.json` (config v8). A disabled name is filtered out of `SkillRegistry.list()` entirely — it disappears from the `### skills` catalog block in the stable prefix, `skill.view` returns `SkillNotFoundError`, and the underlying skill directory stays put on disk so `seed-starter-skills` re-seeds remain idempotent. The CLI surface is `atomic-agent skill enable|disable <name>` and `atomic-agent skill list` (with an `enabled`/`disabled` column); the TUI exposes the same toggle through a dedicated **Skills tab** (`/skills` opens it, `/skill enable|disable <name>` mutates from chat). Editing the list invalidates KV-cache once because the stable-prefix bytes change — identical to install/uninstall today. Pinned by [src/skills/skill-registry.test.ts](src/skills/skill-registry.test.ts) (filtering + `listAll()`), [src/cli/skill.test.ts](src/cli/skill.test.ts) (idempotent enable/disable round-trip), [src/prompt/build-prompt.test.ts](src/prompt/build-prompt.test.ts) ("stable prefix changes deterministically when a skill is removed from the catalog"), and [src/config/config-schema.test.ts](src/config/config-schema.test.ts) (v7 → v8 transparent migration).

## Parallel tool calls per step

A single LLM inference always emits a JSON **array** of `1..N` tool calls. The runtime executes the array with class-aware concurrency: independent reads fan out, mutating tools serialise, and the wall time of the step collapses to `max(group_duration)` instead of the sum. This is the path that turns "scan 4 CSVs for PII" from 4 sequential `os.fs.read`s into one batched step.

### Grammar shape (array-only)

`grammars/tool-call.gbnf`:

```
root ::= tool-call-array
tool-call ::= "{" ws "\"tool\"" ws ":" ws tool-name ws "," ws "\"args\"" ws ":" ws object ws "}"
tool-call-array ::= "[" ws tool-call ( ws "," ws tool-call ){0,15} ws "]"
```

**Why array-only.** The first iteration of this feature shipped with `root ::= tool-call | tool-call-array` so a solo step could keep the legacy `{tool, args}` shape. Production traces showed that small/medium models (Qwen3-30B-A3B-Instruct in particular) almost never picked the array branch even when their `<think>` block reasoned about parallel reads — the GBNF sampler's first-token mass strongly favours `{` over `[`. Collapsing the root to `tool-call-array` removes that choice entirely: the model **must** start with `[`, which makes "one call vs many calls" a decision about array length instead of a first-token gamble. A solo step is now `[{...}]`. The legacy `parseToolCall` still accepts a bare `{tool, args}` for tests/replay scenarios, but `llama-server` will never emit one under the production grammar.

The hard upper bound on array length is **16** (grammar). The runtime soft cap is `agent.maxParallelToolCalls` (default `8`, env `ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS`). Both reasoning profiles (`qwen-think`, `gemma4-think`) route the prelude into `tool-call-array`, so think-mode batches work the same way (see [src/llm/grammar/build-grammar.ts](src/llm/grammar/build-grammar.ts) and the matching invariant in [src/llm/profile-invariants.ts](src/llm/profile-invariants.ts)).

The change to the array-only root **invalidates KV-cache** for any session that started under the old grammar — the stable prefix bytes change once, then stay stable. There is no hot migration path; restart with a fresh session pool.

### Resource-class taxonomy

[src/agent/tool-resource-class.ts](src/agent/tool-resource-class.ts) maps every registered tool to one of nine classes. The batch executor groups calls by class — same-class calls run **inside** the group (parallel for `pure_read`, serial for everything else), distinct groups run **concurrently** with each other.

| Class | Examples | Within-group | Cross-group |
|---|---|---|---|
| `pure_read` | `os.fs.read`, `os.fs.glob`, `os.fs.grep`, `os.git.*` (read), `os.fs.list`, `os.fs.read_document`, `memory.notes.recall`, `tasks.list` | **parallel** (`Promise.allSettled`) | parallel |
| `browser` | `browser.*` | serial (Playwright is single-process) | parallel |
| `memory_write` | `memory.profile.set`, `memory.notes.store`, `os.clipboard.write`, `os.notify` | serial | parallel |
| `tasks_write` | `tasks.schedule`, `tasks.cron`, `tasks.cancel` | serial | parallel |
| `vision` | `vision.describe` | serial (bounds backend load) | parallel |
| `fs_write` | reserved | serial | parallel |
| `approval_gated` | `os.shell.run`, `os.fs.{write,edit,trash,patch,archive.extract}`, `os.proc.kill`, `os.http.request`, `skill.run_script` | **forbidden in batch** — must be solo | — |
| `terminal` | `reply`, `finish` | **allowed only as the LAST element** of a batch; runs after the non-terminal portion completes (tail-terminal barrier in `executeBatch`). Mid-batch or duplicated terminals are rejected by the validator. | — |
| `unknown` | unregistered names | **forbidden in batch** (fail-closed) | — |

Adding a new tool **requires** an entry in `TOOL_RESOURCE_CLASS`; pinned by [src/agent/tool-resource-class.test.ts](src/agent/tool-resource-class.test.ts) which iterates `DEFAULT_TOOL_DESCRIPTORS` and rejects any with `unknown` class.

### Batch executor and step pipeline

[src/agent/batch-executor.ts](src/agent/batch-executor.ts) owns the planner. The flow inside [src/agent/step-executor.ts](src/agent/step-executor.ts) is:

1. **Parse.** `parseToolCalls(...)` returns a `ToolCallBatch { kind: "single" | "batch", calls: ToolCallPayload[], reasoning? }`. Under the array-only production grammar `kind` is always `"batch"` (a solo step has `calls.length === 1`); the `"single"` branch only fires for legacy bare-object input from tests / replay traces.
2. **Validate.** `validateBatch` rejects multi-call batches that contain a terminal verb anywhere other than the **last** position (mid-batch or duplicated), an approval-gated tool, an unknown class, or exceed `maxParallelToolCalls`. A terminal verb at the tail (`[non-terminals..., reply]`) is **accepted** — see the tail-terminal barrier below. A failure is treated like a parse error: the executor triggers the existing one-shot LLM retry. After two failures it surfaces as `GrammarError` with the per-call reasons. Length-1 batches bypass these checks (legacy semantics for any tool, including `reply`/`finish`/approval-gated).
3. **Registry check.** Missing tools throw `ToolExecutionError` (category `tool`) without retry — replaying the prompt would not change the registry.
4. **Execute.** `executeBatch` runs in two phases. **Phase 1 (synchronous loop gate):** for every non-terminal call, in batch-index order, `runSyncLoopGate` calls `tracker.check(tool, args)` → `tracker.recordCall(tool, args)` BEFORE any tool is dispatched. Because the gate mutates the `ToolLoopTracker` synchronously, a duplicate call later in the same parallel batch observes the earlier sibling's `recordCall` — so dup-within-batch loops are caught even though the invokes fan out. A `critical` verdict (or a tripped breaker) produces a synthetic `CompressedToolResult{status:"error", details:{deniedReason:"tool-loop"}}` that **replaces** the real invocation (the tool never runs) and is recorded so it is excluded from the no-progress streak. **Terminal verbs are NEVER gated.** **Phase 2 (invoke):** `planBatch` groups the survivors, fans out, collects `BatchCallResult[]`; each real outcome is fed back via `tracker.recordOutcome`. Failures of one call are folded into a synthetic `CompressedToolResult{status:"error"}` so siblings keep running. `signal.aborted` halts in-flight serial groups and marks the tail as `cancelled`. **Tail-terminal barrier:** when the batch ends in a `terminal` verb, the executor first awaits every non-terminal group, then runs the terminal call solo. A non-terminal failure does **not** suppress the terminal — the model's intent "do tools, then reply" is preserved even when one tool errored (the failure lands as a normal `status: "error"` slot). The gate's `warn` / `critical` / `breaker` decisions are surfaced upward as `BatchExecutionResult.loopSignals` → `StepOutcome.loopSignals`.
5. **Apply effects.** `applyStateEffects` is invoked per result in batch-index order; `recordLatestResult` is "last writer wins". World snapshot updates from multiple browser calls collapse to the last batch index.
6. **Auto-expand on error.** Failed rare-tool calls trigger `autoExpandRareOnError` independently per batch index — each rare tool that errored gets its full descriptor injected into `### loaded-tools` for the next step.
7. **Append turns.** `appendBatchedTurns` writes N `assistant_tool_call` + N `tool_result` pairs in batch-index order. For tail-terminal batches (`[..., reply]`) the trailing `reply` collapses into a single `assistant_reply` turn after the non-terminal tool-call / tool-result pairs — the transcript reads `tool_call → tool_result → assistant_reply` and `assistant_reply` is emitted exactly once. Reasoning is attached once on the first `assistant_tool_call` (one inference ⇒ one `<think>` block); when the batch is pure terminal (length-1 `reply`) the reasoning attaches to `assistant_reply` directly. The new `agent.batchToolResultCharCap` (default `16000`, env `ATOMIC_AGENT_BATCH_TOOL_RESULT_CHAR_CAP`) trims oldest within-batch summaries first when the combined char total overflows.

### Locked invariants (pinned by tests)

Pinned by [src/agent/batch-executor.test.ts](src/agent/batch-executor.test.ts), [src/agent/step-executor.test.ts](src/agent/step-executor.test.ts), [src/agent/parallel-tool-calls.integration.test.ts](src/agent/parallel-tool-calls.integration.test.ts), [src/agent/loop-detector.test.ts](src/agent/loop-detector.test.ts), [src/llm/grammar/tool-call-grammar.test.ts](src/llm/grammar/tool-call-grammar.test.ts), [src/llm/grammar/build-grammar.test.ts](src/llm/grammar/build-grammar.test.ts), [src/tracing/trace/trace-recorder.test.ts](src/tracing/trace/trace-recorder.test.ts):

1. **One inference per step.** Batches do not start a new LLM call — they execute multiple tools after one inference completes.
2. **Approval-gated tools are always solo. Terminal verbs are allowed only as the LAST element of a batch.** Validator rejects an approval-gated tool from any multi-call batch and rejects any terminal verb that appears mid-batch or is duplicated; one-shot retry asks the model to re-emit. A batch like `[memory.notes.store, reply]` is **valid** — `executeBatch` runs the store first, awaits it, then runs the `reply` solo (tail-terminal barrier). A non-terminal failure inside the batch does **not** suppress the tail terminal (the model's "do tools, then reply" intent survives one bad tool). Pinned by `executes a [tool, reply] tail-terminal batch in one inference` (step-executor), `runs a terminal-tail call strictly AFTER every non-terminal call completes` and `fires the tail reply even when an earlier non-terminal call errors` (batch-executor).
3. **Result order matches batch-index order.** `toolResults[i]` corresponds to `toolCalls[i]` regardless of completion order. Pure-read fan-out reorders execution but not results.
4. **Failures isolate.** A failed call never aborts siblings; it lands in `toolResults[i]` as `{status: "error", details}`. `loop_failed` only fires on infra failures (parse/grammar/cancel), **never** on tool-level errors or on no-progress loops — a loop ends the turn with a graceful synthetic `reply`, not a `failed` terminal (see §"No-progress loop detection").
5. **Loop detection is the `ToolLoopTracker`'s job, threaded via `BatchExecutionContext.tracker`.** Per-call detection runs in the synchronous gate (phase 1 above); the composite-batch path (`observeBatchComposite`, synthetic label `<batch>` / `BATCH_LOOP_LABEL`) still catches two identical batches in a row but not a permuted batch (the model may legitimately reorder a set after re-thinking). See §"No-progress loop detection".
6. **Per-step trace = N `tool_invocation` events.** `trace-recorder.ts` keys pending parsed calls by `batchIndex` so each pair is recorded with `{batchIndex, batchSize}` (omitted for solo steps for back-compat).
7. **Sidecar forwards batch metadata optionally.** `tool_call_started` / `tool_call_result` carry `batchIndex` / `batchSize` only when `batchSize > 1`; hosts that ignore them keep working.
8. **Cross-session parallelism unchanged.** `TurnController` per-session FIFO is untouched — batches are *intra*-step parallelism, not inter-session.

### Configuration (`agent.*`)

- `agent.maxParallelToolCalls` — default `8`, range `[1, 16]`. Env `ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS`. Set to `1` to disable batching; set to higher values to widen pure-read fan-out. Bumped from `4` → `8` after production traces showed `qwen-3.5` routinely emits 5–7 reads when the user requests "≥N files" — the previous cap forced two doomed `parse_retry` attempts in a row, both classified as `GrammarError`.
- `agent.batchToolResultCharCap` — default `16000`. Env `ATOMIC_AGENT_BATCH_TOOL_RESULT_CHAR_CAP`. Soft cap on combined summary length per batched step before per-result truncation.
- `agent.loopWarningThreshold` — default `3`. Env `ATOMIC_AGENT_LOOP_WARNING_THRESHOLD`. Args-only repeat count (`getRepeatCount`) at which `check()` returns `warn`.
- `agent.loopCriticalThreshold` — default `5`. Env `ATOMIC_AGENT_LOOP_CRITICAL_THRESHOLD`. Args+result no-progress streak (`getNoProgressStreak`) at which `check()` returns `critical` and the gate vetoes the call. Clamped to be `>= loopWarningThreshold`.
- `agent.loopBreakerVetoStreak` — default `3`. Env `ATOMIC_AGENT_LOOP_BREAKER_VETO_STREAK`. Consecutive vetoes before the breaker trips and the turn ends with a graceful synthetic `reply`.
- `agent.loopHistorySize` — default `40`. Env `ATOMIC_AGENT_LOOP_HISTORY_SIZE`. Per-turn ring-buffer size for the tracker's call/outcome history. Clamped up to at least `loopWanderingEscalation` so the distinct-spread window is never trimmed before it can escalate.
- `agent.loopWanderingThreshold` — default `6`. Env `ATOMIC_AGENT_LOOP_WANDERING_THRESHOLD`. Distinct-args spread (`effectiveSpread`) on a wandering-prone tool (`os.web.fetch` / `os.http.request` / `browser.*`) at which `check()` returns a `wandering` warn — an actionable redirect notice (`formatWanderingRedirect`), not a veto (unique calls are not blocked).
- `agent.loopWanderingEscalation` — default `12`. Env `ATOMIC_AGENT_LOOP_WANDERING_ESCALATION`. Distinct-args spread at which the wandering loop escalates onto the `breaker` path (forced graceful `reply`). Clamped to be `>= loopWanderingThreshold`.

All are env-only; not user-config-file material.

### No-progress loop detection

The runtime guards against "stuck" turns where the model re-emits the same tool call (same args, same result) without making progress. The detector is [src/agent/loop-detector.ts](src/agent/loop-detector.ts) `ToolLoopTracker` — **one instance per turn**, owned by `AgentLoop.runTurn`, threaded into `executeStep` → `executeBatch` via `BatchExecutionContext.tracker`. Ported from OpenClaw 2026.6.5; the design goal is **graceful termination, never a hard failure**.

**Two-phase history.** Each call goes through `check(tool, args)` (read-only verdict) → `recordCall(tool, args)` (commit the call) → `recordOutcome(tool, args, result)` (commit the result). The gate in `batch-executor.ts` calls `check` + `recordCall` synchronously before dispatch (phase 1), then `recordOutcome` after the tool returns (phase 2).

**Two counters, two signals.**
- `getRepeatCount` (args-only) crossing `loopWarningThreshold` ⇒ `warn`: a deduped advisory notice (`formatRepeatNotice`) is injected into the next prompt via `pendingNotice`. `shouldEmitWarning` buckets warnings (`LOOP_WARNING_BUCKET_SIZE`) so the same issue does not spam every step.
- `getNoProgressStreak` (args **and** result hash, interleaving-tolerant) crossing `loopCriticalThreshold` ⇒ `critical`: the gate vetoes the call (synthetic `status:"error"`, `details.deniedReason === "tool-loop"`, see `isLoopVetoResult`) and the tool never runs. The veto instruction (`formatVetoInstruction`) tells the model to change approach.

**Veto exclusion.** Vetoed results are recorded with `vetoed: true` and excluded from `getNoProgressStreak` — otherwise the veto itself would inflate the streak. Consecutive vetoes are counted separately by `breakerVetoStreak`.

**Wandering detector (distinct-spread).** `getRepeatCount` / `getNoProgressStreak` only catch the *same* signature repeating. A model probing endless **distinct** URLs / queries / pages on one tool (e.g. guessing 8 different `os.web.fetch` URLs, or firing 21 search POSTs that differ only in volatile result fields) is a different failure mode. For wandering-prone tools (`isWanderingProneTool`: `os.web.fetch`, `os.http.request`, `browser.*`), `check()` computes `effectiveSpread` — the count of distinct completed `argsHash`es for that tool in the window, plus one when the prospective call introduces a new signature. Crossing `loopWanderingThreshold` ⇒ a `wandering` warn whose notice is an **actionable redirect** (`formatWanderingRedirect`: "stop probing URLs, run a web search or reply best-effort") rather than the repeat advisory. Crossing `loopWanderingEscalation` ⇒ `isWanderingEscalated()` returns true and the gate raises a `breaker` signal — the unique call **is** vetoed and the turn ends gracefully. Bulk reads over distinct files (`os.fs.read`) are deliberately **not** wandering-prone — scanning many files is legitimate work.

**Volatile-stripping in `hashToolOutcome`.** Before hashing a generic (non-shell) result's `details`, `stripVolatile` recursively drops `VOLATILE_RESULT_KEYS` (`timestamp`, `ts`, `date`, `time`, `timeTotal`, `timeTotalSeconds`, `durationMs`, `sizeDownload`, `requestId`/`request_id`, `id`, `traceId`/`trace_id`, `sentAt`, `createdAt`, `deliveredAt`). Without this, per-call timings/sizes (e.g. `timeTotalSeconds`, `sizeDownload` on `os.http.request`) make every result hash unique, so a repeated dead/identical endpoint never registers as a no-progress streak. Mirrors OpenClaw's `stripVolatileSendIds`.

**Breaker → graceful reply.** When `breakerVetoStreak` reaches `loopBreakerVetoStreak` (consecutive-veto path) **or** a wandering loop crosses `loopWanderingEscalation`, the gate raises a `breaker` signal. `AgentLoop` then ends the turn with a forced synthetic `reply` (`formatForcedLoopReply`) recorded as a normal `assistant_reply` turn — `reason: "reply"`, session stays `pending`. **No `loop_failed`, no `ModelError`.** `hashToolOutcome` keys results on error details / shell exit codes / volatile-stripped summary+details so two genuinely different results break the streak.

**Trace.** `loop_detected` events carry `level` (`warn` | `critical` | `breaker`) and `detector` (`generic_repeat` | `no_progress` | `wandering`) — see [src/tracing/trace/trace-event.ts](src/tracing/trace/trace-event.ts).

Pinned by [src/agent/loop-detector.test.ts](src/agent/loop-detector.test.ts), [src/agent/batch-executor.test.ts](src/agent/batch-executor.test.ts) (veto single call / siblings survive / terminal never vetoed / breaker escalation), and [src/agent/agent-loop.test.ts](src/agent/agent-loop.test.ts) ("ends the turn with a graceful reply (not loop_failed) when the breaker trips").

### Out of scope (deferred)

Speculative batching (the runtime guessing that the model "should" have batched and rewriting the next step's prompt), per-class concurrency limits beyond the binary parallel/serial split, dependency analysis (`B uses A`'s output) — the model decides what is independent, the runtime trusts it.

## Layout rules (enforced)

- Feature-based folders under `src/`. Max 2 levels of nesting.
- Each folder has an explicit `index.ts` with **named** exports (no `export *`).
- One responsibility per file. File name describes it exactly. No `utils.ts`, `helpers.ts`, `misc.ts`, `common.ts`.
- Max 300 lines per file. If you cross that, split before adding new code.
- File naming: `kebab-case`, verb-noun for actions (`build-prompt.ts`, `apply-patch.ts`).
- Function naming: `camelCase`, verb-first (`buildPrompt`, `applyPatch`).
- Tests are colocated with source: `build-prompt.test.ts` next to `build-prompt.ts`.
- Config lives in `src/config/` — read it before touching env vars.

## Module map

| Folder | Responsibility |
|---|---|
| `src/config/` | User config file (`<stateDir>/config.json`) + env-based bootstrap, single `getConfig()` |
| `src/sidecar/` | NDJSON protocol + router + typed event schema |
| `src/cli/` | `run`, `index`, `repl`, `tui`, `serve` commands |
| `src/http/` | OpenAI-compatible HTTP API + atomic admin routes for `atomic-agent serve` |
| `src/llm/` | HTTP client for external llama-server + GBNF grammar |
| `src/prompt/` | Prompt builder, stable prefix, token budget. See [PROMPT.md](PROMPT.md) for full anatomy of the stable prefix and variable tail. |
| `src/session/` | Session state + sqlite persistence |
| `src/agent/` | Agent loop + step executor + parallel batch executor (`batch-executor.ts`) + resource-class taxonomy (`tool-resource-class.ts`) + no-progress loop detector |
| `src/tools/` | Tool registry + individual tools. OS tools: `shell.run` (direct-exec by default; routes to a `sh -c` subshell when `needsShellInterpretation` sees shell metacharacters `\| & ; > < $ \`` or a pre-joined command line in `cmd` with empty `args` — the common ENOENT trap where the model puts a whole command line in `cmd`; the guard still inspects a tokenised view of the full line so hardline/dangerous rules match), `fs.read` (w/ `offset`/`limit`/`lineNumbers`), `fs.write`, `fs.list`, `fs.glob`, `fs.locate_project` (fuzzy project-name → directory over bounded sources, see §"Project path resolution"), `fs.grep` (bundled ripgrep), `fs.edit` (atomic string replace), `fs.read_document` (PDF/DOCX/XLSX/RTF/ODT/PPTX/legacy .doc → plain text via pure-JS), `fs.archive.list` / `fs.archive.read_entry` / `fs.archive.extract` (zip/tar/tar.gz/gz via pure-JS; zip-slip + bomb guards), `fs.hash` (md5/sha1/sha256/sha512 streaming), `fs.diff` (unified diff, jsdiff), `fs.patch` (dry-run default, all-or-nothing apply), `fs.watch` (chokidar one-shot, timeout-capped), `git.status` / `git.log` / `git.diff` / `git.show` / `git.blame` / `git.branch` (read-only shell-out with structured parse), `proc.list` / `proc.kill` (ps/tasklist + approval), `http.request` (curl + host allowlist + `config.http.approvalMode`), `web.search` (configured provider; keyless DuckDuckGo by default, SearXNG/Exa/Brave selectable via `web.search.*`; Exa uses `EXA_API_KEY` when present), `web.fetch` (read a known URL as markdown/text), `clipboard.*`, `window.*`, `notify`. |
| `src/compressor/` | Result compressor, log summariser |
| `src/sandbox/` | git worktree + sandboxed command runner |
| `src/approval/` | Approval gate and event wiring |
| `src/tracing/` | Structured logger + metrics + trace recorder (`src/tracing/trace/`) |
| `src/replay/` | Trace-based replay: drift detection + optional LLM re-inference |
| `src/memory/` | Memory fabric: ProfileStore (key/value facts, pinned + contextual) + MemoryStore (FTS5 freeform notes) + async end-of-turn reflection that writes into both. See [MEMORY.md](MEMORY.md). |
| `src/runtime/` | `bootstrap.ts` (assembles `AgentRuntime`) + `turn-controller.ts` (per-session FIFO queue + per-session event hook map; the **only** path into `AgentLoop.runTurn`) + `steering-inbox.ts` (out-of-band per-session mailbox for messages that arrive mid-turn). See §"Concurrency contract" and §"Mid-turn steering". |
| `src/tasks/` | Durable queue of deferred `runTurn` submissions: `TaskStore` (SQLite), `TaskRunner` (drain + retry/backoff), `task-backoff`, `task-schedule` (cron / interval / at resolver). See §"Durable tasks" and §"Background autonomy". |
| `src/scheduler/` | One-process `Scheduler` (single `setInterval`) that polls `TaskStore.listDue` via `TaskRunner.runDue`. The **only** periodic timer in the runtime. See §"Background autonomy". |
| `src/http/route-webhooks.ts` + `webhook-template.ts` + `webhook-session-store.ts` | Generic `POST /api/webhooks/:name` ingress. Always materialises into a `TaskRecord`, never calls `runTurn` directly. See §"Background autonomy". |
| `src/tools/tasks/` | Agent-facing self-scheduling tools (`tasks.schedule`, `tasks.cron`, `tasks.list`, `tasks.cancel`, `tasks.show`), gated by `tasks.agentToolsEnabled`. |
| `src/llm/provider/` | Provider abstraction layer (`LlmProvider` interface) + `LlamaServerProvider` adapter. Text completion stays on `LlamaServerClient.complete` / `completeStream` (legacy `/completion` extension with GBNF + slot ids); vision routes through `LlamaServerProvider.describeImage` against `/v1/chat/completions` with OpenAI-shape `image_url` content blocks. See §"Vision (multimodal input)". |
| `src/llm/fallback/` | Cross-provider circuit breaker (`ProviderFallbackChain`) that wraps the `llmComplete` / `llmCompleteStream` seams and fails over between configured provider ids when the active one is unavailable. Timer-free lazy probe. See §"Provider fallback chain". |
| `src/tools/vision/` | `vision.describe` tool + `loadImageFile` helper. Registered whenever `config.vision.enabled` is true and a provider is constructed; the actual capability gate (`capabilities.vision`) is a dynamic getter that re-reads `ModelProfile` on every check, so vision availability tracks `ModelProfileManager` hot-swaps without a restart. See §"Vision (multimodal input)". |
| `src/channels/telegram/` | `TelegramChannel` (lifecycle + live-control), `inbound-handler` (slash commands + dispatch into `runTurn`), `outbound-sender` (chunked replies + 429 retry), `approval-bridge` (inline-keyboard approvals with 8-min auto-deny), `pairing-mode` (60s window for first-DM owner claim), `telegram-settings` (`config.json` + `.env` persistence), `telegram-bot-factory` (grammy adapter). The **only** module that imports `grammy`. See §"Telegram remote-control channel". |
| `src/tui/telegram/` | TUI "Telegram" tab: `telegram-panel-state` + `telegram-actions` + `telegram-panel-reducer` (pure UI state slice), `tui-telegram-orchestrator` (the only TUI module that touches `runtime.telegramChannel`), `telegram-key-bindings`, and the `telegram-panel` / `telegram-token-prompt` / `telegram-pairing-modal` components. See §"Telegram remote-control channel". |
| `src/mcp/` | MCP (Model Context Protocol) **client** subsystem. `McpManager` (lifecycle for N `McpClient` instances), `mcp-client` (the **only** file that imports `@modelcontextprotocol/sdk` — together with `mcp-sampling-handler` for SDK type shapes), `mcp-tool-adapter` (`McpToolMeta` → `ToolDefinition`), `mcp-resource-class` (per-server trust → `ResourceClass` resolver), `mcp-descriptor-builder` (rare-tier descriptors), `mcp-grammar-builder` (dynamic `mcp-server-tool` GBNF fragment), `mcp-sampling-handler` (forwards `sampling/createMessage` to `LlamaServerClient` with `slotId: -1`), `mcp-resource-tools` + `mcp-prompt-tools` (aggregate read-only `mcp.{resource,prompt}.*` tools dispatching by `server` arg). See §"MCP client". |

## Secrets and process environment

Skills that need API keys (Notion, GitHub, etc.) read them from `process.env`. The agent populates `process.env` once at bootstrap from the optional file `<stateDir>/.env` via `loadDotenvFromStateDir` in [src/config/load-dotenv.ts](src/config/load-dotenv.ts), invoked from [src/config/load-config.ts](src/config/load-config.ts) immediately after `stateDir` is resolved and before `ensureUserConfigFileSync`. Shell-exported variables always win — the loader only sets a key when it is currently unset or empty. Missing file is a silent no-op. The parser is deliberately tiny (`KEY=VALUE` per line, optional surrounding quotes, `#` comments, blank lines; no interpolation, no `export ` prefix, no multiline values) so we do not depend on the `dotenv` package.

The startup read is defensive about transient locks (#59). A failing read of an existing `.env` is retried up to 3 attempts with 50/150 ms backoff when the errno code is `EPERM`, `EACCES`, `EBUSY`, or `EAGAIN` (the family Windows antivirus and sync clients surface; on POSIX an `EACCES` is almost always permanent and simply costs one ~200 ms loop before the warning). Any other code fails fast, and a missing file (`ENOENT`) stays the silent no-op above. The load outcome travels on the runtime config as `config.dotenv` (`DotenvLoadResult`: the `.env` path, `exists`, `loaded`/`skipped` variable names, and `error` carrying the errno code plus attempt count; values never cross this surface, and parse diagnostics name line numbers, not line content). A failure that survives the retries is printed to stderr by the loader and repeated by the TUI as a warn-variant system chat message with platform-specific guidance, because the stderr line scrolls away before the alt screen takes over. On the write side, after `setDotenvKey` tightens the `.env` ACL via [src/config/windows-acl.ts](src/config/windows-acl.ts) (`icacls /inheritance:r /grant:r`), it probe-reads the file as the current process and rolls the ACL back with `icacls /reset` when the probe fails, so a wrong-principal grant cannot leave behind a file the agent itself can no longer read. Pinned by [src/config/load-dotenv-retry.test.ts](src/config/load-dotenv-retry.test.ts) (retry-then-success, persistent-failure warning, fail-fast codes, silent ENOENT), [src/config/load-config.test.ts](src/config/load-config.test.ts) ("carries the .env load outcome as config.dotenv" / "reports an unreadable .env in config.dotenv.error without throwing"), and [src/config/windows-acl.test.ts](src/config/windows-acl.test.ts) (tighten/probe/rollback).

There is currently **no per-tool env filtering**. `runCommand` in [src/sandbox/command-runner.ts](src/sandbox/command-runner.ts) inherits the full agent `process.env`, so every spawned subprocess (`os.shell.run`, `runSkillScript`, the managed `llama-server`, future MCP servers) sees every variable loaded from `.env`. Tightening this — per-skill `env_vars` whitelist + safe-baseline filtering (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `XDG_*`) — is tracked as a separate effort and pinned by no tests yet. Do not assume isolation when designing new skills that handle highly sensitive secrets; document the shared-env reality in the skill's `SKILL.md` instead.

## Build & test

```bash
npm install
npm run lint    # tsc noEmit
npm test        # vitest run
npm run build   # compile to dist/
```

The CLI entry is `src/cli/index.ts`; the sidecar entry is `src/sidecar/main.ts`.

## LLM provider abstraction

Text completion, vision, embeddings, and sub-calls route through plugin-registered providers instead of calling `LlamaServerClient` directly from the agent loop.

### Registry and transport

- **`ProviderRegistry`** ([src/llm/provider/registry/provider-registry.ts](src/llm/provider/registry/provider-registry.ts)) — `registerProviderKind(kind, factory)` + `fromConfig(config)`. Built-in kinds self-register in [register-built-in-providers.ts](src/llm/provider/registry/register-built-in-providers.ts): `llama-server`, `openai-compatible`, `openrouter`.
- **`LlmProvider`** ([src/llm/provider/llm-provider.ts](src/llm/provider/llm-provider.ts)) — `complete`, `completeStream`, `describeImage`, `health`, `close`, `capabilities`, optional `toolCallAdapter` + `streamConsumer`.
- **`toolTransport`** — `grammar` (GBNF on llama-server) vs `native_tools` (OpenAI `tools` / `tool_calls`). Resolved by `resolveActiveToolTransport` from `config.llm.toolTransport` (`auto` follows the active provider).
- **Name escape** — qualified tool names use `__` for dots (`os.fs.read` → `os__fs__read`) in [openai-tool-call-adapter.ts](src/llm/provider/openai/openai-tool-call-adapter.ts). `reply` / `finish` are synthetic OpenAI functions alongside registry tools.

### Bootstrap wiring

[src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) constructs `providerRegistry`, wires `llmComplete` / `llmCompleteStream` through `providerRegistry.activeText`, and passes `toolTransport` + `toolCallAdapter` into `AgentLoop`. When `capabilities.supportsSlotAffinity === false` (cloud), step execution uses `slotId: -1`.

Optional `config.llm` (v24) lists `providers[]`, `activeTextProvider`, `activeEmbeddingProvider`, `toolTransport`, `userModels[]`, `costTracking`. When omitted, `resolveLlmConfig` synthesizes a single `local-llama` entry from `localModels.*` — **local-only installs stay byte-stable**.

### Hot-swap

`ProviderRegistry.setActive(id)` / `swapActive(id)` closes the previous provider and switches the active text backend without process restart. TUI **Providers** tab ([src/tui/providers/](src/tui/providers/)) is the only surface that calls this seam.

### Locked invariants

1. **Local llama-server path unchanged when no cloud provider is active.** Grammar, slots, and GBNF tests remain the reference behaviour.
2. **Stable prefix untouched.** Cloud providers receive the same monolithic prompt string; no chat-message refactor in v1.
3. **One inference per step survives.** `toolCallsToBatch` produces the same `ToolCallBatch` shape as `parseToolCalls`.
4. **`atomic-agent serve` never proxies upstream.** HTTP `/v1/chat/completions` always funnels into `runtime.runTurn`.
5. **Plugin registration only.** New provider kinds call `registerProviderKind`; no central switch statements.
6. **Every default tool ships a structured `argsJsonSchema`.** `ToolDescriptor.argsJsonSchema` is consumed exclusively by `descriptorsToOpenAiTools` ([openai-tool-call-adapter.ts](src/llm/provider/openai/openai-tool-call-adapter.ts)) to populate `function.parameters` on the OpenAI `tools` payload. Without it, cloud providers fall back to `{ type: "object", additionalProperties: true }` — which is what we shipped originally and what enabled the `os.shell.run` silent-arg-drop bug (model double-serialised `args` into a JSON string, the provider accepted it, the tool coerced the non-array to `[]` without warning, the model never learned). The canonical map lives in [src/prompt/default-tool-args-schemas.ts](src/prompt/default-tool-args-schemas.ts); it is merged into `DEFAULT_TOOL_DESCRIPTORS` via `attachDefaultArgsJsonSchema`. MCP descriptors carry the server's `inputSchema` verbatim through the same field. Adding a new tool **requires** an entry in `DEFAULT_TOOL_ARGS_SCHEMAS` (pinned by [src/prompt/default-tool-args-schemas.test.ts](src/prompt/default-tool-args-schemas.test.ts) "attaches a schema to every default descriptor that has one registered"). Local llama-server with GBNF does **not** consume this field — the grammar already constrains the shape.
7. **`os.shell.run` rejects non-array `args` structurally.** A non-array, non-JSON-array-string `args` value now returns `{ status: "error" }` instead of silently dropping the operator's intent. JSON-stringified arrays (the cloud `native_tools` double-serialise pattern) are auto-coerced back to `string[]`. Pinned by [src/tools/os/os-tools.test.ts](src/tools/os/os-tools.test.ts) ("returns a structured error when `args` is an object" / "is a scalar string" / "recovers a JSON-stringified array `args`").

### Embeddings

Symmetric **`EmbeddingProviderRegistry`** ([src/memory/embeddings/embedding-provider-registry.ts](src/memory/embeddings/embedding-provider-registry.ts)) with `OpenAiEmbeddingProvider` / `OpenRouterEmbeddingProvider` for `POST /v1/embeddings`. Hybrid recall degradation contract unchanged.

## llama-server modes

`atomic-agent` supports two modes for the llama-server backend (`config.llama.mode`):

- `external` (default) — user runs `llama-server` out-of-band; runtime reads the URL from `config.llama.url` (env fallback `ATOMIC_AGENT_LLAMA_URL`).
- `managed` — `atomic-agent` downloads the llama.cpp binary from `AtomicBot-ai/atomic-llama-cpp-turboquant` GitHub Releases into `<stateDir>/llamacpp/backend/` and GGUF models into `<stateDir>/llamacpp/models/<id>/`. The server is **not** spawned by the runtime; operators control lifecycle via `atomic-agent llama start|stop|status|update`.

**Invariant (preserved):** the agent runtime never starts a `llama-server` process. It only connects. Managed-mode lifecycle lives entirely in the `atomic-agent llama` CLI so runtime code paths stay single-mode.

When the server is unreachable, the sidecar emits an `llm_unavailable` event with the current mode and a hint. In managed mode the hint points at `atomic-agent llama start`; in external mode it points at checking `llama.url` / `ATOMIC_AGENT_LLAMA_URL`.

## Current memory model

Today the runtime persists session-scoped state only:

- `SessionState.turns[]` for the full multi-turn transcript
- `knownFacts[]` for compact session facts
- `loadedSkills[]` for skill bodies loaded via `skill.view`
- `loadedTools[]` for full rare-tool descriptors loaded via `tool.view` (see §"Rare tools: tool.view and loaded-tools")
- `worldSnapshot` for compressed browser state

`SessionState.turns[]` stores the full history in memory and in the sessions DB unchanged. Prompt-time compression happens only at the `buildPrompt` boundary via `packConversation`: older turns get folded into a single deterministic `summary: N older turns dropped (...)` line so the variable tail of the prompt stays bounded without losing traceability. The visible tail always includes the latest `user` turn.

Prompt-section caps live in the config:

- `agent.tokenBudget` — compact ceiling for the upper prompt: stable prefix plus a shared budget for `### loaded-skills` + `### session-facts` (known facts and loaded skill bodies).
- `agent.conversationMaxTokens` (default 32000) — safety-net cap for the `### conversation` section; typical sessions stay well under it.
- `agent.worldSnapshotMaxTokens` (default 8000) — safety-net cap for the `### world` section; the snapshot is already compressed by `aria-compressor`, so this only clips pathological cases with a `[truncated]` marker.

At bootstrap `LlamaServerClient.fetchProps()` reads the model's physical `n_ctx` (from `default_generation_settings.n_ctx`, with a root `n_ctx` fallback) and stores it on `ModelProfile.contextWindow`. `buildPrompt` then clamps the effective conversation cap to the actual available room so the prompt cannot overflow llama-server regardless of how large the user-configured cap is. If llama-server is restarted with a different `n_ctx`, restart the runtime.

There is currently no dedicated workspace-memory, retrieval, embeddings, or resource-summary subsystem in `src/`. Do not describe those modules as implemented unless they are added to the codebase first.

## Memory fabric

A three-channel cross-session memory subsystem lives in [src/memory/](src/memory/) and exposes itself to the agent via six tools in [src/tools/memory/](src/tools/memory/). The full description is in [MEMORY.md](MEMORY.md); this section is the engineering summary. The v2 roadmap (paths B+C+E+P: reactive graph, periodic consolidation, vote curation, procedure templates) lives in [MEMORY_FABRIC_V2.md](MEMORY_FABRIC_V2.md) and rolls out in strict-gated phases. Plan-level deviation from doc §9 invariant 2: v2 pays the stable-prefix KV-cache invalidation **twice** (once when `### lessons` lands in phase 5, once when `### procedures` lands in phase 7b) instead of the doc's intended single combined release — the strict-gates rollout requires evaluation windows between the two prefix-touching phases.

### Memory-v2 phase 1B — hybrid FTS5 + embedding recall (opt-in)

Lives in [src/memory/embeddings/](src/memory/embeddings/) and is **off in config until the operator enables it from the TUI Models tab** (download + start embedding model). When turned on, it adds a second `llama-server` process dedicated to `/embedding` requests and blends BM25 hits with cosine similarity over a `memory_embeddings` table (schema v5).

**Two-daemon lifecycle.** `llama-server` cannot serve `/completion` and `/embedding` from the same process — the `--embeddings` flag forces pooling-only mode. The CLI therefore manages two parallel daemons:

- **Chat daemon** (primary): existing flow, port `localModels.managed.port` (default 19091), pid `<stateDir>/llamacpp/llama-server.pid`.
- **Embedding daemon** (optional secondary): new flow, port `localModels.embeddings.port` (default 19092), pid `<stateDir>/llamacpp/llama-embed.pid`. Built by `buildEmbeddingServerArgs` with `--embeddings --pooling <kind> --ctx-size 2048` and a dedicated embedding model GGUF (`nomic-embed-text-v1.5` ~84 MB, `bge-small-en-v1.5` ~33 MB — both in `EMBEDDING_MODELS_CATALOG`).

`atomic-agent models start` calls `startChatAndEmbeddingDaemons` which is **atomic in the chat-primary sense**: if the chat daemon fails to start, the function rejects and the embedding daemon is never spawned. If the embedding daemon fails (model missing, port collision, daemon refuses health) the chat daemon stays up and the call returns `{ embedding: { error } }` — the runtime then degrades to FTS5-only recall and logs a warning. `atomic-agent models stop` always tries to kill **both** pid files, so half-broken states resolve in a single command. New CLI subcommands: `models list-embeddings`, `models pull-embedding <id>`, `models use-embedding <id>|--disable`.

**Graceful degradation contract.** Every layer that touches the embedding daemon is non-throwing:

- `LlamaEmbeddingClient.embed` wraps every transport / shape / dim mismatch failure as a typed `EmbeddingUnavailableError` so callers can branch without sniffing messages.
- `EmbeddingWriter.writeFor` returns `boolean` and **never throws** — failures land in the `agent.memory.embeddings.fallback_to_fts5` counter (tagged by `reason`) and the row stays FTS5-only-recallable.
- `recallHybrid` short-circuits to BM25-only when the embedding client / store is null, when `embed()` fails, or when the corpus exceeds `memory.embeddings.bruteForceCeiling` (default 200). The overflow case emits `agent.memory.embeddings.brute_force_overflow` so dashboards spot when the JS-side brute-force cosine has outgrown its budget — sqlite-vec / ANN migration is the deferred follow-up.
- Bootstrap probes the embedding daemon's `/health` once with a short timeout; failure flips the runtime to text-only without aborting startup. The probe outcome is recorded in `agent.memory.embeddings.daemon_health` (`ok | unreachable | disabled`).

**Storage.** Schema v5 adds `memory_embeddings (memory_id, model, dim, embedding BLOB, created_at)` keyed by `(memory_id, model)` so a single corpus can host multiple model versions during an A/B rollout. `embedding` is raw Float32 little-endian (`dim * 4` bytes). `FOREIGN KEY ON DELETE CASCADE` from `memories(id)` cleans up automatically on `MemoryStore.remove` — `foreign_keys=ON` is set on the connection at construction time. Stores are wired in bootstrap via `MemoryStore.attachEmbeddings({ writer, store })`, which is intentionally late-bound: `MemoryStore` owns the SQLite handle, `EmbeddingStore` opens against the same handle once the daemon is confirmed healthy.

**Read/write paths.** Synchronous `MemoryStore.store()` kicks off a fire-and-forget embedding write (zero latency penalty for existing callers); `MemoryStore.storeAsync()` is the awaited sibling for tests that need the row to be hybrid-recallable on the next turn. `MemoryStore.recallHybridAsync()` is the new public entry point — it always goes through `recallHybrid` and is observably identical to the legacy `recall()` when embeddings are not attached. `createDefaultMemoryContextProvider` was switched to the async variant; the `MemoryContextProvider` interface already accepted `Promise<MemoryContext>`.

**Locked invariants.** Pinned by [src/memory/embeddings/embedding-client.test.ts](src/memory/embeddings/embedding-client.test.ts), [src/memory/embeddings/embedding-store.test.ts](src/memory/embeddings/embedding-store.test.ts), [src/memory/embeddings/hybrid-recall.test.ts](src/memory/embeddings/hybrid-recall.test.ts), [src/memory/memory-schema.test.ts](src/memory/memory-schema.test.ts), [src/local-llm/daemon-lifecycle.test.ts](src/local-llm/daemon-lifecycle.test.ts):

1. **Two-daemon separation is structural, not optional.** `llama-server --embeddings` forces pooling-only mode; a single instance cannot serve both `/completion` and `/embedding`. Anyone adding embedding usage MUST go through the secondary daemon's URL.
2. **Embedding writes never block the agent loop.** `MemoryStore.store()` is synchronous; the embedding write is fire-and-forget. Tests that need determinism call `storeAsync()`.
3. **Failure paths are observability-only.** Bootstrap, recall, write — none of them throw on embedding-daemon outages. Every degradation is a metric counter, never a status-`failed` turn.
4. **Cosine path skips on overflow.** When `countByModel(model) > bruteForceCeiling`, cosine is **not** computed; FTS5-only result returns and `brute_force_overflow` increments. This is the signal to wire `sqlite-vec` or trim the corpus.
5. **FK cascade is load-bearing.** `memories.remove(id)` must wipe the matching `memory_embeddings` row in the same transaction; the test `cascades delete from memories -> memory_embeddings` pins this.
6. **Config gates everything.** `memory.embeddings.enabled=false` OR `localModels.embeddings.enabled=false` OR `localModels.embeddings.modelId=null` ⇒ no second daemon, no embedding writes, no hybrid recall. Bootstrap never constructs an `EmbeddingClient` against an absent daemon.

**Configuration.** Added in user config v12 — older files transparently migrate with both blocks disabled.

- `memory.embeddings.enabled` (default `false`; TUI sets `true` when the embedding daemon is running — see `persistEmbeddingHybridRecall` + `LocalModelsOrchestrator.reconcileHybridRecallFromDaemon`).
- `memory.embeddings.fts5Weight` / `vectorWeight` (defaults `0.5` / `0.5`, both in `[0, 1]`).
- `memory.embeddings.bruteForceCeiling` (default `200`).
- `localModels.embeddings.enabled` (default `false`; flipped by TUI pull/activate/`E`) — must be `true` for the second daemon to be considered at startup.
- `localModels.embeddings.modelId` (default `null` — must be one of `EmbeddingModelId` once chosen in TUI).
- `localModels.embeddings.port` (default `19092`).

**Out of scope (deferred to follow-up).** `sqlite-vec` virtual table integration (the JS brute force handles current corpus sizes; sqlite-vec graduates the schema without touching `EmbeddingStore` callers), ANN indexes, cross-model query embedding fallback (when the active model changes, the existing rows under a different `model` are simply skipped — there is no auto-reembed sweep yet), embedding-side reflection (the writer is only invoked by `MemoryStore.store`; reflection's own writes happen through the same path so they get embedded too, but there is no dedicated "embed everything" CLI command). All deferred items keep the wire-shape of `memory_embeddings` stable so no future migration is forced.

### Memory-v2 phase 2 — reactive link graph (opt-in)

Lives in [src/memory/links/](src/memory/links/) and is **enabled by default** (`memory.links.enabled=true`, config v22). It gives memories a typed, directed graph layer that is grown by an end-of-turn LLM sub-call (`link-generator`) and consumed by `MemoryContextProvider` as BFS expansion on top of the BM25/cosine hits.

**Storage.** Schema v6 adds:

```
memory_links (
  from_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  weight  REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
)
```

Composite PK allows multiple link kinds between the same pair (a note can both `RELATES_TO` and `CONTRADICTS` another note). FK cascade fires on **either side**, so `MemoryStore.remove(id)` automatically wipes every edge touching the removed row — no orphan links. `kind` is bounded by `LINK_KINDS = { RELATES_TO, CAUSED_BY, REFERENCES, CONTRADICTS, DUPLICATES, SUPERSEDES }`; `LinkStore.add` and the parser both reject anything outside this set. Self-loops are rejected at insert time. Indexes `idx_memory_links_to` (reverse direction) and `idx_memory_links_kind` exist so BFS can walk in either direction in O(deg).

**BFS expansion.** `LinkStore.expand(seedIds, { depth, maxExpanded, kinds? })` walks **outgoing + incoming** edges at each hop so the recall layer does not need the LLM to author symmetric edges. Returns ids in BFS order with seeds excluded; deduplicated. Depth is clamped to `[1, 3]` to bound BFS fan-out; `maxExpanded` (default 50, runtime-config default 12) hard-caps the result so a hot node cannot blow up the recall set. Empty seed ⇒ empty result.

**link-generator reflection sub-call.** A standalone runner in [src/memory/links/link-generator-runner.ts](src/memory/links/link-generator-runner.ts) that fires **after** the main reflection runner returns. Composition is wrapped by `createLinkAwareReflectionRunner` — the agent loop still calls `reflectionRunner.reflect(input)`; the decorator runs base reflection first, then materialises `input.recalledMemoryIds` (added to `ReflectionInput` in phase 2 — populated from `state.recalledNotes` in `agent-loop`) into `{id, body}` candidates via `MemoryStore.get(id)` and fires the link-generator.

Anti-feedback-loop guard (mirrors phase 7a invariant 18 from MEMORY_FABRIC_V2.md §13.7.4): the parser drops every LINK whose endpoints are not in the surfaced-id allowlist for this turn. Without it, a runaway model could connect arbitrary ids and pollute the graph permanently. Self-loops, malformed lines, unknown kinds, and duplicate triples are all silently filtered — one bad line never invalidates the rest of the batch.

**Read-side integration.** `createDefaultMemoryContextProvider` takes an optional `links` block; when `memory.links.enabled=true` it calls `linkStore.expand(recalledBaseIds, …)`, hydrates the expanded ids via `MemoryStore.get`, and folds them into `recalled` after the base hits so BM25/cosine ranking is preserved at the head. The `### memory-index` section then dedupes against the expanded set. When `links` is omitted, the provider is byte-identical to phase 1B.

**Slot affinity (cross-phase invariant 2).** `LinkGeneratorRunner` rides the **same** dedicated reflection slot (`slotManager.reserveReflectionSlot()`) as the base reflection runner. The main agent slot's KV cache is never touched. When only one slot is available, both runners fall back to `slotId: -1` (no cache reuse) — still safe because the main slot is untouched.

**Locked invariants.** Pinned by [src/memory/links/link-store.test.ts](src/memory/links/link-store.test.ts), [src/memory/links/link-generator-parser.test.ts](src/memory/links/link-generator-parser.test.ts), [src/memory/links/link-generator-runner.test.ts](src/memory/links/link-generator-runner.test.ts), [src/memory/memory-schema.test.ts](src/memory/memory-schema.test.ts), [src/memory/memory-context-provider.test.ts](src/memory/memory-context-provider.test.ts):

1. **FK cascade on both sides.** Deleting either endpoint memory wipes the link in the same transaction. No orphan rows possible.
2. **Self-loops are rejected.** `LinkStore.add({fromId: a, toId: a, …})` throws `LinkValidationError`; the parser drops them silently. Self-loops add zero recall signal and break BFS termination guarantees.
3. **`link-generator` rides the reflection slot.** Cross-phase invariant 2 — never the main agent slot. No new `setInterval`s introduced; the runner is fire-and-forget after the agent reply, identical pattern to `ReflectionRunner`.
4. **Allowlist gates every persisted edge.** Parser drops links whose endpoints are not in the per-turn surfaced-id set. Without this guard the graph could grow edges between memories the LLM never saw — a feedback-loop hazard pinned ahead of phase 7a.
5. **Recall stays byte-identical when `memory.links.enabled=false`.** `createDefaultMemoryContextProvider` short-circuits without touching `LinkStore` when the optional block is missing. Phase 1B test snapshots remain valid.
6. **BFS is bounded.** Depth clamped to `[1, 3]`, `maxExpanded` caps the result, BFS expands both directions. Hot-node fan-out cannot blow up the recall set.
7. **`autoGenerate=false` still allows manual graph growth.** With `enabled=true; autoGenerate=false`, recall expansion works but the link-generator LLM call is skipped — useful when external tooling (or a future `memory.links.add` tool, deferred) is the only graph writer.
8. **Multi-hop demo lives in the test suite.** `src/memory/memory-context-provider.test.ts > "phase 2: expands recalled via link graph when enabled (multi-hop demo)"` pins the synthetic acceptance from the execution plan — only the seed matches the BM25 query, and `A → B → C` link traversal surfaces both downstream notes.

**Configuration.** Added in user config v13 — older files transparently migrate with `memory.links` populated from defaults (everything disabled).

- `memory.links.enabled` (default `true`, config v22) — master switch for both recall expansion and link generation.
- `memory.links.autoGenerate` (default `true`) — fire the link-generator after reflection. Set to `false` to keep the schema + expansion machinery without the extra LLM round-trip.
- `memory.links.expansionDepth` (default `1`) — BFS depth on recall. Clamped to `[1, 3]`.
- `memory.links.maxExpanded` (default `12`) — hard cap on expanded-id count per recall turn.
- `memory.links.maxLinksPerCall` (default `4`) — hard cap on persisted edges per link-generator call.
- `memory.links.minCandidates` (default `2`) — skip the LLM call when the surfaced set has fewer than this many ids.
- `memory.links.generatorTimeoutMs` (default `8000`) — hard timeout for the link-generator LLM call.

**Metrics.** All env-only, exported from [src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- `agent.memory.link_generator` (counter, tagged by `outcome ∈ {ok, none, skipped, aborted, timeout, failed}`).
- `agent.memory.link_generator.duration_ms` (histogram).
- `agent.memory.links_written` (counter, tagged by `source ∈ {link_generator, tool, reflection}`).
- `agent.memory.link_expansion.hits` (counter, tagged by `expanded` bucket + `depth`).

**Out of scope (deferred).** Agent-facing `memory.links.add` / `memory.links.list` tools (the LLM can still grow the graph implicitly via the link-generator; explicit tool access is deferred until a use case actually demands it), weighted BFS ordering beyond the current weight-tiebreaker, graph-aware reflection (the link-generator currently consumes only `recalledMemoryIds`; consuming the **graph neighbourhood** of those ids during reflection extraction is a follow-up), and a CLI debugger (`atomic-agent memory links show`) for graph inspection. Neighbour-evolver landed in phase 3 (see below).

### Memory-v2 phase 3 — neighbor-evolver (opt-in)

A reactive metadata-refinement layer that lets a new reflection turn enrich the `tags` of **existing** memories without ever touching their `content`. Modules in [src/memory/evolution/](src/memory/evolution/) + the grammar/parser/runner pieces inside [src/memory/reflection/](src/memory/reflection/). Default disabled; opt in via `memory.evolution.enabled = true` after phase 2 is live in your config.

**Grammar.** `REFLECTION_GRAMMAR` in [reflection-grammar.ts](src/memory/reflection/reflection-grammar.ts) gained an `evolve` alternative on `entry`:

```
entry  ::= set | note | evolve
evolve ::= "EVOLVE #" digits " [tags=" taglist "]" "\n"
```

A bounded grammar shape (`digits = [0-9]+`, `taglist ::= tag ("," tag){0,9}`) keeps malformed completions cheap and the cap deterministic. Touching the grammar invalidates the **reflection slot's** KV cache for one call; the main agent slot is unaffected.

**Parser.** [reflection-parser.ts](src/memory/reflection/reflection-parser.ts) extracts EVOLVE lines into `ReflectionEvolve { targetId, addTags }`. Hardened: empty tag lists are dropped, non-positive ids rejected, malformed lines silently skipped, duplicate EVOLVE entries for the same `targetId` collapse to last-writer-wins. Lower-cases tags, drops invalid tokens, caps tag count to 10.

**Store-level surface.** `MemoryStore.evolveTags(id, addTags, { leaseMs, now? })` in [memory-store.ts](src/memory/memory-store.ts) is the single mutation entry point. The signature **does not accept** a content delta — the append-only invariant on `MemoryEntry.content` is defended at both the runner level (post-parser, content is not even extracted from the LLM line) and the store level (no SQL path can write `content`). Returns a discriminated `EvolveTagsResult`:

- `applied`             — tags grew, `updated_at` bumped.
- `skipped_lease_held`  — `consolidating_at` lease is fresh, B↔C contention guard fires.
- `skipped_no_change`   — every proposed tag was already present, `updated_at` is **not** bumped (preserves legacy FIFO eviction ordering).
- `missing`             — target row no longer exists.

Companion lease helpers: `acquireConsolidationLease(id, leaseMs, now?)` (single-writer atomic check+stamp via SQL `WHERE consolidating_at IS NULL OR consolidating_at <= ?`), `releaseConsolidationLease(id)`, `getConsolidatingAt(id)`. Phase 5's consolidator will be the only `acquire` caller; phase 3 only **reads** the lease through `evolveTags`. The `consolidating_at` column itself landed dormant in v4 (phase 1A migration) so there is **no schema change** in phase 3.

**Runner.** `NeighborEvolver` in [neighbor-evolver.ts](src/memory/evolution/neighbor-evolver.ts) is a non-LLM, fire-safe post-parser writer:

- Enforces `maxPerWrite` (default `2`) as a hard cap; overflow → `skipped_cap_hit` (the dropped directives still record metrics).
- Honours an optional `allowlist` (a `Set<number>` of surfaced ids for the current turn) — directives whose `targetId` is **not** in the set are dropped with `skipped_not_in_allowlist`. This is the anti-feedback guard (same idea as the link-generator phase 2's allowlist).
- Wraps `MemoryStore.evolveTags` and folds `MemoryValidationError` → `skipped_invalid`. Throws nothing.
- Emits one of seven structured outcomes per directive, each tagged through `AgentMetrics.recordMemoryEvolution`.

**Reflection wiring.** `ReflectionRunnerDeps.neighborEvolver?` (optional) in [reflection-runner.ts](src/memory/reflection/reflection-runner.ts). When present, the runner applies parsed `EVOLVE` directives **after** SET + NOTE writes (so a NOTE created earlier in the same completion is never the target of its own EVOLVE — the surfaced-id allowlist already excludes brand-new rows). The runner reads `input.recalledMemoryIds` (already plumbed in phase 2) and turns it into the allowlist passed to the evolver. Sequencing inside `ReflectionRunner.runOne` is now:

```
parse  →  write SET  →  write NOTE  →  link-generator (phase 2)  →  neighbor-evolver (phase 3)
```

No new LLM call. Phase 3 is pure post-parser bookkeeping on top of the same reflection completion. Bootstrap constructs the evolver only when `memory.evolution.enabled === true` and threads it into `buildReflectionRunner`.

**Locked invariants** (pinned by [src/memory/memory-store-evolve.test.ts](src/memory/memory-store-evolve.test.ts), [src/memory/evolution/neighbor-evolver.test.ts](src/memory/evolution/neighbor-evolver.test.ts), [src/memory/reflection/reflection-parser.test.ts](src/memory/reflection/reflection-parser.test.ts)):

1. **`content` is byte-stable across N evolve calls.** Cross-phase invariant 5 from MEMORY_FABRIC_V2.md §13.7.7. Pinned by both `MemoryStore.evolveTags` (`preserves content byte-stable across N evolves`) and `NeighborEvolver` (`invariant 5 — content byte-stable across N evolve calls`). No SQL path on the evolve surface ever writes `content`; the LLM grammar never carries it either.
2. **B↔C lease honoured.** `evolveTags` skips when `consolidating_at IS NOT NULL AND (now - consolidating_at) <= leaseMs`. Stale leases (`elapsed > leaseMs`) are ignored — the phase-5 consolidator is expected to release on success, but a crashed consolidator can never permanently freeze a row.
3. **Allowlist filters before applyOne.** A directive whose `targetId` is not in `input.recalledMemoryIds` never reaches `MemoryStore`. Pinned by `filters by allowlist when provided`.
4. **`maxPerWrite` cap is hard.** Directive `N+1` and beyond never call `evolveTags`. Excess is counted under `skipped_cap_hit` so dashboards can spot models that routinely propose more evolves than the budget allows.
5. **Tag-cap overflow keeps existing tags.** When the target already has `MEMORY_MAX_TAGS` (16) tags, every proposed addition is dropped silently — the store returns `skipped_no_change` and existing tags win. Pinned by `does not write past MEMORY_MAX_TAGS`.
6. **`updated_at` is not bumped on `skipped_no_change`.** Legacy FIFO eviction (`memory.eviction.utilityWeighted=false`) keeps its expected ordering when an evolve is a no-op.
7. **`enabled=false` is the default.** Older configs auto-migrate to v14 with `memory.evolution.enabled = false`; parser still recognises EVOLVE but the runner silently drops directives because `neighborEvolver` is `undefined`. Flip the flag to opt in.
8. **Schema unchanged.** Phase 3 reuses `consolidating_at` (added dormant in v4 / phase 1A). No new tables, no new migration step; `MEMORY_SCHEMA_VERSION` stays at `6`.

**Configuration.** Added in user config v14 — older files transparently migrate with `memory.evolution` populated from defaults (everything disabled).

- `memory.evolution.enabled` (default `true`, config v21) — master switch. Off ⇒ no evolver constructed, EVOLVE lines parsed and dropped.
- `memory.evolution.maxPerWrite` (default `2`) — hard cap on applied directives per reflection turn.
- `memory.evolution.leaseMs` (default `60000`) — B↔C lease window in ms.

**Metrics.** Two counters in [src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- `agent.memory.evolution.applied` (counter, tagged by `session_id`).
- `agent.memory.evolution.skipped` (counter, tagged by `session_id` + `reason ∈ {lease_held, no_change, not_in_allowlist, cap_hit, missing, invalid}`).

The dual-counter shape matches the scorecard's §3.A.4 (`applied ≥ 1`) and §3.B.2 (`skipped{reason=lease_held} ≥ 1`) asserts.

**Out of scope (deferred).** `context` column on `memories` (the doc's `EVOLVE [context=...]` branch — phase 3 sticks to tags-only, which is what the scorecard tests; adding `context` is a separate schema change), automatic neighbour discovery on writes (today the LLM proposes EVOLVE targets explicitly — discovery-driven evolution depends on phase 5's clustering pass), and an agent-facing `memory.notes.evolve` tool. The consolidator-side `acquireConsolidationLease` write path lands in phase 5; phase 3 only **reads** the lease.

### Memory-v2 phase 4 — bi-temporal ProfileStore

`profile_facts` no longer overwrites on conflict. Every `ProfileStore.set` produces a **new row** and the previous active row for the same key is flipped into the supersession chain inside one SQLite transaction. The renderer (`### profile`) keeps showing only the active row; the chain is exposed to the agent via the new `memory.profile.history` tool.

**Schema v6 → v7** in [memory-schema.ts](src/memory/memory-schema.ts). The migration renames the legacy `profile_facts` to `profile_facts_legacy`, creates the v7 shape (`id INTEGER PRIMARY KEY AUTOINCREMENT`, `valid_from`, `superseded_by`, `supersedes`, `created_at`, `updated_at`), copies every legacy row into the v7 table with `valid_from = legacy.updated_at` and `superseded_by = NULL` (preserving `pinned` + `keywords`), then drops the legacy table. The migration is idempotent; restarting after a successful v7 boot is a no-op. Active-row uniqueness is enforced by the **partial unique index** `idx_profile_active_key ON profile_facts(key) WHERE superseded_by IS NULL` — the storage-layer guard for MEMORY_FABRIC_V2.md cross-phase invariant 6.

**Store-level surface** ([profile-store.ts](src/memory/profile-store.ts)):

- `set(key, value, opts?)` — always inserts a new row. When an active row for `key` exists it gets flipped in the same transaction. Because SQLite's partial unique index is **immediate, not deferred**, the writer first stamps the parent's `superseded_by` with a sentinel self-pointer (`= id`) so the partial index releases the active slot, then inserts the new row, then patches the parent's `superseded_by` to the real `newId`. The intermediate self-pointer is never visible outside the transaction. Returns a `ProfileFact` with `id`, `validFrom`, `supersedes`, `supersededBy` populated.
- `get(key)` / `list()` — return active rows only (`superseded_by IS NULL`).
- `getById(id)` — returns any row regardless of supersession (used by history walks).
- `history(key)` — returns the full chain in `valid_from ASC, id ASC` order. The active row, when present, is the last entry. Cross-key supersession chains are **not** traversed automatically — `history` is per-key on purpose so the rendered timeline matches the column header the user sees in `### profile`.
- `remove(key)` — deletes the **active** row only. Historical (superseded) rows are kept on disk so `history(key)` keeps working. The `superseded_by` self-pointer is a **soft pointer** (no FK constraint) precisely so this deletion never cascades into the historical chain.

**Cross-key supersession.** When the LLM emits `SET full_name=Alex [supersedes=name]`, the parser captures `supersedes: "name"` on the `ReflectionFact`. The reflection runner threads this through as `set(...).supersedesKey`; the store then flips both the same-key active row (if any) **and** the cross-key `name` active row to the new row. Same-key supersession always wins for the `supersedes` back-pointer payload; cross-key parents become superseded but their `supersedes` column stays `NULL` (they were not themselves replacing anything). Pinned by `profile-store-bitemporal.test.ts` ("cross-key supersession via supersedesKey opt flips the source row").

**Parser markers.** [reflection-parser.ts](src/memory/reflection/reflection-parser.ts) `extractSetMarker` was extended with two new clauses, both still semicolon-separated inside the existing trailing `[...]`:

- `supersedes=KEY` — extracts a cross-key hint. Validated against the same `KEY_PATTERN` `ProfileStore` uses, so a malformed RHS (spaces, special chars, oversized) is dropped at parse time and never reaches the writer. Pinned by `drops a malformed supersedes RHS`.
- `valid_from=now` — the only accepted literal. Any other RHS (explicit timestamp, future date, ISO string) is dropped silently. The runtime always stamps `valid_from` from the live clock so the LLM cannot rewrite past history. The field carries through to `ReflectionFact.validFrom` as `"now" | null` and is consumed by the metrics/audit path only — the store ignores it today.

The GBNF reflection grammar itself is unchanged: `value ::= [^\n]{1,200}` already accepts the marker syntax. Parser-level validation drops malformed markers without re-prompting.

**Reflection prompt.** [reflection-prompt.ts](src/memory/reflection/reflection-prompt.ts) `REFLECTION_STABLE_PREFIX` gained a "Bi-temporal versioning" paragraph teaching the LLM about the marker. This is the only prompt change in phase 4 — it invalidates the **reflection slot's** KV cache for one call. The main agent slot's stable prefix is untouched (none of phase 4's wiring leaks into `buildStablePrefix`).

**Tool: `memory.profile.history { key }`** ([profile-history.ts](src/tools/memory/profile-history.ts)). Read-only. Returns the full chain in temporal order with an `active` flag on each row and a human-readable summary line (` * [#id] ISO-time: value (active)` / ` [#id] ISO-time: value → #N`). Registered alongside `memory.profile.{set,remove,list}` when `memory.profile.enabled` is true; resource class is `pure_read` so it fans out cleanly in parallel batches. Validation errors fold into a structured `status: "error"` tool result instead of throwing.

**Reflection wiring.** `writeFacts` in [reflection-runner.ts](src/memory/reflection/reflection-runner.ts) now threads `fact.supersedes` (when present) into `ProfileStore.set` as `supersedesKey`. Same-key supersession does not need this — every same-key write auto-chains via the partial unique index path. The supersession hint is purely for cross-key cases. Sequence inside `ReflectionRunner.runOne` is unchanged:

```
parse  →  write SET  →  write NOTE  →  link-generator (phase 2)  →  neighbor-evolver (phase 3)
```

**Metrics.** New counter `agent.memory.profile.superseded` in [agent-metrics.ts](src/tracing/agent-metrics.ts), tagged by `key`, `previous_id`, `next_id`. Fires **once per parent flipped** — a cross-key supersession that touches two parents will fire twice with distinct `previous_id`s. (Today the writer fires it only on the structural same-key parent; cross-key supersession parents do not emit the metric — see `// TODO` below.)

**Locked invariants** (pinned by [profile-store-bitemporal.test.ts](src/memory/profile-store-bitemporal.test.ts), [profile-history.test.ts](src/tools/memory/profile-history.test.ts), [reflection-parser.test.ts](src/memory/reflection/reflection-parser.test.ts) phase-4 cases, [reflection-runner.test.ts](src/memory/reflection/reflection-runner.test.ts) `scenario 4.A — SET with supersedes marker produces a bi-temporal chain`):

1. **At most one active row per key.** Enforced by the partial unique index `idx_profile_active_key`. Pinned by `4.A.3 — partial unique index forbids two active rows for one key`.
2. **Every SET preserves history.** Scenario 4.A: `ru → en` produces a 2-row chain with the `ru` row marked superseded. Pinned by `scenario 4.A — language change preserves history`.
3. **`remove(key)` keeps the historical chain.** Only the active row is deleted. Pinned by `remove() deletes only the active row, history chain intact`.
4. **Legacy v6 rows migrate transparently.** `valid_from = updated_at`, `superseded_by = NULL`, `pinned` + `keywords` preserved. Pinned by `legacy v3 row migrates to v7 with valid_from = updated_at and active state`.
5. **Renderer untouched.** `### profile` filters via `list()` which already returns active-only rows. Stable-prefix bytes do not change because of phase 4.
6. **Marker validation drops malformed RHS at parse time.** `supersedes=not a valid key` → `supersedes: null`. Pinned by `drops a malformed supersedes RHS`.
7. **`valid_from` always stamped by the runtime clock.** The parser strips the literal `now`; the store reads it from `Date.now()` (or the injected `now` arg). Pinned by `drops a non-'now' valid_from RHS silently`.
8. **No new top-level config.** Phase 4 is always-on once the v7 migration has run. No feature flag. Operators can still call `memory.profile.set` with `pinned=false; keywords=...` exactly as before — the new fields are additive.

**Out of scope (deferred).** Cross-key history walks via `getById` (today `history(key)` is per-key; following `supersedes` / `supersededBy` across keys is left as a manual chain walk for the agent), `vote_score` column on `profile_facts` (phase 7a), per-parent metric emission on cross-key supersession (today only the same-key parent fires `agent.memory.profile.superseded`), an explicit `bitemporal.enabled` config flag (the schema migration is forward-only so a runtime toggle would have no on-disk effect), and `memory.profile.bitemporal.maxHistoryPerKey` capping (today the chain grows unbounded — practically bounded by reflection rate which is at most one SET per turn per key).

### Memory-v2 phase 5 — lessons + cold-path consolidator (C-half)

Phase 5 closes the read/write loop of the memory fabric: clusters of related episodes (notes linked via `memory_links`) are distilled into **`Lesson`** rows by an out-of-band cold-path consolidator, surfaced into the prompt as `### lessons` pointers, archived from `### memory-index` but kept fully readable by id, and recalled on demand through the new `memory.lessons.recall` tool. The agent never sees the full `principle` body in the stable prefix — the pointer-only surface keeps the variable tail bounded and the rare-tool model of `tool.view` applies verbatim.

**Schema v7 → v8** in [memory-schema.ts](src/memory/memory-schema.ts). Two additive changes:

- `ALTER TABLE memories ADD COLUMN consolidated_into INTEGER` + `CREATE INDEX idx_memories_consolidated`. A non-NULL value means the row has been folded into a lesson and is dropped from `### memory-index` (but `get(id)` still returns it — load-bearing for citation walks from lesson `parent_ids`).
- `CREATE TABLE lessons` (`id PK`, `activation`, `principle`, `tags`, `status ∈ {"active","deprecated"}`, `success_count`, `failure_count`, `parent_ids JSON`, `working_dir`, `created_at`, `updated_at`, `deprecated_at`) + `lessons_fts` FTS5 virtual table (`porter unicode61` on `activation, principle, tags`) + INSERT/UPDATE/DELETE triggers keeping the FTS index in sync.

Both migrations are idempotent — restarting after a successful v8 boot is a no-op. The legacy schema migration test was extended to seed a minimal `memories` table at v6 so the v8 ALTER finds its target on partial fixtures.

**Stores.**

- [memory-store.ts](src/memory/memory-store.ts) gained `archiveInto(parentIds, lessonId, now?)` (single atomic UPDATE that stamps `consolidated_into = lessonId` for every parent) and `getConsolidatedInto(id)`. `list({ excludeArchived: true })` and `listIndex({ excludeArchived: true })` filter `consolidated_into IS NULL`. Archived rows stay readable by `get(id)` so the agent can still inspect a lesson's parents via the `parent_ids` array returned by `memory.lessons.recall`.
- [lessons/lesson-store.ts](src/memory/lessons/lesson-store.ts) is a self-contained store with `create`, `getById` (returns deprecated rows too — used for direct-id lookups from `### lessons`), `recall { query, k, includeDeprecated? }` (BM25 against `lessons_fts`; defaults to active-only), `listIndex { limit, workingDir? }` (compact pointer view for the `### lessons` section), `markDeprecated`, `bumpSuccess` / `bumpFailure`, `pickOverflowForDeprecation`, and `countAll`. All writes go through the same validators (`LESSON_ACTIVATION_MAX_LENGTH`, `LESSON_PRINCIPLE_MAX_LENGTH`, `LESSON_MAX_TAGS`, `LESSON_TAG_MAX_LENGTH`) — there is no second back door, identical to `ProfileStore` / `MemoryStore`.

**Prompt surface.** The variable tail gained a `### lessons` section rendered by [lessons-renderer.ts](src/memory/lessons/lessons-renderer.ts) — one `*<id> [tags] activation` line per lesson, ordered as the recall returned them, capped at `memory.lessons.maxTokens` (default `400`) with a `[truncated]` marker. Placement is between `### profile` and `### memory-index` (mutability order in the tail). The renderer **never** emits the `principle` body — that requires an explicit `memory.lessons.recall { id }` call. Token cost is subtracted from the effective conversation cap in [token-budget.ts](src/prompt/token-budget.ts).

**Stable-prefix change (KV-cache invalidation #1).** [stable-prefix.ts](src/prompt/stable-prefix.ts)'s persona text was extended to mention `### lessons` and how to materialise the full body via `memory.lessons.recall { id }`. This **invalidates the main agent slot's KV cache** for one cold start across the whole runtime — a planned one-time event for phase 5. The reflection slot is untouched (phase 4 already invalidated that one). There is no hot migration path; restart with a fresh session pool. Phase 7b is the second and final planned invalidation (`### procedures`).

**Read-side wiring.** [memory-context-provider.ts](src/memory/memory-context-provider.ts) was extended with an optional `lessons` block. When configured AND a non-empty user message arrives, the provider calls `LessonStore.recall(userMessage)` for the top-K (default `5`) hits and stores them on the ephemeral `SessionState.recalledLessons` field. `stripEphemeral` in [session-state.ts](src/session/session-state.ts) drops `recalledLessons` before SQLite persistence — recomputed every turn against the live user message. When `lessons` is not configured the provider returns the byte-identical pre-phase-5 `{ recalled, index }` shape so older callers stay stable; phase-5 consumers see `{ recalled, index, lessons }`. The `### memory-index` rendering also flips to `excludeArchived: true` so consolidated parents disappear from the pointer surface (but stay readable by id).

**Agent tool: `memory.lessons.recall { id?, query?, k? }`** ([tools/memory/lessons-recall.ts](src/tools/memory/lessons-recall.ts)). Read-only (`pure_read` resource class — fans out cleanly in parallel batches). `{ id }` returns one full lesson including deprecated rows (so the agent can resolve a stale pointer); `{ query }` does a BM25 search against active lessons only. Output is `{ id, activation, principle, tags, parentIds }`. Validation errors fold into structured `status: "error"` tool results instead of throwing. The GBNF grammar [tool-call.gbnf](grammars/tool-call.gbnf) was extended to accept `lessons.recall` alongside the existing `memory.*` tools; the prompt descriptor lives in [default-tool-descriptors-b.ts](src/prompt/default-tool-descriptors-b.ts) at tier `frequent` so the full `argsSchema` is always in the stable prefix.

**Consolidator (cold path).** [consolidator/consolidator-job.ts](src/memory/consolidator/consolidator-job.ts) is the single orchestrator. One tick (`runOnce`) does:

1. **Select candidates.** `MemoryStore.list({ excludeArchived: true, beforeCreatedAtMs: now - cooldownMs })` — rows that have aged beyond `memory.consolidation.cooldownMs` (default `0`; production deployments should bump this so freshly-written notes have time to attract `RELATES_TO` links).
2. **Cluster.** [consolidator/clustering.ts](src/memory/consolidator/clustering.ts) — undirected BFS over `LinkStore.listOutgoing` + `listIncoming` to find connected components, filtered by `minClusterSize` (default `3`). When `requireSharedTag=true` (default `false`), each component is trimmed to the members sharing the **single most common tag**; components with no shared tag are dropped. The chosen algorithm is "CC + tag-intersection" — a deliberate tradeoff between recall (loose CC) and precision (strict tag intersection); pinned by [clustering.test.ts](src/memory/consolidator/clustering.test.ts) (eight cases including empty input, size floor, external edges, the trimming path, the `requireSharedTag` drop path, the `maxClusters` cap, and bidirectional traversal).
3. **Acquire leases.** Per-member `MemoryStore.acquireConsolidationLease(id, leaseMs)`. If any member is already leased (phase 3 neighbour-evolver or a concurrent tick), the entire cluster is skipped and members released — clusters are atomic units. Lease TTL is hardcoded to `60_000` ms today; outliving the tick is fine because the next tick will re-acquire.
4. **Distill.** [consolidator/distill-runner.ts](src/memory/consolidator/distill-runner.ts) — one LLM call per cluster on the reflection slot (so the main agent slot's KV cache is never disturbed by consolidation). Prompt + GBNF in [distill-prompt.ts](src/memory/consolidator/distill-prompt.ts) + [distill-grammar.ts](src/memory/consolidator/distill-grammar.ts) — the model must emit either `LESSON activation="..."; principle="..."[; tags=...]` **or** the explicit abstain sentinel `LESSON activation="(no consensus)"; principle="(no durable advice)"`. [distill-parser.ts](src/memory/consolidator/distill-parser.ts) recognises the sentinel as `kind: "none"`; the consolidator counts these in `lessonsAbstained` and leaves the parents un-archived (abstain ≠ archive — the cluster can be retried in a future tick when more episodes accumulate).
5. **Persist + archive + rewire.** On `kind: "lesson"`, the consolidator calls `LessonStore.create(...)` then `MemoryStore.archiveInto(parentIds, lessonId)` in that order. Link rewiring is deliberately deferred — `memory_links` rows pointing at archived members stay intact (the BFS view still works for postmortem walks); a future "link compaction" pass can collapse them.
6. **Release leases + record metrics.** Every member's lease is released even on failure. Per-cluster failures (LLM throw / parse error / timeout) are caught and logged; sibling clusters in the same tick keep running — the tick's outcome is `ok` if at least one lesson landed, `failed` only if every cluster errored, `none` otherwise.

**Scheduler seam — scoped `setInterval` carve-out.** The consolidator owns its own `setInterval` with period `memory.consolidation.intervalMs` (default `300_000` = 5 min). This is the **second** carve-out from the §"Background autonomy" invariant that "`Scheduler` is the only periodic timer in the runtime" — the first was Telegram long-polling, the second is the consolidator. The carve-out is deliberate and bounded: the loop is owned by [consolidator-job.ts](src/memory/consolidator/consolidator-job.ts) only, every tick is wrapped in a try/catch with a `running` re-entry guard, and ticks never block — distillation runs on the reflection slot with its own timeout (`memory.consolidation.distillTimeoutMs`, default `45_000`). New cold-path jobs of this shape **must not** add a third timer without an analogous AGENTS.md review.

**Bootstrap wiring.** [runtime/bootstrap.ts](src/runtime/bootstrap.ts) constructs `LessonStore` unconditionally (it owns a SQLite handle on the shared `memory.sqlite` file, must be closed by `shutdown`), wires it into `memory.lessons.recall` registration (gated by `memory.lessons.enabled`), and threads it into `createDefaultMemoryContextProvider`. The `ConsolidatorJob` is constructed and started **only** when `memory.lessons.enabled && memory.consolidation.enabled`; the distill runner shares the reflection slot reserved earlier for link-generation. `shutdown()` calls `consolidatorJob?.stop()` before `lessonStore.close()` so a final tick never touches a closed handle.

**Configuration (`memory.lessons.*` and `memory.consolidation.*`).** User config v15; `parseUserConfigFile` transparently migrates v14 → v15 filling defaults. Keys:

- `memory.lessons.enabled` (default `true`) — master switch. Controls `### lessons` rendering, `memory.lessons.recall` registration, and the consolidator.
- `memory.lessons.recallK` (default `5`) — top-K for the read-side BM25 surface.
- `memory.lessons.maxTokens` (default `400`) — token cap on the rendered `### lessons` block.
- `memory.lessons.indexLimit` (default `20`) — cap on `LessonStore.listIndex` rows (today read by the recall path only — phase 6 will surface this as `### lessons-index` analogous to `### memory-index`).
- `memory.lessons.maxEntries` (default `200`) — hard ceiling on active lesson rows; phase 6 enforces this via deprecation sweep.
- `memory.lessons.deprecationAgeMs` (default `30 days`) — age threshold for the phase-6 deprecation sweep.
- `memory.consolidation.enabled` (default `true`) — master switch for the cold-path job.
- `memory.consolidation.intervalMs` (default `300_000` = 5 min) — period of the scoped `setInterval`.
- `memory.consolidation.cooldownMs` (default `0`) — minimum age of an episode before it is eligible. Bump in production so freshly-written notes have time to attract links.
- `memory.consolidation.minClusterSize` (default `3`) — size floor.
- `memory.consolidation.maxClustersPerTick` (default `5`) — soft cap on clusters processed per tick.
- `memory.consolidation.requireSharedTag` (default `false`) — when `true`, clusters are trimmed by the majority-tag rule (see clustering above).
- `memory.consolidation.distillTimeoutMs` (default `45_000`) — per-cluster LLM timeout.

**Metrics.** [agent-metrics.ts](src/tracing/agent-metrics.ts):

- Counters: `agent.memory.lessons.{created,deprecated,recalled}`, `agent.memory.consolidation.run` (tagged by `outcome ∈ {"ok","none","failed"}`).
- Histograms: `agent.memory.consolidation.distill_latency_ms`, `agent.memory.consolidation.clusters` (per-tick cluster count).

**Locked invariants** (pinned by [consolidator-job.test.ts](src/memory/consolidator/consolidator-job.test.ts), [clustering.test.ts](src/memory/consolidator/clustering.test.ts), [distill-parser.test.ts](src/memory/consolidator/distill-parser.test.ts), [lesson-store.test.ts](src/memory/lessons/lesson-store.test.ts), [lessons-renderer.test.ts](src/memory/lessons/lessons-renderer.test.ts), [memory-store-archive.test.ts](src/memory/memory-store-archive.test.ts), [build-prompt.test.ts](src/prompt/build-prompt.test.ts)):

1. **`### lessons` is pointer-only.** The renderer never emits `principle`. Full bodies require an explicit `memory.lessons.recall { id }` call. Pinned by `lessons-renderer.test.ts` ("does not leak principle").
2. **Archived memories remain readable by id.** `MemoryStore.get(archivedId)` returns the row; only `list({ excludeArchived: true })` / `listIndex` drop it. Pinned by `memory-store-archive.test.ts`.
3. **One LLM call per cluster, on the reflection slot.** The consolidator never touches the main agent slot. Distillation is **always serial within a tick** (one cluster → one call → next cluster); parallel cross-cluster fan-out is deferred.
4. **Abstain ≠ archive.** When the model emits the `(no consensus)` sentinel, the cluster is recorded as abstained, parents stay active, leases are released. Pinned by `consolidator-job.test.ts` ("treats abstain output as 'none' and does not write a lesson").
5. **Per-cluster failures isolate.** A throw / parse error / timeout on one cluster does not abort the tick — sibling clusters keep running. Pinned by `consolidator-job.test.ts` ("isolates per-cluster failures and lets a second cluster succeed").
6. **Lease semantics are shared with phase 3.** Phase 3 (neighbour-evolver) **reads** the lease in `evolveTags`; phase 5 is the only **acquirer**. The B↔C boundary is the `consolidating_at` column landed dormant in the v4 migration. Pinned by `memory-store-evolve.test.ts` ("evolve respects consolidation lease").
7. **Stable-prefix mention is one-time.** Adding the `### lessons` paragraph to the persona is **one** byte change. Pinned by `build-prompt.test.ts` ("stable prefix mentions ### lessons in the persona" + the existing hash-stability test for non-phase-5 mutations).
8. **`recalledLessons` is ephemeral.** `stripEphemeral` removes it before persistence; recomputed every turn. Pinned by `session-state.test.ts`.
9. **Re-entry guard.** Two concurrent `runOnce` calls collapse to one — the second returns a zero-summary. Pinned by `consolidator-job.test.ts` ("re-entry guard returns a zero-summary when another tick is in flight").
10. **Idempotency across ticks.** A second tick with no new candidates is `{ outcome: "none", clustersConsidered: 0, lessonsCreated: 0 }`. Pinned by `consolidator-job.test.ts` ("is idempotent on a second tick").
11. **Cooldown is enforced server-side.** Episodes younger than `memory.consolidation.cooldownMs` are filtered at the candidate-selection step, not by the cluster pass. Pinned by `consolidator-job.test.ts` ("respects cooldownMs").
12. **Memory-context-provider shape stays backwards-compatible.** When the `lessons` block is not configured, the provider returns `{ recalled, index }` — no `lessons` key. Phase-5 callers see `{ recalled, index, lessons }`. Pinned by `memory-context-provider.test.ts`.

**Out of scope (deferred to phase 6).** Lesson lifecycle bumps from agent-loop terminal verbs (`bumpSuccess` / `bumpFailure` on whether a surfaced lesson actually helped the turn), `maxEntries` FIFO deprecation sweep inside the consolidator tick, `deprecationAgeMs` enforcement. Phase 7a adds `vote_score` columns + ExpeL-style vote curation. Phase 7b adds the second stable-prefix change (`### procedures`) and the combined lesson-and-procedure grammar — invariant 3 ("one LLM call per cluster") survives that addition.

### Memory-v2 phase 6 — lesson lifecycle and deprecation

Phase 6 closes the lesson loop: lessons that demonstrably help turns earn `success_count` bumps, lessons that fail to do so age out, and the total active set stays bounded by a per-store `maxEntries` cap. Two new code paths land — one **hot** (agent-loop terminal-verb hook) and one **cold** (consolidator sweep) — sharing the existing `LessonStore` API. **No new schema change** (v8 already carries `success_count`, `failure_count`, `status`, `deprecated_at`); the work is purely behavioural.

**Hot path — lesson lifecycle hook (agent-loop).** [agent-loop.ts](src/agent/agent-loop.ts) was extended with an optional `lessonLifecycle: LessonLifecycleHook` dep. Inside `runTurn`, a `surfacedLessonIds: Set<number>` accumulates the union of every `state.recalledLessons` snapshot the turn sees — once at the top of the turn (after the initial `refreshMemoryContext`) and once after every successful non-terminal step. At terminal time the hook fires **exactly once** with the deduplicated id set and a typed outcome:

| Terminal reason | Hook fires? | Outcome |
|---|---|---|
| `reply` | yes | `success` |
| `finish` | yes | `success` |
| `failed` (thrown / categorised infra failure) | yes | `failure` |
| `cancelled` (signal aborted, `CancelledError`, classified `cancelled`) | **no** | — |
| `max_steps` (synthetic reply) | **no** | — |

Cancelled and max-steps turns are deliberately filtered out because neither carries a clean success/failure signal — cancellation is operator-initiated, and `max_steps` is ambiguous (the lessons may have been useful right up until the budget ran out). Phase 7a may revisit `max_steps` as a soft-negative signal once vote scores land. The default hook implementation lives at [lesson-lifecycle-hook.ts](src/memory/lessons/lesson-lifecycle-hook.ts) and routes `success` → `LessonStore.bumpSuccess(id)` / `failure` → `LessonStore.bumpFailure(id)`. The hook is fire-safe (`try/catch` around each bump, errors logged at WARN); a sqlite hiccup on one id never aborts sibling bumps and never derails the turn-completion path.

**Cold path — deprecation sweep (consolidator).** [consolidator-job.ts](src/memory/consolidator/consolidator-job.ts)'s `runOnce` was extended with a deprecation sweep that fires inside the existing `finally` block, **after** distillation and **regardless** of the tick's clustering outcome — including ticks where no clusters formed. This is load-bearing: most production ticks find no new clusters but still need to keep the active set bounded. The sweep runs in two passes:

1. **Age sweep** — `LessonStore.pickAgeDeprecationCandidates({ now, deprecationAgeMs })` returns active rows with `success_count = 0` AND `created_at <= now - deprecationAgeMs`. Each is demoted via `markDeprecated(id, "aged_out")`. The "still unused" predicate is the load-bearing filter — a lesson that helped at least one turn (`success_count >= 1`) survives indefinitely on age alone; only the FIFO pass can demote it.
2. **FIFO sweep** — `LessonStore.pickOverflowForDeprecation()` returns oldest-by-`updated_at, id` ids when `countActive() > maxEntries`. Each is demoted via `markDeprecated(id, "overflow")`. Even successful lessons can be evicted here, which is intentional: the cap is a hard ceiling on the rendered surface, not a popularity filter.

Both passes share a `maxDeprecationsPerTick` cap (default `100`, hardcoded in bootstrap) so a misconfigured `deprecationAgeMs` cannot flatten the entire lesson set in one tick. Per-lesson failures (sqlite errors) are caught, logged, and skipped — sibling demotions keep flowing. The sweep adds two fields to `ConsolidatorTickResult`: `lessonsDeprecatedByAge` and `lessonsDeprecatedByOverflow`.

**Trace event.** `lesson_deprecated { lessonId, reason }` lands in the trace union at [trace-event.ts](src/tracing/trace/trace-event.ts). The consolidator fires it via a new optional `onLessonDeprecated` callback in `ConsolidatorJobDeps`; bootstrap bridges the callback to `TraceBus.emit(...)` using a **synthetic `consolidator` sessionId** so cold-path events land in `<stateDir>/traces/consolidator.ndjson` — a dedicated file separate from per-session turn traces. A local `seq` counter (closure-captured in bootstrap) keeps the file monotonically ordered; per-session counters are recorder-owned and the consolidator does not run through a recorder. `reason` is intentionally a free-form string (`"aged_out" | "overflow"` today; phase 7a adds `"downvoted"`) so future demotion paths slot in without a schema bump.

**Metrics.** Phase 6 reuses the existing `agent.memory.lessons.deprecated` counter (already wired in phase 5 via `LessonStore.markDeprecated`); the new contribution is the **`reason` tag** which now carries `aged_out | overflow` instead of phase 5's `unspecified`. `agent.memory.lessons.recalled` continues to fire from `memory-context-provider` once per turn. No new metric names.

**Bootstrap wiring.** [runtime/bootstrap.ts](src/runtime/bootstrap.ts) threads `lessonLifecycle: createLessonLifecycleHook({ lessonStore, logger })` into `loopDeps` when `memory.lessons.enabled` is true, and passes `deprecationAgeMs: config.memory.lessons.deprecationAgeMs` + `maxDeprecationsPerTick: 100` into the existing `ConsolidatorJob` constructor. The `onLessonDeprecated` callback is only wired when `traceBus` is non-null (sidecar default is null) so non-tracing runtimes see byte-identical behaviour.

**Configuration.** No new keys. Phase 6 consumes the existing `memory.lessons.{enabled, maxEntries, deprecationAgeMs}` introduced in phase 5 (config v15).

**Locked invariants** (pinned by [lesson-store.test.ts](src/memory/lessons/lesson-store.test.ts) phase-6 cases, [lesson-lifecycle-hook.test.ts](src/memory/lessons/lesson-lifecycle-hook.test.ts), [agent-loop-lesson-lifecycle.test.ts](src/agent/agent-loop-lesson-lifecycle.test.ts), [consolidator-job.test.ts](src/memory/consolidator/consolidator-job.test.ts) phase-6 cases):

1. **Once per turn per id.** Even if the same lesson surfaces across many step refreshes, `bumpSuccess` / `bumpFailure` fires exactly once. Pinned by `agent-loop-lesson-lifecycle.test.ts` ("deduplicates surfaced ids across multiple step refreshes").
2. **No bump on `cancelled` or `max_steps`.** Pinned by `agent-loop-lesson-lifecycle.test.ts` ("does NOT fire the hook when the turn is cancelled"). The `max_steps` path is the natural fall-through in `runTurn` — the hook block guards `reason === "reply" || reason === "finish"`.
3. **`failed` → `bumpFailure`.** Thrown / classified failures route through the early-return failed branch that fires the hook before `return`. Pinned by `agent-loop-lesson-lifecycle.test.ts` ("fires 'failure' for surfaced lessons when the loop fails").
4. **Empty surfaced set → silent no-op.** No hook call when no lessons were surfaced. Pinned by `agent-loop-lesson-lifecycle.test.ts` ("is a no-op when no lessons surfaced this turn").
5. **Hook is fire-safe.** Bump errors are caught per-id; the agent loop's return path is never disturbed. Pinned by `lesson-lifecycle-hook.test.ts` ("swallows bump errors and keeps processing siblings").
6. **Age picker requires `success_count = 0`.** A lesson with `success_count >= 1` never falls out of `pickAgeDeprecationCandidates`, regardless of age. Pinned by `lesson-store.test.ts` ("pickAgeDeprecationCandidates picks active lessons with success_count==0 older than threshold").
7. **FIFO order is `updated_at ASC, id ASC`.** Oldest-by-modification-time is demoted first; ties break by id. Pinned by `lesson-store.test.ts` ("pickOverflowForDeprecation respects maxEntries").
8. **Sweep runs even on a "none" tick.** No clusters formed ≠ skip deprecation. Pinned by `consolidator-job.test.ts` ("deprecation sweep runs on every tick, including when no clusters form").
9. **`maxDeprecationsPerTick` is a combined cap across both passes.** Age + overflow demotions cannot exceed the cap in a single tick. Pinned by `consolidator-job.test.ts` ("sweep respects maxDeprecationsPerTick across both passes").
10. **Demoted rows stay readable by id.** `LessonStore.getById(id)` returns the row regardless of `status`; only `recall` / `listIndex` filter it out. Pinned by `consolidator-job.test.ts` ("deprecated lessons are excluded from recall but still readable by id"). Cross-phase invariant 9 from MEMORY_FABRIC_V2.md.
11. **`lesson_deprecated` fires once per demoted lesson with the right reason.** Trace bridge is wired only when `traceBus` is non-null. Pinned by `consolidator-job.test.ts` ("emits onLessonDeprecated for every demoted lesson (age + overflow)").
12. **No schema change.** Phase 6 is purely behavioural over v8. The next bump is phase 7a (`vote_score` columns).

**Out of scope (deferred).** Failure-count demotion (`failure_count > N → deprecate`) — today only `success_count = 0 + age` and FIFO drive demotion; phase 7a adds `vote_score < 0`. Soft-negative signal from `max_steps` and `stalled` outcomes. Per-`workingDir` scoping of the FIFO cap (today it is global — a noisy project can squeeze a quiet one's lessons out). Re-promotion (`undeprecate`) of a deprecated lesson when a future recall would surface it — today deprecation is one-way; the consolidator can mint a fresh lesson from the same cluster but the old row stays demoted forever.

### Memory-v2 phase 7a — ExpeL-style vote curation

Phase 7a adds an explicit operator-controlled curation signal across memories, lessons, and profile facts. The agent itself emits up- and down-votes through a new **reflection sub-call** (`vote-runner`) constrained by a GBNF grammar; the cold-path `ConsolidatorJob` decays the resulting scores once per tick and demotes targets that crossed into negative territory; the prompt renderer hides profile facts that fell past a configurable threshold. Vote curation is on by default via `memory.voting.enabled` (default `true`, config v21); set `false` to skip the vote-runner and cold-path decay.

**Schema (v8 → v9).** Idempotent migration in [memory-schema.ts](src/memory/memory-schema.ts): adds `vote_score REAL NOT NULL DEFAULT 0.0` columns to `memories`, `lessons`, and `profile_facts`; creates a new `vote_events (id PK, kind, target_id, direction, session_id, turn_index, created_at)` audit table with `idx_vote_events_created` (FIFO eviction) and `idx_vote_events_target` (postmortem lookups). Indexes `idx_memories_vote_score` and `idx_lessons_vote_score` accelerate the per-tick deprecation predicate. No data is rewritten — rows migrated from v8 inherit `vote_score = 0`.

**Configuration (`memory.voting.*`).** User config v15 → v16 (transparent migration; see [config-schema.ts](src/config/config-schema.ts)):

- `memory.voting.enabled` (default `true`, config v21) — master switch. When off, the `VoteStore` is not constructed, the reflection chain is not decorated, and the consolidator's vote decay + vote-deprecation passes are skipped.
- `memory.voting.maxVotePerItem` (default `5`) — strictly-positive clamp on `|vote_score|`. Bootstrap fails fast on `≤ 0` (scenario 7a.C.3).
- `memory.voting.signalDecay` (default `0.95`) — multiplicative decay factor in `(0, 1]`. `1.0` is identity (audit-only mode); `0` disables decay **and** vote-deprecation but is rejected by validation. Applied once per consolidator tick — never per turn (cross-phase invariant 23).
- `memory.voting.scoreBlend` (default `0.4`) — weight in `[0, 1]` for the lesson rerank: `combinedScore = bm25 + scoreBlend × vote_score + (1 - scoreBlend) × (success - failure)`.
- `memory.voting.eventLogMaxRows` (default `2000`) — FIFO cap on `vote_events`.
- `memory.voting.profileFilterThreshold` (default `2`) — strictly-positive threshold; profile facts with `vote_score ≤ -profileFilterThreshold` are hidden from `### profile` regardless of pinned/keyword status. `0` disables the filter.

**Hot path — `vote-runner` reflection sub-call.** [src/memory/voting/](src/memory/voting/) ships a self-contained sub-call:

- **Grammar.** [vote-grammar.ts](src/memory/voting/vote-grammar.ts) — bounded to `NONE`, `UPVOTE <kind>:<id>`, `DOWNVOTE <kind>:<id>` (kind ∈ {memory, lesson, profile}), capped at 8 entries per call. The `EDIT` marker from the original ExpeL spec is **deferred** — phase 7a ships up/down only.
- **Prompt.** [vote-prompt.ts](src/memory/voting/vote-prompt.ts) — micro-prompt with the same shape as the reflection prelude. Carries the `userMessage`, the assistant reply, and a `VoteCandidate[]` list (kind + id + truncated preview). Aggressive preview truncation keeps the prompt under budget when many items surfaced.
- **Parser.** [vote-parser.ts](src/memory/voting/vote-parser.ts) — strictly rejects votes against ids that are **not** in the per-turn `VoteAllowlist` (cross-phase invariant 18). The allowlist is the union of {recalled memory ids, recalled lesson ids, active profile fact ids}; the parser also deduplicates votes and caps at `maxVotes`. Out-of-allowlist votes never reach the store — they are tagged `out_of_allowlist` and recorded on the rejected counter.
- **Runner.** [vote-runner.ts](src/memory/voting/vote-runner.ts) — wraps the LLM call, parses, and applies each accepted vote through `VoteStore.applyVote`. Timeouts / abort signals / LLM errors are folded into `runner_outcome` tags (`ok | none | skipped | aborted | timeout | failed`) so observability never blocks reflection.
- **Decorator.** [vote-aware-reflection.ts](src/memory/voting/vote-aware-reflection.ts) — composes on top of `createLinkAwareReflectionRunner` (or the base reflection runner when links are off). The vote-runner fires **after** SET/NOTE/link-gen/EVOLVE so all candidates produced this turn are eligible.

Wired in [bootstrap.ts](src/runtime/bootstrap.ts) when `memory.voting.enabled` is on; the decorator inherits the reflection slot (cross-phase invariant 2). `agent-loop.ts` was extended to thread `recalledLessonIds`, `recalledProfileFactIds`, and `turnIndex` into `ReflectionInput` so the decorator can hydrate previews without re-querying.

**Cold path — vote decay + vote-deprecation sweep.** [consolidator-job.ts](src/memory/consolidator/consolidator-job.ts)'s `runOnce` was extended (still **after** distillation, **inside** the `finally` block):

1. **Decay pass.** `voteStore.decayAllScores(signalDecay)` scales every `vote_score` row by the configured factor in a single SQL statement per table (cross-phase invariant 17). Once per tick, never per turn (cross-phase invariant 23). Metric `agent.memory.voting.decayed` fires one sample per kind. Decay runs **before** the deprecation sweep so the latter sees up-to-date scores.
2. **Vote-deprecation sweep.** `LessonStore.pickVoteDeprecationCandidates({ limit })` returns active rows with `success_count = 0 AND vote_score < 0`, ordered by `vote_score ASC` (most-negative first). Each is demoted via `markDeprecated(id, "downvoted")` and emits a `lesson_deprecated` trace event. This pass runs **before** the existing age + FIFO sweeps so the highest-confidence "this is bad" signals retire ahead of merely-aged candidates when `maxDeprecationsPerTick` binds.

`ConsolidatorTickResult` gained two fields: `lessonsDeprecatedByVote` and `voteDecayApplied`. The vote sweep is gated by `voteSignalDecay > 0`; when the master switch is off the sweep degrades to a no-op without touching scores.

**Memory eviction — vote priority.** [memory-store.ts](src/memory/memory-store.ts)'s utility-weighted overflow eviction now orders by `vote_score ASC, recall_count ASC, COALESCE(last_recalled_at, 0) ASC, updated_at ASC, id ASC`. A downvoted memory row evicts before any neutral row regardless of age or recall count (scorecard 7a.A.3). Legacy FIFO mode (`eviction.utilityWeighted = false`) is unchanged.

**Lesson recall — combined-score rerank.** [lesson-store.ts](src/memory/lessons/lesson-store.ts)'s `recall` accepts an optional `scoreBlend` (and `rerankPoolMultiplier`) that switches from pure BM25 ordering to `computeLessonCombinedScore(bm25, vote_score, success_count, failure_count)`. The rerank fetches a wider pool (`k × rerankPoolMultiplier`) so a less-relevant but heavily-upvoted lesson can surface. `scoreBlend = 0` collapses to pure success/failure ranking; `scoreBlend = 1` collapses to pure vote ranking. The default `0.4` weights operator votes more than auto-feedback.

**Profile rendering — vote filter.** [profile-renderer.ts](src/memory/profile-renderer.ts) accepts `profileFilterThreshold` and drops every fact with `voteScore ≤ -threshold` **before** the contextual-keyword gate runs. A downvoted pinned fact disappears too (operators expect votes to override pinning). `threshold = 0` is back-compat (filter disabled).

**Trace events.** [trace-event.ts](src/tracing/trace/trace-event.ts) gained `vote_applied { kind, targetId, direction, score, clampHit }` and `vote_rejected { kind, targetId, direction, reason }` event types. Emission rides the **per-session `TraceRecorder`**: `TraceRecorder.recordVoteApplied(...)` / `recordVoteRejected(...)` own the monotonic `seq` counter so vote events interleave cleanly with the agent-loop stream even though `VoteRunner` fires after `turn_finished`. The bridge is wired in [bootstrap.ts](src/runtime/bootstrap.ts) via the optional `emitTrace` callback on `VoteRunnerDeps`, which resolves the recorder by `event.sessionId` from the same `recorders` map the loop uses. Sink failures are swallowed (`safeEmit` in `vote-runner.ts`) so a recorder hiccup never derails vote application. `clamp_hit` writes emit `vote_applied { clampHit: true }` (not `vote_rejected`) — the operator's curation intent reached the store, the score just saturated.

**Metrics.** [agent-metrics.ts](src/tracing/agent-metrics.ts) gained `agent.memory.voting.{runner,runner_latency_ms,applied,rejected,decayed}`. Runner outcomes (`ok | none | skipped | aborted | timeout | failed`), apply kinds, rejection reasons, and decay-per-kind are tagged so dashboards can split production noise.

**Locked invariants** (pinned by [vote-store.test.ts](src/memory/voting/vote-store.test.ts), [vote-parser.test.ts](src/memory/voting/vote-parser.test.ts), [vote-runner.test.ts](src/memory/voting/vote-runner.test.ts), [consolidator-vote.test.ts](src/memory/consolidator/consolidator-vote.test.ts), [lesson-store-rerank.test.ts](src/memory/lessons/lesson-store-rerank.test.ts), [memory-store-v2.test.ts](src/memory/memory-store-v2.test.ts), [profile-renderer.test.ts](src/memory/profile-renderer.test.ts), [scorecard-7a.test.ts](src/memory/voting/scorecard-7a.test.ts)):

1. **One inference per turn for voting.** The vote-runner is a single LLM call piggy-backing on the reflection slot — no recursive loops. Pinned by `vote-runner.test.ts`.
2. **Allowlist is load-bearing.** A vote against an id that was not surfaced this turn is dropped at parse time, regardless of grammar validity. Cross-phase invariant 18. Pinned by `vote-parser.test.ts` ("rejects vote against id not in allowlist") and `vote-runner.test.ts`.
3. **Clamp is symmetric.** `|vote_score| ≤ maxVotePerItem` enforced on every write; the saturated write returns `clamp_hit` without touching the audit log. Scenario 7a.C.2 in `scorecard-7a.test.ts`.
4. **Decay is per-tick, not per-turn.** Bulk SQL, one statement per table. Two consecutive ticks decay twice; two consecutive turns within the same tick window decay zero times. Scenario 7a.D in `consolidator-vote.test.ts` + `scorecard-7a.test.ts`.
5. **Vote-deprecation requires `success_count = 0`.** A lesson that helped at least one turn survives a net-negative vote signal; the operator's last resort is `lessonStore.markDeprecated` directly. Cross-phase invariant 19. Pinned by `consolidator-vote.test.ts` ("survives downvote if the lesson has at least one success bump").
6. **Vote sweep precedes age sweep.** When both passes would fire and `maxDeprecationsPerTick` binds, the downvoted candidate retires first. Pinned by `consolidator-vote.test.ts` ("vote-sweep runs before age-sweep when both fire on the same tick").
7. **Profile filter overrides pinning.** A pinned fact with `vote_score ≤ -threshold` is hidden from `### profile` (operators expect downvotes to override pinning). Pinned by `profile-renderer.test.ts` ("hides a pinned fact too when its vote_score is past the threshold").
8. **Bootstrap fails fast on invalid clamp/decay.** `memory.voting.maxVotePerItem ≤ 0` or `signalDecay ∉ (0, 1]` rejects at config parse time **and** at bootstrap. Scenario 7a.C.3 in `scorecard-7a.test.ts`.
9. **Vote curation is opt-out (config v21).** With `memory.voting.enabled = false`, `VoteStore` is not constructed, reflection is not decorated, the consolidator's vote pass degrades to a no-op (`voteDecayApplied = false`), and the eviction / rerank / renderer paths are byte-identical to phase 6.
10. **Trace `seq` is recorder-owned.** `vote_applied` / `vote_rejected` events flow through `TraceRecorder.recordVoteApplied` / `recordVoteRejected`, never directly through `traceBus.emit(...)`. Recorder lookup by `sessionId` in the closure; a missing recorder is a normal "tracing disabled" outcome, not an error. Pinned by `trace-recorder.test.ts` ("vote events share the same seq counter as agent events") and `vote-runner.test.ts` ("emits vote_applied via emitTrace for each successful write" + "swallows emitTrace failures without aborting vote application").

**Out of scope (deferred to phase 7b).** Vote rendering inside the prompt tail (today votes are observability-only; the agent reads `vote_score` indirectly through rerank + deprecation but never sees the raw number). `EDIT` marker for memory mutation (deferred — phase 7a is up/down only). Cross-session vote aggregation (today every vote is per-(session × target); a procedural memory consumed by 10 sessions accrues 10 independent vote signals). Per-`workingDir` filter thresholds. MemP-style procedure curation rides on top of this layer.

### Memory-v2 phase 7b — MemP-style advisory procedure templates

Phase 7b extends the consolidator with a second domain object: **procedures** — read-only "how-to" templates distilled from the same clusters that already produce lessons. A procedure carries an `activation` cue, an ordered `steps[]` array (description + optional `toolHint`), tags, status, lifecycle counters (`successCount`, `failureCount`, `useCount`), `vote_score`, and parent pointers into the lesson + memory cluster that birthed it. The agent **never** auto-executes a procedure — it reads the steps as guidance and either follows them or consciously deviates. This is the load-bearing invariant 20 below.

The phase ships the second (and final) stable-prefix change of the v2 rollout: persona text mentions `### procedures` and the new `memory.procedures.recall` tool. KV-cache for every session is invalidated once on first boot; subsequent boots reuse the new prefix.

**Schema.** [memory-schema.ts](src/memory/memory-schema.ts) bumped to `MEMORY_SCHEMA_VERSION = 10`. `V10_MIGRATION` adds the `procedures` table (`id`, `activation`, `steps` JSON, `tags` JSON, `status`, `success_count`, `failure_count`, `use_count`, `vote_score`, `parent_lesson_ids` JSON, `parent_memory_ids` JSON, `source`, `working_dir`, `created_at`, `updated_at`, `deprecated_at`), three indexes (`idx_procedures_status`, `idx_procedures_updated_at`, `idx_procedures_vote_score`), and a `procedures_fts` virtual table with the standard INSERT/DELETE/UPDATE triggers (porter unicode61). The migration is idempotent and runs from any of the four connections opened against `<stateDir>/memory.sqlite` (the first writer wins; subsequent connections see a no-op).

**ProcedureStore.** [procedure-store.ts](src/memory/procedures/procedure-store.ts) mirrors `LessonStore` shape-for-shape so the bootstrap wiring is symmetric. CRUD: `create()` (validates activation length, steps count + per-step length, tags, parent id arrays), `getById()`, `recall({ query?, id?, k?, scoreBlend? })`, `listIndex({ limit })`, `markDeprecated(id, reason)`, `bumpUse() / bumpSuccess() / bumpFailure()`, `deprecateByParentLesson(lessonId, reason)`, `pickAgeDeprecationCandidates() / pickVoteDeprecationCandidates() / pickOverflowForDeprecation()`. `recall` is vote-aware: when `scoreBlend > 0`, BM25 hits are reranked by `(1 - blend) * normalised_bm25 + blend * normalised_vote_score`, identical formula to `LessonStore.recall`.

**Combined distillation (invariant 21).** [distill-grammar.ts](src/memory/consolidator/distill-grammar.ts) ships `DISTILL_WITH_PROCEDURE_GRAMMAR` — `root ::= lesson "\n" opt-procedure`. The procedure half is **optional** (zero or one occurrence): conceptual clusters emit just the `LESSON` line, procedural clusters emit both. Steps are encoded as a single quoted string with `; ` separators and an optional `@toolhint` suffix per step; [distill-parser.ts](src/memory/consolidator/distill-parser.ts) re-parses that envelope into `ProcedureStep[]`. **Critically, the consolidator still makes exactly one LLM call per cluster** — the procedure is the second slot in the same completion. Pinned by `consolidator-job.test.ts` ("h.llmCalls === 1") and `scorecard-7b.test.ts` ("7b.A — exactly one LLM call").

Parser failure isolation: if the `LESSON` line is malformed, the cluster aborts as before; if the `PROCEDURE` line is malformed (too few/many steps, oversized step, missing semicolons, malformed `@toolhint`) the parser silently degrades to `procedure: null` and the lesson half still persists. Pinned by `distill-parser-procedure.test.ts`.

**Prompt tail.** [build-prompt.ts](src/prompt/build-prompt.ts) renders `### procedures` between `### lessons` and `### memory-index`. Each row is `><id> [tags] activation` — pointer-only; the full `steps[]` body never appears in the prompt by design. Token budget: `memory.procedures.maxTokens` (default `400`) with a `[truncated]` marker on overflow; the bytes are subtracted from the effective conversation cap by [token-budget.ts](src/prompt/token-budget.ts). The renderer [procedures-renderer.ts](src/memory/procedures/procedures-renderer.ts) sorts by `vote_score DESC` so the highest-confidence items survive the clip first.

**Recall tool.** `memory.procedures.recall { id? | query?, k? }` — pure read, resource class `pure_read`. By id: returns the full body (incl. `steps[]`) even for `deprecated` rows so postmortems remain possible. By query: BM25 over `activation + steps + tags`, active rows only, capped at `k` (default from `memory.procedures.recallK`). Implementation in [procedures-recall.ts](src/tools/memory/procedures-recall.ts); the response renders steps as `1. <description> [@toolhint]` text — explicitly **text**, never a structured tool-call descriptor, because (invariant 20) the runtime is never allowed to feed those hints into a dispatcher.

**Vote curation.** `VoteStore` was extended with the `procedure` kind ([vote-store.ts](src/memory/voting/vote-store.ts) — fourth `readScoreByKind` / `updateScoreByKind` / `decayByKind` row, `TABLE_BY_KIND.procedure = "procedures"`). The vote grammar's `kind` rule now includes `procedure`; the parser's `VoteAllowlist` interface gained a `procedure: ReadonlySet<number>` field; the decorator's hydrator pulls the matching `ProcedureStore` row when `recalledProcedureIds` is non-empty. The consolidator's `runDeprecationSweep` runs a vote → age → FIFO pass for procedures **after** the analogous lesson sweep, sharing the same `maxDeprecationsPerTick` budget. Decay is uniform across the four kinds (`memory`, `lesson`, `profile`, `procedure`); the `DecayResult` interface gained a fourth `procedures` field, defaulting to `0` when the schema is pre-v10. Metric `agent.memory.voting.decayed{kind=procedure}` fires once per tick.

**Cascade deprecation.** When the lesson sweep demotes a lesson (downvote / aged / overflow), the consolidator immediately calls `procedureStore.deprecateByParentLesson(lessonId, "parent_deprecated")` to demote every active procedure that lists the dying lesson as a parent. Cascade counts roll up into `proceduresDeprecatedByCascade` on the tick result and into the `procedure_deprecated` trace event with `reason: "parent_deprecated"`. Failure-isolated: cascade exceptions never roll back the lesson demotion.

**Trace events.** [trace-event.ts](src/tracing/trace/trace-event.ts) gained `TraceProcedureCreated` (`{ procedureId, parentLessonIds[], parentMemoryIds[], source }`) and `TraceProcedureDeprecated` (`{ procedureId, reason }`); the `VoteApplied` / `VoteRejected` kind unions were widened with `procedure`. Both procedure events are emitted by `ConsolidatorJob` via the same `traceBus` bridge that already carries `lesson_deprecated`, sharing the monotonic `consolidatorSeq` counter so the `<stateDir>/traces/consolidator.ndjson` file stays totally ordered across event kinds within a tick.

**Configuration (`memory.procedures.*`).** Added in user config v17 with idempotent v16→v17 migration. Defaults: `enabled=true`, `recallK=3`, `maxTokens=400`, `indexLimit=12`, `maxEntries=200`, `deprecationAgeMs=14*24*3600*1000` (14 days). Disabling the master switch turns off the prompt section, the consolidator's procedure persist, the recall tool, and the vote allowlist contribution in one move — the store handle stays open for clean shutdown.

**Locked invariants (pinned by tests).**

1. **Invariant 20 — runtime never auto-executes `Procedure.steps`.** The `toolHint` field is plain text guidance; the agent reads it through the `memory.procedures.recall` tool and decides what to do. Pinned by `scorecard-7b.test.ts` ("7b.D — no file in src/ feeds Procedure.steps into tool dispatch") via a static grep gate.
2. **Invariant 21 — distillation still emits exactly one LLM call per cluster.** Procedure is the second slot in the same completion, not a follow-up call. Pinned by `scorecard-7b.test.ts` ("7b.A") and `distill-parser-procedure.test.ts`.
3. **Stable-prefix change is one-shot.** Persona text in [stable-prefix.ts](src/prompt/stable-prefix.ts) mentions `### procedures` and `memory.procedures.recall` once. Mutating it again invalidates KV-cache for every session — never edit the persona block without bumping a planned-deprecation note in `MEMORY_FABRIC_V2.md`.
4. **Pointer-only prompt rendering.** `### procedures` lists `><id> [tags] activation` rows; the `steps[]` body is **never** rendered in the prompt. Drill-down requires an explicit `memory.procedures.recall { id }` call. Pinned by `procedures-renderer.test.ts` and `build-prompt.test.ts`.
5. **Cascade is best-effort, failure-isolated.** `deprecateByParentLesson` exceptions never roll back the parent lesson demotion. Pinned by `consolidator-job.test.ts` ("sweep cascades a downvoted lesson onto its child procedure").
6. **Bounded growth.** `maxEntries` (default 200) + per-tick deprecation cap + vote-aware FIFO eviction order (`vote_score ASC, updated_at ASC, id ASC`) keep the table bounded under all input distributions. Pinned by `procedure-store.test.ts` ("FIFO overflow").
7. **`deprecateByParentLesson(lessonId, reason)` always takes a reason string.** Internal cascade callers pass `"parent_deprecated"`; manual ops paths pass `"manual"`. The reason flows into the trace event and the metric tag. Pinned by `procedure-store.test.ts` ("cascade marks the reason on the trace event").
8. **Vote allowlist is the union of all four kinds.** `VoteAllowlist.procedure` is a real set (possibly empty); the decorator only adds procedure candidates when `recalledProcedureIds` was non-empty on the `ReflectionInput`. Pinned by `vote-parser.test.ts` and `vote-runner.test.ts`.
9. **Graceful parser degradation.** A malformed `PROCEDURE` line yields `procedure: null` — the `LESSON` half still persists. The consolidator records `proceduresCreated += 0` for that cluster without aborting the tick. Pinned by `distill-parser-procedure.test.ts` ("degrades to null when steps quoting is malformed").

**Out of scope (deferred to a future phase, if any).** Multi-lesson procedures (today every procedure points at exactly one parent lesson — the consolidator never produces a single procedure from a multi-cluster merge). Per-`workingDir` procedure scoping (today every procedure is globally visible regardless of where it was distilled). `EDIT` marker for procedure mutation (procedures are append-only; supersession would require a new entity). `useCount` auto-bumping from observed tool-chain match against `steps[]` (today `bumpUse()` is only callable via direct API — agents never trigger it). Operator UI for procedure inspection in TUI (today inspection is via `atomic-agent` CLI + `memory.sqlite` queries).

**TUI surface — single screen, paired daemons, opt-in onboarding.** The "Models" tab in `atomic-agent tui` renders **both** the chat catalog and the embedding catalog on the same screen, separated by a `Embedding models (N) · paired with chat daemon` header. There is **no** catalog-toggle hotkey (the earlier `e` switcher was removed in favour of a single combined cursor). Indices `[0..rows.length-1]` are chat rows; `[rows.length..rows.length+embeddingRows.length-1]` are embedding rows; the shared helper `resolveRowAt(panel, idx)` is the single source of truth for "which row is under the cursor" — both the panel component and the key-binding layer go through it.

Hotkeys are row-type-aware (resolved per-keystroke against the cursor's `LocalModelsRowRef.kind`):

- **j / k / ↑ / ↓** — move the shared cursor across the combined list.
- **Enter** on a chat row — pull (GGUF + mmproj for vision rows), or set active if already downloaded.
- **Enter** on an embedding row — pull the GGUF (auto-flips `localModels.embeddings.{enabled, modelId}` to the row), or set active if downloaded.
- **g** — chat-only GGUF pull (no-op on embedding rows; embedding models are text-only).
- **i** — chat-only info detail (no-op on embedding rows).
- **d** on a chat row — chat-scoped red-bordered remove-confirm modal (`removeConfirmId`).
- **d** on an embedding row — embedding-scoped remove-confirm modal (`embeddingRemoveConfirmId`). The two modals are mutually exclusive at the type level so a stray `y` in the chat modal can never delete an embedding GGUF, and vice versa.
- **E** (shift+e) — toggles `localModels.embeddings.enabled` without restarting any daemon. Operator chains an explicit `s` to apply.
- **s** — drives `startChatAndEmbeddingDaemons` / `stopChatAndEmbeddingDaemons` (paired start and stop — see §"Daemon pairing" below).
- **B / r / L** — backend pull, refresh, jump to LLM Logs.

**Embedding-model onboarding modal.** When a chat-model pull finishes successfully AND no embedding model is currently configured AND no embedding GGUF exists on disk, the orchestrator **defers** the daemon start and emits `local_models_embedding_onboarding_opened` with the default embedding model (`DEFAULT_EMBEDDING_MODEL_ID`, `nomic-embed-text-v1.5` today). The panel renders an accent-bordered yes/no modal:

- **y** — `orchestrator.resolveEmbeddingOnboarding(true)` pulls the default embedding model (flipping `embeddings.enabled = true`) and then starts the paired daemon.
- **n / Esc** — `orchestrator.resolveEmbeddingOnboarding(false)` skips the pull and starts only the chat daemon.

Either branch closes the modal and routes the operator back to chat (`ui_mode_set: chat`) once the start succeeds. The modal is a one-shot detour — it never re-appears after a chat-model pull if an embedding model is already on disk, even if `embeddings.enabled === false` (the operator's explicit "later" choice is respected). Pinned by [src/tui/local-models/local-models-reducer.test.ts](src/tui/local-models/local-models-reducer.test.ts) ("opens and dismisses the embedding onboarding modal") and [src/tui/local-models/local-models-key-bindings.test.ts](src/tui/local-models/local-models-key-bindings.test.ts) (`y` / `n` resolution).

**Daemon pairing on TUI start/stop.** Every TUI code path that touches the daemon flows through `LocalModelsOrchestrator.{startDaemon, stopDaemon, stopDaemonSilent}` and they are wired to the paired entry points:

- `startDaemon` → `startChatAndEmbeddingDaemons({ chat, embedding? })` — chat is fatal-on-failure, embedding is fatal-on-`buildEmbeddingStartOptions=undefined`-only-then-skip (graceful degradation contract). The skip conditions are: `embeddings.enabled=false`, `embeddings.modelId=null`, an unknown id, or the model GGUF is not on disk.
- `stopDaemon` / `stopDaemonSilent` (shutdown) → `stopChatAndEmbeddingDaemons(dataDir)` — always tries to kill both pid files. `stopDaemonSilent` is invoked from `LocalModelsOrchestrator.shutdown()` so closing the TUI tears down both daemons together.
- `autoStartIfReady` (called once at TUI launch) reuses `startDaemon`, so a fresh TUI boot starts both daemons whenever an embedding model is configured + downloaded.

**Pairing reconciliation (`ensureEmbeddingPaired`).** Beyond the symmetric start/stop path, every TUI mutation that touches embedding-side config or model files reconciles the embedding daemon to the pairing invariant — **if the chat daemon is alive, the embedding daemon must be alive iff `embeddings.enabled && modelId is a known catalog entry && GGUF is on disk`**. The helper `LocalModelsOrchestrator.ensureEmbeddingPaired({ hotSwap? })` is the single seam; it is called from:

- `pullEmbeddingModel` after a successful GGUF download (`hotSwap: true` — the new model replaces whatever the daemon was last serving, including the same-name reload edge case).
- `setActiveEmbedding` when the chosen model is already on disk (`hotSwap: true` — model id changed, possibly with a different dim).
- `toggleEmbeddingEnabled` for both directions (no `hotSwap` — `enabled=true` starts when nothing is running, `enabled=false` stops when running).
- `autoStartIfReady` after adopting an externally-started chat daemon (no `hotSwap` — only fills in a missing embedding side, never preempts a healthy one).

When the chat daemon is not running, `ensureEmbeddingPaired` is a no-op: the next paired `startDaemon` call (or `autoStartIfReady` on a cold TUI) handles both sides atomically via `startChatAndEmbeddingDaemons`, which is the cheaper path. The helper uses `startEmbeddingDaemon` / `stopEmbeddingDaemon` (single-side primitives) rather than the paired orchestrator so chat is never inadvertently bounced mid-conversation. All failures degrade gracefully — the embedding side reports the error to the runtime feed and falls back to FTS5-only recall; chat keeps running. Pinned by [src/tui/local-models/local-models-orchestrator-pairing.test.ts](src/tui/local-models/local-models-orchestrator-pairing.test.ts) (five cases: start-when-paired, no-op-when-chat-down, hot-swap, master-switch-off, adoption-pairs).

The "LLM Logs" tab tails `llama-embed.log` next to the chat log in the same viewport (separator: `── llama-embed.log ──`) when the file exists — a missing embedding log is silently skipped so chat-only operators see no difference. `LocalModelsOrchestrator` is the only TUI module that touches `getEmbeddingDaemonStatus` / `startChatAndEmbeddingDaemons` / `pullEmbeddingModel` / `resolveEmbeddingOnboarding` — the orchestrator-as-seam invariant from the chat side extends verbatim.

The three channels share one SQLite file `<stateDir>/memory.sqlite` (separate from `sessions.sqlite`):

| Channel        | Storage table          | Read path (auto)                 | Write path                          |
| -------------- | ---------------------- | -------------------------------- | ----------------------------------- |
| `ProfileStore` | `profile_facts`        | `### profile` (gated)            | `memory.profile.set` + reflection   |
| `MemoryStore`  | `memories` + FTS5      | `### recalled` + `### memory-index` | `memory.notes.store` + reflection|
| Reflection     | n/a — it writes to both| n/a                              | end-of-turn fire-and-forget LLM call|

`MEMORY_SCHEMA_VERSION = 3`; idempotent migrations in [src/memory/memory-schema.ts](src/memory/memory-schema.ts).

### ProfileStore (durable facts, in the prompt tail)

- **Shape.** `profile_facts (key TEXT PK, value TEXT, pinned INTEGER, keywords TEXT, updated_at INTEGER)`. CRUD in [src/memory/profile-store.ts](src/memory/profile-store.ts).
- **Pinned vs contextual.** `pinned=true` (default) facts are always rendered; `pinned=false` facts are rendered only when at least one of their `keywords` hits the current `userMessage` (case-insensitive substring match). Filter applied by [src/memory/profile-renderer.ts](src/memory/profile-renderer.ts), gated by `memory.profile.contextualKeywordGate` (default `true`).
- **Prompt placement.** Rendered as `### profile` in the **variable tail** (after optional `### loaded-skills`, before `### memory-index` / `### session-facts` / `### recalled`). Never the stable prefix. `build-prompt.test.ts` pins the invariant by hashing the stable prefix across profile edits.
- **Budgeting.** `truncateToTokens(content, memory.profile.maxTokens)` (default `512`) with `[truncated]` marker; tokens subtracted from the effective conversation cap in [src/prompt/token-budget.ts](src/prompt/token-budget.ts).
- **Live snapshot.** `AgentLoop` reads `profileStore.list()` once per step via the optional `profileFactsProvider` and threads it into `StepContext.profileFacts` → `buildPrompt`.
- **Tools.** `memory.profile.set { key, value, pinned?, keywords? }`, `memory.profile.remove { key }`, `memory.profile.list {}`.

### MemoryStore (FTS5 freeform notes)

- **Shape.** `memories (id INTEGER PK, content, tags, source, scope, working_dir, created_at, updated_at)` + `memories_fts` virtual table (`porter unicode61`). CRUD in [src/memory/memory-store.ts](src/memory/memory-store.ts). Hard cap `memory.notes.maxEntries` (default `1000`); FIFO eviction by `(updated_at ASC, id ASC)` on overflow.
- **Auto-injection.** Two new tail sections (rendered by [src/memory/notes-renderer.ts](src/memory/notes-renderer.ts)):
  - `### recalled` — top-K BM25 hits against the current `userMessage`. Driven by `memory.recallInjection.{enabled, k, previewChars, maxTokens}` (defaults `k=3`, `previewChars=160`, `maxTokens=400`).
  - `### memory-index` — compact `#id [tags] preview` pointer rows. Driven by `memory.index.{enabled, limit, previewChars, maxTokens}` (defaults `limit=20`, `previewChars=60`, `maxTokens=300`).
  - The two sections are **deduplicated by id** — anything in `### recalled` is filtered out of `### memory-index`.
- **Pre-fetch.** Done once per turn by [src/memory/memory-context-provider.ts](src/memory/memory-context-provider.ts), invoked from `agent-loop.runTurn` before the per-step loop starts. Results land in ephemeral `SessionState.recalledNotes` / `SessionState.memoryIndex`. `stripEphemeral` in [src/session/session-store.ts](src/session/session-store.ts) removes them before snapshot persistence — they are recomputed every turn.
- **Tools.** `memory.notes.store { content, tags?, scope?, workingDir? }`, `memory.notes.recall { query? | id?, scope?, workingDir?, k? }` (`{ id }` is direct lookup for `#42` pointers from `### memory-index`), `memory.notes.forget { id }`. The bulk corpus is **never** dumped wholesale into the prompt.

### Reflection (async end-of-turn memory formation)

- **When.** Fired at the end of every `AgentLoop.runTurn` after `assistant_reply` is emitted. **Fire-and-forget**, never awaited. `abortPending({ sessionId: state.id })` runs at the start of the next `runTurn` so at most one reflection is in flight **per session**; reflections on other sessions are never aborted as a side effect (load-bearing for cross-session parallelism — see §"Concurrency contract").
- **What.** A micro-prompt with its own small stable prefix asks the model to extract durable facts from the last `USER`/`ASSISTANT` exchange. Output is GBNF-constrained to either `NONE` or a bounded list of two flavours:
  - `SET key=value` (pinned fact) or `SET key=value [pinned=false; keywords=a,b,c]` (contextual fact). Caps at `memory.reflection.maxFactsPerCall` (default `3`).
  - `NOTE freeform observation [tag1, tag2]` → into `MemoryStore` with implicit `reflection` tag. Master switch `memory.reflection.autoStoreNotes` (default `true`); cap at `memory.reflection.maxNotesPerCall` (default `2`, set to `0` to disable).
- **KV-cache invariant.** Reflection runs on a **dedicated llama-server slot** reserved at bootstrap via `slotManager.reserveReflectionSlot()`. The main agent slot is never touched. When only one slot is available, reflection falls back to `slotId: -1` (no cache reuse).
- **Writes.** Parsed entries flow through the same validators as the explicit tools (`ProfileStore.set`, `MemoryStore.store`); invalid entries are logged and skipped without failing the whole call.
- **Observability.** `agent.memory.reflection` counter tagged by `outcome` (`ok | none | failed | aborted | timeout`) plus `agent.memory.reflection.latency_ms` histogram. Logs: `reflection.fired`, `reflection.ok`, `reflection.none`, `reflection.aborted`, `reflection.timeout`, `reflection.failed`.
- **Code.** [src/memory/reflection/](src/memory/reflection/) — `reflection-prompt`, `reflection-grammar`, `reflection-parser`, `reflection-runner`.

### Configuration

All keys under `memory.*` in the user config and [src/config/config-schema.ts](src/config/config-schema.ts). Full table in [MEMORY.md §8](MEMORY.md). The most relevant for tuning:

- `memory.profile.{enabled, maxTokens, contextualKeywordGate}`
- `memory.reflection.{enabled, timeoutMs, maxFactsPerCall, autoStoreNotes, maxNotesPerCall}`
- `memory.notes.{enabled, maxEntries, maxContentChars, recallDefaultK}`
- `memory.recallInjection.{enabled, k, previewChars, maxTokens}`
- `memory.index.{enabled, limit, previewChars, maxTokens}`
- `paths.memoryDbFile` — resolved to `<stateDir>/memory.sqlite`.

### Invariants

1. **Stable prefix is untouched by memory writes.** All three memory-aware sections (`### profile`, `### recalled`, `### memory-index`) live strictly in the variable tail. Pinned by `build-prompt.test.ts`.
2. **Reflection never blocks or crashes the loop.** `ReflectionRunner.reflect()` is fire-safe — errors are logged and counted; the agent-visible reply is already returned before reflection starts. Pinned by `slot-manager.test.ts` (slot isolation) and `reflection-runner.test.ts` (error swallowing).
3. **Notes corpus is never dumped wholesale.** Only top-K (`### recalled`) and pointer-only (`### memory-index`) rows go into the prompt; full bodies require an explicit `memory.notes.recall { id }`.
4. **Bounded growth.** Per-call write caps (`maxFactsPerCall` / `maxNotesPerCall`) + storage cap (`maxEntries` + FIFO) + tail caps (`maxTokens` per section) + contextual gating for profile facts ⇒ both the SQLite file and the rendered tail are bounded under all input distributions.
5. **Single validator path per writer.** All `ProfileStore` writes (tool or reflection) go through `ProfileStore.set` validators; all `MemoryStore` writes go through `MemoryStore.store` validators. There is no second back door.
6. **Ephemeral session fields are not persisted.** `SessionState.recalledNotes` / `memoryIndex` are stripped by `stripEphemeral` before `SessionStore` writes the snapshot — they are recomputed each turn against the current user message.

### Explicit out-of-scope

Episodic summaries, `topic`/`expires_at` columns, embeddings / semantic search, importance scoring, content-based deduplication of notes, and secret redaction are deliberately deferred. See [MEMORY.md §10](MEMORY.md) for the known-limitations list.

### Memory v2.5 — phase A heuristic-gated query rewriter (opt-in)

A new module [src/memory/retrieve/](src/memory/retrieve/) adds an LLM-based **query rewriter** that runs **before** `MemoryStore.recallHybridAsync` whenever the current user message looks **referential** (short, pronoun-laden, conjunction-starter). The rewriter expands "did they mention it?" into a self-contained query using the trailing 2-3 conversation turns; non-referential messages bypass the rewriter entirely and use the raw query. The whole layer is wrapped as a **decorator** around `createDefaultMemoryContextProvider` so the byte-output is identical to v2 when the flag is off.

**Rewriter gate (`gateMode`).** Config v20 adds a pluggable `RewriterGate` ([rewriter-gate.ts](src/memory/retrieve/rewriter-gate.ts)) selected by `memory.retrieve.rewriter.gateMode`:

| Mode | Implementation | When to use |
|---|---|---|
| `heuristic` (product default) | `isReferentialMessage` word lists | Low latency, no embedding daemon required |
| `embedding` | Cosine vs curated EN exemplars via `EmbeddingClient` | Multilingual / long self-contained questions (LoCoMo Temporal) |
| `always` | Always fire when history is non-empty | Debug / eval only |

**Heuristic gate.** `isReferentialMessage(msg, historyLen)` in [referential-detector.ts](src/memory/retrieve/referential-detector.ts) is a pure function — no I/O, no state. **16 whitespace-tokenized languages:** en, ru, es, de, fr, pt, it, nl, pl, tr, ar, he, hi, vi, id, ko. Returns `true` when any of:

- Length ≤ 5 words AND no leading question word from the multilingual allowlist. A short message asking "what is X?" is **not** referential because it carries its own anchor.
- Contains any pronoun from the allowlist (`it`, `they`, `eso`, `das`, `ça`, `то`, …).
- Starts with a conjunction (`and`, `but`, `y`, `und`, `et`, `и`, `но`, …).

**CJK / Thai deferred on heuristic.** Languages without inter-word spaces (zh, ja, th) do not tokenize under `split(/\s+/)` — use `gateMode: "embedding"` instead (`Intl.Segmenter` heuristic support is a follow-up).

**Embedding gate.** [embedding-gate.ts](src/memory/retrieve/embedding-gate.ts) lazy-warms unit-normalized vectors for `DEFAULT_REWRITER_EXEMPLARS` (or `embeddingGate.exemplars`), embeds the user message, and fires when `max(cosine) >= embeddingGate.threshold` (default `0.65`). Fail-safe **B**: any warm or per-call `EmbeddingUnavailableError` → skip rewrite + `embedding_gate.unavailable` log (same outcome as `skipped_not_referential`). Requires the phase-1B embedding daemon; bootstrap falls back to heuristic + warns when `gateMode=embedding` but no `embeddingClient`.

When the gate returns `false`, the recall layer is byte-identical to v2: no LLM call, no rewriter prompt, no rewriter slot reservation. When it returns `true`, the rewriter runner fires (see below).

**Runner.** [query-rewriter-runner.ts](src/memory/retrieve/query-rewriter-runner.ts) orchestrates a single LLM call:

- **Prompt** ([query-rewriter-prompt.ts](src/memory/retrieve/query-rewriter-prompt.ts)) — small stable prefix + variable tail with the last K turns and the current ambiguous message. The model is told to emit a single `<rewritten_query>...</rewritten_query>` envelope or the literal token `NONE` when no rewrite is possible.
- **Grammar** ([query-rewriter-grammar.ts](src/memory/retrieve/query-rewriter-grammar.ts)) — `root ::= "<rewritten_query>" body "</rewritten_query>"` with `body ::= [^<]{1,400}`, plus a `NONE` alternative for explicit abstain.
- **Parser** ([query-rewriter-parser.ts](src/memory/retrieve/query-rewriter-parser.ts)) — length-clamps the body, returns `null` on the `NONE` token, fails closed on malformed input (caller falls back to raw query).
- **Slot.** `slotId: -1` always — see invariant 1 below.
- **Timeout.** Hard cap `memory.retrieve.rewriter.timeoutMs` (default 3000ms). On timeout/abort/parse-failure, the runner returns the raw user message and the recall layer continues.

**Decorator** [rewriter-aware-recall-provider.ts](src/memory/retrieve/rewriter-aware-recall-provider.ts) wraps an inner `MemoryContextProvider`. It intercepts `buildMemoryContext({ userMessage, recentTurns, ... })`, fires the rewriter when both (a) the gate matches and (b) `recentTurns.length > 0`, then forwards a (possibly) rewritten `userMessage` to the inner provider. Everything else (`### memory-index`, lesson recall, profile rendering) is untouched.

**`MemoryContextProviderInput.recentTurns`.** The decorator needs trailing user/assistant context, but `MemoryContextProviderInput` did not carry it pre-v2.5. The interface was extended with an optional `recentTurns: readonly { role: "user" | "assistant"; text: string }[]` — populated by `agent-loop.refreshMemoryContext` via the new helper `collectRecentUserAssistantTurns(state, options.userMessage)`. Older providers that never read the field stay byte-stable; the default provider ignores it.

**Locked invariants** (pinned by [referential-detector.test.ts](src/memory/retrieve/referential-detector.test.ts), [query-rewriter-parser.test.ts](src/memory/retrieve/query-rewriter-parser.test.ts), [query-rewriter-runner.test.ts](src/memory/retrieve/query-rewriter-runner.test.ts), [rewriter-aware-recall-provider.test.ts](src/memory/retrieve/rewriter-aware-recall-provider.test.ts)):

1. **Rewriter always uses `slotId: -1`.** The main agent slot's KV cache is **never** touched by the rewriter call; the reflection slot is also untouched (the rewriter is a recall-side concern, not a reflection-side concern). Pinned by `query-rewriter-runner.test.ts` ("uses slotId -1 to keep the main agent and reflection slots untouched").
2. **Fire-safe.** Any rewriter failure (timeout / abort / malformed completion / parser error) folds to "use the raw user message". The recall never blocks and never raises — pinned by `query-rewriter-runner.test.ts` (multiple cases) and the `outcome` taxonomy on `agent.memory.retrieve.rewriter`.
3. **Disabled by default.** With `memory.retrieve.rewriter.enabled = false`, the bootstrap does not construct a rewriter runner; the inner `MemoryContextProvider` is returned as-is. The recall path is byte-identical to v2.
4. **Heuristic gate is pure.** No I/O, no state — easy to assert across a matrix of inputs. Pinned by `referential-detector.test.ts`.
5. **Empty history is a hard skip.** Even when the gate fires, the rewriter is not called if `recentTurns` is empty (nothing to anchor against) — outcome `skipped_no_history`, raw query is used. Pinned by `rewriter-aware-recall-provider.test.ts`.

**Configuration.** Added in user config v18; gate modes in v20 — older files transparently migrate with the block disabled / `gateMode: heuristic`.

- `memory.retrieve.rewriter.enabled` (default `true`, config v21).
- `memory.retrieve.rewriter.timeoutMs` (default `3000`).
- `memory.retrieve.rewriter.historyTurns` (default `3`).
- `memory.retrieve.rewriter.gateMode` (default `"heuristic"`). Eval `on` profile in [eval-memory/harness/memory-profiles.ts](eval-memory/harness/memory-profiles.ts) defaults to `"embedding"`.
- `memory.retrieve.rewriter.embeddingGate.threshold` (default `0.65`).
- `memory.retrieve.rewriter.embeddingGate.exemplars` (default `null` → built-in EN list).

**Metrics.** [agent-metrics.ts](src/tracing/agent-metrics.ts):

- Counter `agent.memory.retrieve.rewriter` tagged by `outcome ∈ {ok, skipped_not_referential, skipped_no_history, aborted, timeout, failed}`.
- Histogram `agent.memory.retrieve.rewriter.duration_ms`.
- Counter `agent.memory.retrieve.rewriter.gate.fired` (tagged `gate_mode`).
- Counter `agent.memory.retrieve.rewriter.gate.skipped` (tagged `gate_mode` + `reason ∈ {below_threshold, no_history, unavailable, empty_message}`).
- Histogram `agent.memory.retrieve.rewriter.gate.cosine_score` (embedding mode only).

### Memory v2.5 — phase B sliding-window reflection segmentation (opt-in)

Instead of firing reflection after **every** turn (legacy behaviour), accumulate the last N user/assistant pairs and fire reflection over the whole window every K turns. Both K and W are config; the legacy per-pair micro-reflection comes back when the flag is off.

**Trigger logic** in [src/agent/agent-loop.ts](src/agent/agent-loop.ts) (`runTurn` reflection block):

- **Segmentation disabled (default).** Fire on `reason === "reply"` only when a user message arrived this turn. Single-pair prompt — byte-identical to v2.
- **Segmentation enabled.**
  - On `reply`: fire iff `state.turnCount > 0 && state.turnCount % triggerEveryTurns === 0`. Skip otherwise.
  - On `finish`: **always** fire (final flush — see invariant 1 below). Skip silently when no user/assistant pair exists in the session yet.
  - On every fire: pack the last `windowTurns` user/assistant pairs into `ReflectionInput.transcript` via `collectLastUserAssistantPairs(state, windowTurns)`. The trailing pair's `user` / `assistant` content is mirrored into the existing `userMessage` / `assistantReply` fields so the runner contract stays satisfied for downstream sub-calls (link-generator, vote-runner) that still read those scalar fields for the per-turn anchor.

**Pair projection.** `collectLastUserAssistantPairs` walks `state.turns` forward, pairing each `user` row with the **next** `assistant_reply` row. Intervening tool calls / results are ignored — the reflection prompt only consumes the human/agent text. Orphan trailing `user` rows (no reply yet) are dropped so every entry in the window is complete.

**Prompt rendering.** [src/memory/reflection/reflection-prompt.ts](src/memory/reflection/reflection-prompt.ts) `buildReflectionPrompt` accepts the new optional `transcript` field. When present and non-empty, the tail renders:

```
### turn 1
USER: ...
ASSISTANT: ...
### turn 2
USER: ...
ASSISTANT: ...

### output
```

When `transcript` is omitted (or empty), the legacy single-pair tail (`USER: ...\nASSISTANT: ...`) is byte-identical to v2. The **stable prefix** (`REFLECTION_STABLE_PREFIX` / `REFLECTION_STABLE_PREFIX_TYPED`) is unchanged — segmentation lives entirely in the variable tail.

**Locked invariants** (pinned by [agent-loop-segmentation.test.ts](src/agent/agent-loop-segmentation.test.ts), [reflection-prompt.test.ts](src/memory/reflection/reflection-prompt.test.ts) phase-B cases):

1. **Final flush on `finish`.** When `reason === "finish"` and segmentation is enabled, reflection fires unconditionally so the trailing partial cadence window is never lost. Pinned by `agent-loop-segmentation.test.ts > "'finish' always triggers the final flush even mid-cadence"`.
2. **Disabled by default.** With `memory.reflection.segmentation.enabled = false`, the loop fires reflection once per `reason: "reply"` with a single-pair prompt and no `transcript` field on `ReflectionInput` — byte-stable with v2. Pinned by `agent-loop-segmentation.test.ts > "disabled (default): fires reflection on every reply without a transcript"`.
3. **No new periodic timer.** Trigger is a per-turn check inside `agent-loop.runTurn` — not a `setInterval`. Respects the §"Background autonomy" carve-out invariant; the `Scheduler` and the consolidator's scoped `setInterval` remain the only periodic timers in the runtime.
4. **Cross-session parallelism untouched.** The cadence counter is `state.turnCount` on the per-session `SessionState`; a fire on session A never influences session B's cadence. Pinned by `agent-loop-segmentation.test.ts > "cross-session reflections stay scoped to their own sessionId"`.
5. **Stable-prefix bytes are not affected.** The transcript window lives in the tail; both `REFLECTION_STABLE_PREFIX` and `REFLECTION_STABLE_PREFIX_TYPED` are byte-identical between a single-pair and a windowed call. Pinned by `reflection-prompt.test.ts > "phase B: keeps the stable prefix byte-identical when transcript is present"`.
6. **Pair completeness.** `collectLastUserAssistantPairs` only emits complete `{ user, assistant }` pairs — orphan trailing user rows are dropped. The transcript window is always chronological (oldest first).
7. **`finish` on an empty session is a silent no-op.** No runtime error, no crash, no reflection fired (no pair to extract from). Pinned by `agent-loop-segmentation.test.ts > "a 'finish' on an empty session skips reflection"`.

**Configuration.** Added in user config v18 — older files transparently migrate with the block disabled.

- `memory.reflection.segmentation.enabled` (default `false`).
- `memory.reflection.segmentation.triggerEveryTurns` (default `3`).
- `memory.reflection.segmentation.windowTurns` (default `5`).

**Out of scope.** No LLM-driven topic/judger segmentation on reflection — the counter-based gate plus final-flush invariant is sufficient for v2.5. No persistence of pending-window state beyond `SessionState.turns[]` (already there). No cross-session cadence aggregation.

### Memory v2.5 — phase C typed NOTE extraction (opt-in)

Force the reflection LLM to tag every `NOTE` with one of four semantic buckets (`event` / `behavior` / `knowledge` / `skill`) using a `[type=X]` marker immediately after `NOTE `. The marker is parsed into a synthetic `type:X` tag on the stored `MemoryEntry.tags` JSON array — **no schema change**, no migration, no new entity. FTS5 indexes the tag for free; phase 2 link-graph, phase 5 lessons, phase 7a votes all keep working unchanged.

**Grammar.** [src/memory/reflection/reflection-grammar.ts](src/memory/reflection/reflection-grammar.ts) was extended:

```
note      ::= "NOTE " typemark? body "\n"
typemark  ::= "[type=" notetype "] "
notetype  ::= "event" | "behavior" | "knowledge" | "skill"
```

`typemark` is **optional** so legacy untyped completions emitted by older prompts still validate cleanly — the grammar accepts both shapes; the prompt is what makes the typed shape canonical when the flag is on. The marker requires a trailing space (mirrors the rule body) so a malformed `[type=event]body` line is treated as untyped — the body is preserved, no synthetic tag emitted.

**Parser.** [src/memory/reflection/reflection-parser.ts](src/memory/reflection/reflection-parser.ts) recognises `[type=X] ` on `NOTE ` lines and projects `X` into a synthetic tag `type:event` / `type:behavior` / `type:knowledge` / `type:skill` (allowlist `NOTE_TYPE_ALLOWLIST`). Unknown types are dropped silently — the body still parses but no synthetic tag is emitted (fail-open on tag, never lose the observation). The synthetic tag is **prepended** to the parsed `[tags=...]` list so consumers can sort/filter by `type:*` prefix; cap is the shared `NOTE_MAX_TAGS = 10`.

**Prompt.** Two stable prefixes coexist:

- `REFLECTION_STABLE_PREFIX` — legacy v2 untyped prompt (untouched).
- `REFLECTION_STABLE_PREFIX_TYPED` — typed prompt with per-type guidance and forbidden lists.

`buildReflectionPrompt({ typedNotes: true })` picks the typed prefix; otherwise the legacy prefix. The two prefixes are byte-stable module-level constants so each owns its own KV cache slot on the reflection daemon — flipping the flag invalidates **the reflection slot's** KV cache once on the next call; the **main agent slot is unaffected** (the agent prompt never carries either reflection prefix). This is the same one-shot pattern phase 4 introduced for the bi-temporal prompt extension.

**Per-type contracts:**

- `[type=event]` — a specific happening at a particular time, with participants/location when known. Never a recurring routine.
- `[type=behavior]` — a recurring pattern, routine, or established solution. **Never** a single one-off event.
- `[type=knowledge]` — static factual content the user knows or works with (concepts, definitions, domain lore). **Never** events or behaviors.
- `[type=skill]` — a replicable how-to with concrete tools, steps, and outcomes. **Never** trivial actions ("used Docker") or pure opinions.

**Locked invariants** (pinned by [reflection-grammar.test.ts](src/memory/reflection/reflection-grammar.test.ts), [reflection-parser.test.ts](src/memory/reflection/reflection-parser.test.ts) phase-C cases, [reflection-prompt.test.ts](src/memory/reflection/reflection-prompt.test.ts) phase-C cases):

1. **No schema migration.** `type` lives as a string tag on the existing `memories.tags` JSON column. FTS5 indexes it for free.
2. **Backward compatible.** Legacy untyped NOTEs from older sessions still load and recall correctly — `type:*` tag is just absent. Pinned by `reflection-parser.test.ts > "phase C: parses a legacy untyped NOTE line without a type tag"`.
3. **Unknown types fail open.** A `[type=foo] body` line drops the unknown marker silently and stores the body without a synthetic tag — never loses the observation. Pinned by `reflection-parser.test.ts > "phase C: drops an unknown type marker"`.
4. **One-time KV cache invalidation on the reflection slot.** Flipping `memory.reflection.typedNotes.enabled` swaps the stable prefix between two module-level constants; each is byte-stable across calls. The **main agent slot is untouched** (the reflection prefix is never rendered into the agent prompt). Pinned by `reflection-prompt.test.ts > "phase C: typed prefix is byte-stable across calls (KV-cache hygiene)"`.
5. **Phase B composes cleanly.** When both `typedNotes` and `transcript` are passed to `buildReflectionPrompt`, the typed prefix is used and the tail renders as numbered `### turn N` blocks. Pinned by `reflection-prompt.test.ts > "phase B: composes with typedNotes=true"`.
6. **Existing v2 tests stay green.** All phase 1B / 2 / 3 / 5 / 7a / 7b tests continue passing because no entity shape changed — `type:*` is just another tag.

**Configuration.** Added in user config v18 (bundled with phases A and B in a single version bump for atomic migration).

- `memory.reflection.typedNotes.enabled` (default `false`).

**Out of scope.** No `content` column on `MemoryEntry` to carry semantic type structure (the marker is in `tags` only). No automatic re-typing of legacy untyped rows. No agent-facing `memory.notes.recall { type: "event" }` shorthand (use `query: "type:event"` against FTS5 instead — same effect).

## Concurrency contract

Every entry point into the runtime — CLI, TUI, HTTP, sidecar, scheduler, and webhook ingress — funnels through one primitive: `TurnController` in [src/runtime/turn-controller.ts](src/runtime/turn-controller.ts). It is the **only** path into `AgentLoop.runTurn`. The defunct `src/http/turn-hub.ts` is gone; its global serialization invariants are now enforced per session.

### Invariants (locked, pinned by [src/runtime/turn-controller.test.ts](src/runtime/turn-controller.test.ts))

1. **Per-session FIFO.** At most one `runTurn` is in flight per `sessionId`. Two concurrent `enqueue` calls on the same session run strictly in submission order.
2. **Cross-session parallelism.** Different `sessionId`s run concurrently — there is no global queue. This is the property Option 4 (cron / wakeups) was designed to consume.
3. **No preemption, no priorities.** Scheduler-origin submissions queue behind in-flight user submissions on the same session, and vice versa. All `TurnOrigin`s (`cli | tui | http | sidecar | scheduler`) are equal citizens.
4. **Per-session event hook.** `submission.eventHook` is installed before `run()` starts and cleared in `finally`. A hook on session A never sees events from session B. Routing is keyed by `sessionId` stored in an `AsyncLocalStorage` set in `bootstrap.ts` around every `executeTurn` call.
5. **Per-session recorder.** `currentRecorder` is no longer a global pointer; recorders are lazy-created per `sessionId` and dispatched via the same `AsyncLocalStorage`.
6. **Aborted submission rejects fast.** `submission.signal` races the queue wait — a cancelled submission rejects without ever calling `run()`.

### Ownership of shared resources

| Resource | Owner | Safe under cross-session parallelism? |
|---|---|---|
| `PlaywrightBackend` | The active turn on each session | **Yes per-session** — `TurnController` guarantees one turn touches the browser at a time within a session. **Cross-session sharing is an accepted product constraint:** there is one browser profile per process, so concurrent sessions see the same window. Cron-driven sessions must account for this. |
| `SlotManager` | Each `runTurn` (acquire-per-step) | **Yes** — `acquire` for a single session is sequential by `TurnController` invariant; different sessions have separate slot assignments and the round-robin pointer is integer-mutating. See doc-comment in [src/llm/slot-manager.ts](src/llm/slot-manager.ts). |
| `ApprovalGate` | Per-session pending request | **Yes** — at most one pending approval per session by design. |
| `ProfileStore` / `MemoryStore` / `SessionStore` | Anything holding a handle | **Yes** — all three use `better-sqlite3`, which is **synchronous**: there is no race window between read and write inside a single statement, so concurrent sessions are safe. **This is a load-bearing assumption.** Replacing the driver with an async one would require a redesign. |
| `ReflectionRunner.pending` | Per-session `Map<sessionId, AbortController>` | **Yes** — reflection on session A is never aborted by reflection on session B. `agent-loop.runTurn` calls `reflectionRunner.abortPending({ sessionId: state.id })` at the start of every turn so a stale reflection from the previous same-session turn cannot race the next one. `abortPending()` with no argument cancels every in-flight reflection (used at runtime shutdown). |
| Trace recorder | Per-session, dispatched via `AsyncLocalStorage` | **Yes** — no global pointer to mix traces across sessions. |
| `SteeringInbox` | Per-session `Map<sessionId, string[]>`, drained only by the turn running on that session | **Yes** — a steer on session A is invisible to session B, and only one turn per session can drain (`TurnController` invariant 1). |

### What the scheduler / webhook paths may and may not assume

- **May** enqueue any session via `runtime.turnController.enqueue({ origin: "scheduler", … })` or `runtime.runTurn(session, msg, { origin: "scheduler" })`.
- **May** introspect via `turnController.isBusy(sessionId)` / `busySessionIds()` and decide between "enqueue and wait" or "skip this tick".
- **May not** preempt user turns or claim a separate priority queue — there is none.
- **May not** assume exclusive browser ownership across sessions; the browser is shared at process scope (see table).
- **Must not** hold a stale `SessionState` reference between `enqueue` and `run`. `executeTurn` writes its result to `sessionStore`; the correct pattern is to **re-read the latest session inside the queued callback** (see [src/sidecar/main.ts](src/sidecar/main.ts) `send_message` for the canonical example).

### Mid-turn steering

Per-session FIFO is correct for *starting* turns and wrong for *correcting* one. An operator who watches the agent head the wrong way should not have to abort the turn or wait it out to say "no, do X instead". `SteeringInbox` ([src/runtime/steering-inbox.ts](src/runtime/steering-inbox.ts)) is the out-of-band channel for that, and it is deliberately **not** a second queue:

- **It never starts a turn.** `runtime.steer(sessionId, text)` returns `false` when `turnController.isBusy(sessionId)` is false, and queues nothing. A `false` return means "not steered" — the caller falls back to `runTurn` or to its own pending-message queue. There is still exactly one path into `AgentLoop.runTurn`.
- **It lands at a step boundary.** `AgentLoop.runTurn` drains the inbox at the top of every step, before building that step's prompt. Effect is visible one step later at the earliest — never mid-inference, never mid-tool-call. A turn parked in a long `os.shell.run` will not react until that call returns.
- **It writes to the transcript.** Each drained message is recorded as a real `user` `ConversationTurn`. The transcript must reflect what the operator actually said; `packConversation` already guarantees the last `user` turn stays visible, and `findCurrentMacroTurnStart` treats the steer as part of the macro-turn in progress. Note this **does** count toward reflection segmentation cadence (`state.turnCount` is untouched, but the turn list grows) — a steer is a real user message, so that is the intended reading.
- **It shares `### notice` with the loop detector.** Both write the one-shot notice slot; `composeSteerNotice` ([src/agent/steer-notice.ts](src/agent/steer-notice.ts)) appends rather than overwrites, loop-detector text first. The message text is repeated inside `### notice` even though it is already in `### conversation`: the notice sits immediately before `### respond`, which is the block small local models reliably act on. Long pastes are clipped inline and point back at the transcript copy.
- **Nothing is silently lost.** A message pushed after the loop's final drain — during the last inference, or into a turn that was cancelled before it stepped — comes back on `RunTurnResult.undelivered`. Callers MUST re-route it (the TUI pushes it onto its pending-message queue). `shutdown()` calls `clearAll()` so a stale steer cannot resurface in a later process.
- **Bounded.** `MAX_PENDING_STEERS` (16) per session; `push` refuses past the cap rather than evicting the oldest, so the caller learns the message did not land.

**Host surfaces.** The sidecar exposes it as the `steer_message` NDJSON request (`{sessionId, text}` -> `{steered}`) plus the `steer_applied` / `steer_undelivered` events; `serve` exposes `POST /api/sessions/{id}/steer` with body `{text}` — `200 {steered:true}`, `409` when the session is idle (the message is refused, not swallowed — retry with `POST /v1/chat/completions`), `429` when the inbox is full. Neither handler goes through `turnController.enqueue`: enqueueing would park the message behind the turn it is meant to redirect.

**Every host surface consumes `undelivered`.** Accepting a steer is a promise to say where it ended up, so no surface may drop `RunTurnResult.undelivered`:

- **Sidecar.** `send_message` emits one `steer_undelivered` event per stranded message. The host owns it from there.
- **HTTP.** `POST /api/sessions/{id}/steer` and the turn that would have carried the message are different exchanges — the steer was answered long before the turn closed, and the completion response goes to whoever owns the turn, who is not necessarily whoever steered. So the route that ran the turn ([src/http/openai-chat-completions.ts](src/http/openai-chat-completions.ts)) always parks the hand-back in `UndeliveredSteerStore` ([src/http/undelivered-steers.ts](src/http/undelivered-steers.ts)), on the success, failed and threw paths alike, and additionally mirrors it onto that response where one can carry it: `undelivered_steers` on the non-stream `chat.completion` body (absent when the turn delivered everything), an `event: steer_undelivered` SSE frame for extensions-opt-in streams (a vanilla OpenAI stream stays strict). The mirrored entries carry the parked `seq`, so they are the same message, not a second copy. Hosts read parked messages with `GET /api/sessions/{id}/steer` and acknowledge with `DELETE /api/sessions/{id}/steer?through={seq}&discarded={n}` (either parameter alone is fine; at least one is required); reads are non-destructive because a retried or prefetched `GET` must not be able to lose the text, and the ack is by cursor so a steer parked between the two calls survives. `DELETE /api/sessions/{id}` drops that session's parked messages with the row. The store is per-server and in-memory (bounded by `MAX_PARKED_STEERS` per session and `MAX_PARKED_SESSIONS` sessions), matching the inbox it drains from — neither survives a restart. Two properties the cap must not break: **`discarded` is acked separately** from the entries — the discarded messages have no `seq` the host was ever shown, so the entry cursor cannot stand in for having read the loss count, and a box outlives its entries while a loss is unacknowledged (still reclaimed by the session purge and by session eviction); and **a hand-back is returned whole** — the cap evicts only entries parked by *earlier* calls, never the batch it was just handed, because that return value is what becomes `undelivered_steers` / `steer_undelivered` and trimming it would omit messages from the one payload meant to carry them.
- **Anything else that calls `runTurn` directly** (task runner, channels) inherits the same obligation.

Pinned by [src/runtime/steering-inbox.test.ts](src/runtime/steering-inbox.test.ts), [src/agent/steer-notice.test.ts](src/agent/steer-notice.test.ts), [src/agent/agent-loop-steering.test.ts](src/agent/agent-loop-steering.test.ts) (injection at the next step, one-shot notice, transcript turn, undelivered on reply / on cancel, no-op without the dep) the steering cases in [src/runtime/bootstrap.test.ts](src/runtime/bootstrap.test.ts), [src/sidecar/steer-message.test.ts](src/sidecar/steer-message.test.ts) (resolves while a turn is blocked mid-inference) the `POST|GET|DELETE /api/sessions/{id}/steer` cases in [src/http/route-sessions.test.ts](src/http/route-sessions.test.ts) (accepted-then-stranded steer retrieved, resent and acked over the real routes; the discard notice surviving an entry ack), [src/http/undelivered-steers.test.ts](src/http/undelivered-steers.test.ts) (non-destructive read, cursor ack, separate discard ack, whole-batch hand-back, cap accounting) and the undelivered cases in [src/http/openai-chat-completions.test.ts](src/http/openai-chat-completions.test.ts) (body field, SSE event, parked on the 500 path).

### Extension points

- `TurnController.isBusy(sessionId)` / `busySessionIds()` — observability hook for UI and scheduler.
- `TurnController.emit(sessionId, event)` — single dispatch path for `AgentLoopEvent` to the per-session hook.
- `runtime.steer(sessionId, text)` — fold a message into the turn already running on that session. Returns `false` (and queues nothing) when the session is idle. See §"Mid-turn steering".
- `runtime.executeTurn(session, msg, opts)` — bypasses the queue. Used by sidecar from inside an already-acquired `enqueue` callback so it does not deadlock against itself. CLI / TUI / HTTP go through the public `runtime.runTurn` instead.

### Risk (acknowledged)

The three existing callers (CLI / HTTP / sidecar) relied on subtle hook timing through `TurnHub` / inline `onAgentEvent`. The hook contract on `TurnController` matches the defunct `TurnHub.runExclusive` byte-for-byte (hook installed before `run()`, cleared in `finally`), so single-session callers are observably identical. New surface tests cover the cross-session and same-session-FIFO behaviour: [src/http/openai-chat-completions.test.ts](src/http/openai-chat-completions.test.ts), [src/sidecar/send-message-concurrency.test.ts](src/sidecar/send-message-concurrency.test.ts), [src/memory/reflection/reflection-runner.test.ts](src/memory/reflection/reflection-runner.test.ts).

## Privacy tab (analytics + approvals)

The `atomic-agent tui` Manage pane hosts the trust-and-safety switches on one screen: the anonymous-analytics opt-out (`a`, shared by product analytics and crash reporting) and the five-step **approval ladder** over the approval gate (`1`..`5` jump, `←`/`→` step; level 5 is rendered in the error color and states the cost plainly). State slice `state.privacyPanel` in [src/tui/tui-state.ts](src/tui/tui-state.ts); modules live under [src/tui/privacy/](src/tui/privacy/) and follow the standard panel pattern — pure `privacy-panel-state` + `privacy-actions` + `privacy-panel-reducer`, dedicated `privacy-key-bindings`, and `PrivacyOrchestrator` as the **only** TUI module that persists `analytics.enabled` / `agent.approvalLevel` and hot-applies them (`runtime.setAnalyticsEnabled`, `runtime.setApprovalLevel`).

The ladder (`agent.approvalLevel`, config v37; the binary `agent.approvalRequired` migrates: `false` → 5, `true`/absent → 1). Every `requireApproval` call site names an `ApprovalCategory` (closed union in [src/approval/approval-level.ts](src/approval/approval-level.ts)); the gate auto-approves a request when `level >= AUTO_APPROVE_FROM_LEVEL[category]` — an O(1) record lookup, cumulative by construction:

| Level | Name | Stops asking for |
|---|---|---|
| 1 | paranoid (default) | nothing — every gated action asks |
| 2 | workspace | `fs_write_workspace`: `os.fs.{write,edit,patch}` strictly inside the session cwd (realpath containment via [src/tools/os/fs-approval-scope.ts](src/tools/os/fs-approval-scope.ts); symlinks pointing outside are classified by their target) |
| 3 | home | + `fs_write_home` (writes anywhere under the home directory, plus `os.fs.archive.extract` even into the workspace), `fs_trash`, `http` (SSRF guard is not part of the gate and stays on) |
| 4 | operator | + `shell` (guard verdict `approval_required` only), `script` (`skill.run_script`), `proc_kill` |
| 5 | full trust | everything, including `browser_nonweb` (file://, javascript:), `trust_config`, and `other` |

Categorisation lives at the call sites (fs tools resolve workspace/home/outside from the target path + `ctx.workingDir`); a write outside both the workspace and home maps to `other`, which asks on every level except 5 — the conservative default for anything a call site cannot place. Hardline shell-guard rules fire before the gate and block at **every** level. MCP tools stay outside the gate entirely (their `approval_gated` resource class only forces solo execution).

**One funnel for fs mutations.** Every fs-mutating tool (`os.fs.{write,edit,patch,trash,archive.extract}`) routes its prompt through `requireFsApproval` ([src/tools/os/fs-require-approval.ts](src/tools/os/fs-require-approval.ts)), which categorises (`categorizeFsMutation`) and calls the shared `requireApproval` in one step. A new mutate-tool cannot half-wire the ladder — classify against the wrong scope inputs or forget the `trust_config` guard — because the scope inputs (`workingDir`, `trustConfigPaths`) travel in the same request object as the prompt copy. The `kind` discriminator (`write` / `trash` / `extract`) selects the categorisation branch; `extract`'s directory-target exemption from the trust-config guard is encapsulated there (it passes `destDir` and the guard never fires).

**The tools layer does not know where the trust surface lives.** `trustConfigPaths` is injected exactly like `workingDir` comes from `ctx`: the bootstrap resolves `config.json` + `.env` once via `getTrustConfigPaths(config.paths)` ([src/config/config-file.ts](src/config/config-file.ts)) and threads the list through `registerOsTools` into each fs tool. `fs-approval-scope.ts` no longer reads `getConfig()`; an omitted / empty `trustConfigPaths` simply disables the guard. This keeps the escalation-guard surface a bootstrap-owned decision, not a tools-layer lookup.

**Escalation guard — `trust_config` (asks until level 5).** The state dir sits under `$HOME`, so `<stateDir>/config.json` (which holds `agent.approvalLevel`) and `<stateDir>/.env` (API keys / bot tokens the runtime loads at boot) would otherwise be `fs_write_home` and go silent at level 3. That is a self-escalation vector: a model at level 3 or 4 could `os.fs.write`/`edit`/`patch`/`trash` its own config to level 5 (or swap a token) with no prompt, and the next boot comes up on full trust. `categorizeFsMutation` therefore compares each write/trash target's realpath (and dangling-symlink target) against the **injected** `trustConfigPaths` (resolved once in the bootstrap, see above) and returns `trust_config` on a match — pinned at level 5 in `AUTO_APPROVE_FROM_LEVEL`, so it always asks below full trust. Match is by canonical path, not string, so a symlink or `..` detour is caught; a not-yet-existing `.env` on a fresh install still matches via the deepest-existing-ancestor comparison. Extraction is exempt (it targets a directory, not the file). `.env` is protected identically to `config.json` on purpose: it is the other half of the trust surface (a silent token swap is account takeover, not just a config bump).

**Dangling-symlink containment.** `canonicalizeMutationTarget` classifies by where a write actually lands. For an existing path `realpath` follows links. For a **dangling** leaf symlink (`leak.txt` → a not-yet-existing file outside the workspace) `realpath` throws ENOENT; naively re-gluing the leaf to its parent would call it a workspace write, but `writeFile` follows the link and creates the file at the target. So on ENOENT we `lstat` the leaf, and if it is a symlink we resolve its target (recursively, chain-bounded) and classify that instead. Only a genuinely new file (non-symlink ENOENT leaf) uses the deepest-existing-ancestor fallback, whose missing suffix cannot contain symlinks because it does not exist. This is what makes the panel's "symlinks pointing outside still ask" copy true for broken links too.

**Level changes are machine-local (Telegram carve-out, by design).** `/privacy level` exists only in the TUI / CLI, not the Telegram inbound-handler. The ladder is a persistent trust posture for *this host* — it decides what runs unattended — so raising it should require access to the physical machine, not a remote chat. The Telegram operator still approves or denies each gated action per-request through `ApprovalBridge`; only the durable level is TUI/CLI-local. A compromised bot token therefore cannot silently raise the standing trust level.

Slash commands: `/privacy` opens the tab; `/privacy analytics on|off|status` drives analytics (`/analytics` stays as the top-level alias); `/privacy level 1..5` moves the ladder; `/privacy approve on|off` survives as the alias pair for levels 5 and 1. The approval prompt itself points here — its footer says approving with `y` grants one call and the ladder lives on the Privacy tab.

### Session grants (prompt-side approval, issue #79)

On top of the standing ladder the approval prompt offers two point exceptions, keyed at the prompt and scoped to the current session only. `[s]` ("allow this kind this session") approves the call and grants the whole `ApprovalCategory`; `[a]` ("allow all `<binary>` this session") approves and grants one shell command shape. `[y]` still approves the single call with no grant, `[n]`/`esc` deny. The grant is offered on the TUI `ApprovalModal` (keys routed in `app-key-bindings.ts`) and the CLI `run` stdin prompt; both surfaces have physical machine access, matching the level carve-out. Telegram/`ApprovalBridge` never grants: a remote channel approves per-request only, so a compromised bot token cannot raise session trust any more than it can raise the standing level.

Grants live in-memory on the `ApprovalGate`, keyed by the id of the session that made them (`grantsBySession: Map<string, {categories, shapes}>`); they never persist to `config.json` (session-scoped is a safer default than a durable global toggle, which is what the issue asks for). Because grants are keyed by session id and `autoApproval` matches on `request.sessionId`, a request from a *different* session — a background-task turn on the scheduler, a second live session on the same runtime — shares the gate but never rides another session's grant: "session-scoped" is a structural fact, not a promise every caller remembers to keep. `clearSessionGrants()` additionally fires on `newSession()` / `switchSession()` as a belt-and-braces reset of the leaving session. The standing level is untouched: a grant is a point exception layered over the posture, not a move of the posture. The gate checks grants in `request()` **after** the standing level and **before** emitting a prompt (`autoApproval`), returning a distinct reason (`session grant` / `session grant: <shape>`).

The shape is the guard's own normalised binary (basename, lowercased) that the shell tool passes as `ApprovalRequest.commandShape`, so `[a]` covers exactly the argv[0] that would run (`git`, not a path or a different case). A grant records the category/shape from the gate's **own** pending request, never from the caller's decision, so a host cannot widen a grant beyond what the prompt was about. The shell tool withholds `commandShape` for opaque interpreters (`bash`, `sh`, `zsh`, `dash`, `ksh` — the `dangerous.shell_dash_c` family) whose danger lives in their arguments, so `[a]` is never offered where the binary name hides what runs (`bash -c "<anything>"`); those prompts still offer `[s]` (the whole shell category) and `[y]`.

**Locked invariants** (pinned by [src/approval/approval-level.test.ts](src/approval/approval-level.test.ts), [src/approval/approval-gate.test.ts](src/approval/approval-gate.test.ts), [src/tools/os/fs-approval-scope.test.ts](src/tools/os/fs-approval-scope.test.ts), [src/runtime/bootstrap.test.ts](src/runtime/bootstrap.test.ts), [src/tui/privacy/privacy-orchestrator.test.ts](src/tui/privacy/privacy-orchestrator.test.ts), [src/tui/privacy/components/privacy-panel.test.tsx](src/tui/privacy/components/privacy-panel.test.tsx), [src/tui/privacy/privacy-key-bindings.test.ts](src/tui/privacy/privacy-key-bindings.test.ts), [src/http/route-capabilities.test.ts](src/http/route-capabilities.test.ts), [src/cli/serve-command.test.ts](src/cli/serve-command.test.ts), [src/config/config-schema.test.ts](src/config/config-schema.test.ts)):

1. **The `ApprovalGate` is the single live switch; tools always register `approvalRequired: true`.** Boot flags and the persisted `agent.approvalLevel` land in the gate's level, never in per-tool registration — a tool-level `false` would freeze the boot value forever and `runtime.setApprovalLevel` could not flip it back. `DangerousToolOptions.approvalRequired` is a test-only seam.
2. **Read the gate, not the config snapshot.** UI state (`PrivacyOrchestrator.refresh`), the diagnostics line (`approval L<n>`), and `GET /api/capabilities` (`agent.approvalLevel`) all report `runtime.getApprovalLevel()`, so `--no-approval` boots and live changes are shown honestly. `runtime.config` is a frozen bootstrap snapshot. The capabilities response also carries `agent.approvalRequired = level < 5`, **deprecated**: it is an approximate back-compat boolean for binary-era clients and is coarse at *every* mid-ladder level (2/3 silence file writes, 4 silences shell/script/kill), not just one — a boolean cannot say "on for some categories, off for others". `approvalLevel` is the source of truth; new clients ignore `approvalRequired`.
3. **Every interactive entry point honours the persisted level at boot.** `run`, `tui`, and `serve` call `resolveBootApprovalLevel(noApproval, config.agent.approvalLevel)`; `--no-approval` can only force level 5 for one process, never a stricter level. This is what makes the panel's "applies to future runs too" copy true.
4. **The ladder table above is the product decision and the category union is closed.** `approval-level.test.ts` pins the full category-by-level matrix; adding a category means extending the union (the compiler then walks every construction site). The user-facing coverage copy may not undersell the internal table — the panel test pins the cumulative list per level, and the "hardline guards still block" line is present at every level.
5. **Level 2 workspace containment is realpath-based, dangling symlinks included.** A path is "inside the workspace" only when the canonicalised target (deepest existing ancestor for not-yet-created files; the resolved link target for a dangling leaf symlink) stays under the canonicalised session cwd; symlinks that lead outside — live or broken — are classified by their target. Unresolvable paths fall to `other`. Pinned by `fs-approval-scope.test.ts` (including the dangling-out / dangling-in / chain cases) and the level-2 end-to-end test in `bootstrap.test.ts` (workspace write silent, home write prompts, `rm -rf /` hardline-blocked).
6. **A write to the agent's own trust config is never silent below level 5.** `config.json` and `.env` map to `trust_config` (pinned at level 5) by realpath match, so the model cannot raise its own `approvalLevel` or swap a token without a prompt. Pinned by `fs-approval-scope.test.ts` (symlink / `..` / fresh-install / batch cases) and the level-4 `bootstrap.test.ts` case (`os.fs.write` to `config.json` prompts with category `trust_config` even where `fs_write_home` is silent).
7. **Persist first, then hot-apply, and say when they diverge.** `PrivacyOrchestrator.setApprovalLevel` writes `config.json` before touching the gate; if the hot-apply throws after a successful persist, the sticky error names the already-rewritten `config.json` so the operator knows the next boot picks the new value up. Levels clamp to [1, 5] at every runtime surface; the config parser rejects non-integers outright.
8. **The prompt carries its category to every host UX.** `ApprovalRequest.category` is forwarded so a host shows *why* the prompt fired, not just the tool name: the TUI `ApprovalModal`, the CLI `run` stdin prompt, and the Telegram `ApprovalBridge` render a human label (`formatApprovalCategory`, e.g. `file write · home`); the sidecar protocol adds an **optional** `category` to `ApprovalRequestPayload` (back-compat: pre-ladder hosts ignore it) and the HTTP `/api/events` SSE already streams the full request. The Tauri host UI is a separate TS consumer of the protocol type — surfacing the new field there is its own follow-up, but nothing is silently dropped on the wire. Pinned by `approval-modal.test.tsx`, `approval-bridge.test.ts`, and the label matrix in `approval-level.test.ts`.
9. **Session grants never bypass hardline or `trust_config`, and never persist.** A grant is a session-scoped, in-memory point exception layered over the standing level; it silences its category/shape by returning early in `ApprovalGate.request` before a prompt is emitted. It cannot bypass the hardline shell guard: hardline returns `block` in `shell.ts` **before** `requireApproval` reaches the gate, so a catastrophic command is stopped whether or not `shell` (or the `rm` shape) is granted. It cannot silence `trust_config`: `isGrantableCategory` excludes it on both the record path (`resolve`) and the auto-approve path (`request`), so a config/`.env` write always prompts even after a broad grant. Honest boundary: the `trust_config` guard covers the fs tools (`categorizeFsMutation`), not the shell. A write to config via a shell redirect (`echo >> config.json`) stays under the `shell` category and is silenced by a shell grant, the same as at standing level 4 (operator). Grants do not widen this pre-existing class; closing it means intercepting shell redirects, a separate piece of work. Grants are TUI/CLI-local (never from Telegram) and keyed by session id, so a request from another session — a background-task turn, a second live session on the same runtime — never rides a grant it did not make; `clearSessionGrants()` also drops the leaving session's grants on every session change. Pinned by `approval-gate.test.ts` (grant category / grant shape / trust_config refused / per-session isolation for category and shape / targeted-and-full clear / union snapshot / no-shape shell / `canGrant*` offer logic), `shell.test.ts` (interpreter shape suppression), the Privacy panel + reducer + orchestrator tests (the read-only grants view), and the two `bootstrap.test.ts` end-to-end cases (a category grant silences later shell commands while `rm -rf /` stays hardline-blocked; a shape grant silences one binary while another still prompts).

## Durable tasks

A minimal durable queue of deferred `runTurn` submissions lives in [src/tasks/](src/tasks/). It is the **persistence layer** for any future scheduler / cron / agent-driven self-scheduling — but it ships **without** a background ticker on purpose: drains are always triggered explicitly (CLI `atomic-agent task run`, HTTP `POST /api/tasks/drain`) or implicitly right after `create()` when `tasks.runOnCreate=true` (the default).

A task is exactly one record:

```ts
TaskRecord = {
  id, sessionId, userMessage, maxSteps,
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled",
  origin: "cli" | "tui" | "http" | "sidecar" | "scheduler" | "agent",
  attempts, maxAttempts, lastError, lastErrorCategory,
  createdAt, updatedAt, startedAt, completedAt,
}
```

Stored in a separate SQLite file `<stateDir>/tasks.sqlite` (no cross-file FKs to `sessions.sqlite` — `sessionId` validity is checked at runtime by `TaskRunner` and a missing session marks the task `blocked` with `session_not_found`). Schema version `3`, idempotent migrations in [src/tasks/task-schema.ts](src/tasks/task-schema.ts) (v2 added the scheduling columns, v3 the `notify` opt-in — both documented in §"Background autonomy").

### Lifecycle

```
pending --(markRunning)--> running
running --(success)--> completed
running --(retryable, attempts < maxAttempts)--> pending   [retry loop]
running --(retryable, attempts == maxAttempts)--> failed
running --(grammar | tool failure)--> blocked              [permanent — same input, same wall]
running --(cancelled signal)--> cancelled
pending --(cancel())--> cancelled
```

Failure classification is delegated to `classifyFailure` from [src/llm/reliability/](src/llm/reliability/) (the LLM reliability policy below) so retry semantics never drift from the rest of the runtime.

### Drain semantics

`TaskRunner.drainPending(opts?)` is the one-shot drain primitive:

1. Pull every `pending` task (optionally `?session=`).
2. Group by `sessionId`.
3. For each group: drain sequentially. Each call into `runtime.runTurn(..., { origin: "scheduler" })` enters `TurnController` per-session FIFO and serialises against any user turn that lands mid-drain.
4. Across groups: `Promise.all` — different sessions drain in parallel, inheriting cross-session parallelism from the Concurrency contract above for free.

Inter-attempt sleep on retry uses `nextDelayMs(attempts, { initialMs, maxMs })` from [src/tasks/task-backoff.ts](src/tasks/task-backoff.ts) (`min(initialMs * 2^attempt, maxMs)`). Sleep happens **between attempts**, never blocking the per-session lock for longer than necessary.

### Locked invariants (pinned by tests)

1. **Tasks always run via `runtime.runTurn(..., { origin: "scheduler" })`.** Never via `executeTurn` (which bypasses the controller). Per-session FIFO + cross-session parallelism are inherited from §"Concurrency contract".
2. **Retries are turn-level only.** The same `userMessage` is replayed; partial-tool replay is out of scope. Step-level retries inside a single `runTurn` remain the LLM reliability layer's responsibility.
3. **`TaskRunner` never holds a `SessionState` reference between attempts.** It always re-reads via `sessionStore.load(sessionId)` inside the next attempt — same pattern as the sidecar `send_message` callback.
4. **`cancel(id)` is idempotent on terminal rows** — returns the existing record unchanged, so HTTP `DELETE` and CLI `cancel` are safe to retry.
5. **Stale recovery is one-shot.** `taskStore.recoverStale(staleAfterMs)` runs exactly once on bootstrap; there is **no background sweeper**. Process crash between `markRunning` and the terminal write leaves a `running` row that the next bootstrap flips back to `pending`.
6. **`tasks.enabled=false` ≠ `TaskStore` is absent.** The store is always constructed (it owns a SQLite handle that must be closed in `shutdown`), but `drainPending` is a no-op and HTTP routes return 404. Mirrors `memory.profile.enabled` from Memory fabric.

### Surfaces

| Surface | Path | Notes |
|---|---|---|
| HTTP | `POST/GET /api/tasks`, `GET/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run`, `POST /api/tasks/drain` | [src/http/route-tasks.ts](src/http/route-tasks.ts). Returns 404 for every route when `tasks.enabled=false`. |
| CLI | `atomic-agent task list \| show \| create \| cancel \| run` | [src/cli/task-command.ts](src/cli/task-command.ts). All subcommands except `run` open `TaskStore` directly and exit fast; `run` boots the full `createAgentRuntime` and tears it down on the way out. |
| Metrics | `agent.tasks.{created,started,completed,failed,blocked,cancelled,retried}` counters + `agent.tasks.{attempts,duration_ms}` histograms | Emitted from `TaskRunner` at status transitions. |

### Configuration

All under `tasks.*` in [src/config/config-schema.ts](src/config/config-schema.ts) — env-only (operational tuning, not user config file material):

- `tasks.enabled` (default `true`) — master switch.
- `tasks.maxAttempts` (default `3`) — retry budget per task.
- `tasks.backoffInitialMs` (default `1000`) / `tasks.backoffMaxMs` (default `60000`) — exponential capped backoff.
- `tasks.runOnCreate` (default `true`) — auto-drain immediately after `create()`. Detached, fire-and-forget.
- `tasks.staleAfterMs` (default `300000`) — `recoverStale` threshold.
- `paths.tasksDbFile` — resolved to `<stateDir>/tasks.sqlite`.

### Out of scope (deferred)

Task graphs / dependencies, workflow primitives (`kind != "runTurn"`), secret redaction in `userMessage` / `lastError`, per-origin priorities, distributed scheduler / leader election across multiple processes. Scheduling itself, webhook ingress, and agent-side `tasks.*` tools shipped in Option 4 — see next section.

## Background autonomy

Option 4 ships time-based scheduling, webhook ingress, and agent self-scheduling as a thin layer on top of §"Durable tasks". It **does not** change the `runTurn` contract or add any timers outside of `src/scheduler/`.

### Schedules on `TaskRecord`

`TaskRecord` carries an optional `schedule: TaskSchedule | null` where `TaskSchedule` is a discriminated union:

```ts
TaskSchedule =
  | { kind: "at"; at: number }                         // Unix ms
  | { kind: "cron"; expression: string; tz?: string }  // parsed via cron-parser
  | { kind: "interval"; everyMs: number }              // lower bound config.tasks.minIntervalMs
```

`resolveScheduledFor(schedule, fromMs)` in [src/tasks/task-schedule.ts](src/tasks/task-schedule.ts) is the **only** path that turns a schedule into an absolute `scheduledFor` (Unix ms). It is used both by `TaskRunner.create` on insert and by recurring requeue on completion. `cron-parser` is imported **only** from this file.

Schema bumped `TASK_SCHEMA_VERSION` 1 → 2, idempotent migration adding columns `schedule_kind`, `schedule_value` (JSON), `scheduled_for`, `recurring`, `last_scheduled_at`, `trigger_source` and a partial index `idx_tasks_due(status, scheduled_for) WHERE status='pending'` — the only path the scheduler uses to find work.

### Scheduler

[src/scheduler/scheduler.ts](src/scheduler/scheduler.ts) exposes one class with `start()`, `stop()`, `tickOnce()` (for tests). One `setInterval` per runtime, period = `config.tasks.schedulerTickMs` (default 5000), batch = `config.tasks.schedulerBatch` (default 10). On each tick:

1. Guard `running` flag (no reentry).
2. `await taskRunner.runDue(Date.now(), batch)`.
3. Errors are swallowed + logged + counted in `agent.scheduler.tick_errors`; interval keeps running.

Wired in [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) after `taskStore.recoverStale`. `shutdown()` awaits `scheduler?.stop()` **before** `taskStore.close()` to prevent a final tick from touching a closed handle.

### Session lifecycle for scheduled tasks

This is the most load-bearing rule in Option 4 — respect it when adding new code paths.

| Task shape | `sessionId` at `create()` | `sessionId` before `runTurn` |
|---|---|---|
| User-provided `sessionId` (CLI / HTTP / sidecar) | As provided | Unchanged. |
| One-shot, no `sessionId`, no `schedule` (or `schedule.kind="at"`) | `NULL` | `TaskRunner.runOne` lazily creates a fresh ephemeral session, **writes it back to the row**, then calls `runTurn`. Once written, stable for the row's lifetime. |
| Recurring (`cron` / `interval`), no `sessionId` | A fresh persistent session, created immediately by `sessionFactory` | Reused across every firing. If the session row is missing (user deleted it), `runOne` auto-recreates, logs a warning, emits `agent.tasks.session_recreated`, and continues. |

`requeueRecurring` atomically resets `attempts`, `last_error`, `started_at`, `completed_at` and rearms `scheduled_for` — **but never touches `session_id`**. This invariant is pinned by [src/tasks/task-store.test.ts](src/tasks/task-store.test.ts).

### Wake reason on session metadata

`TaskRunner.stampWakeReason` writes `session.metadata.wakeReason = { source, taskId, webhookName?, at }` before every `runTurn`, then persists the session. `source ∈ { "user", "scheduler", "webhook", "agent" }` mirrors `TaskRecord.triggerSource`. The reserved keys under `session.metadata` are documented in [src/session/session-state.ts](src/session/session-state.ts):

- `wakeReason` — set by `TaskRunner`, audit-only in this milestone (not rendered into the prompt).
- `recurringTask`, `scheduleKind` — set on persistent sessions owned by recurring tasks.
- `webhookName`, `webhookPersistent` — set on sessions created via `POST /api/webhooks/:name`.
- `ephemeralTask`, `scheduledBy` — set on lazy-created one-shot sessions.

None of these are currently rendered into the stable prefix; if you start rendering them, pin the stable-prefix hash test first.

### Webhook ingress

`POST /api/webhooks/:name` in [src/http/route-webhooks.ts](src/http/route-webhooks.ts) resolves `config.webhooks[name]` and returns 404 when missing or when `tasks.enabled=false`. On success:

1. Optional `x-webhook-secret` check against `config.webhooks[name].secret`.
2. `userMessage` = `evaluateWebhookTemplate(userMessageTemplate, body)` with `{{body.<json.path>}}` substitutions (see [src/http/webhook-template.ts](src/http/webhook-template.ts) — minimal substitution, no expression eval, length-capped).
3. `sessionId` resolved per `sessionMode`: `ephemeral` (leave null — `TaskRunner` creates fresh on `runOne`), `persistent` (read/create via [webhook-session-store.ts](src/http/webhook-session-store.ts), file-backed JSON in `<stateDir>/webhook-sessions.json`), `named` (require explicit `sessionId` in config).
4. `taskRunner.create({ origin: "http", triggerSource: "webhook", sessionId, userMessage, schedule })` — the route **never** calls `runTurn` directly.
5. HTTP 202 with `{ taskId }`.

Webhook config lives in the **user config file** (per-name declarative — ops shouldn't need a redeploy to add a new webhook). `USER_CONFIG_VERSION` bumped 2 → 3 with transparent `v2 → v3` migration (`webhooks: {}` default).

### Agent tools (`tasks.*`)

Five tools in [src/tools/tasks/](src/tools/tasks/), gated by `config.tasks.agentToolsEnabled`. Registered from [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) next to `registerMemoryTools`. The current session id is read via `AsyncLocalStorage` (`currentSessionId` from [src/runtime/session-context.ts](src/runtime/session-context.ts)).

| Tool | Writeable | Session resolution | Schedule |
|---|---|---|---|
| `tasks.schedule` | yes | **Inherits current session** by default; `newSession=true` opts into a fresh one | `at` (absolute) or `inSeconds` (relative) — validated via `parseOneShotSchedule` |
| `tasks.cron` | yes | **Always** a fresh persistent session (recurring ⇒ continuity, never mix with user thread) | `{ kind: "cron", expression, tz? }` |
| `tasks.list` | no | Defaults to current session; filters by `status` (CSV) and `limit` (capped at 200) | — |
| `tasks.cancel` | yes | — | — |
| `tasks.show` | no | — | — |

`TaskValidationError`s from `parseOneShotSchedule` / `task-schedule` are caught inside each tool's `run` method and surfaced as a structured `{ status: "error", details }` result — they never escape as thrown exceptions.

Descriptors in [src/prompt/tool-descriptors.ts](src/prompt/tool-descriptors.ts); the GBNF grammar [grammars/tool-call.gbnf](grammars/tool-call.gbnf) was extended with a `tasks-tool` branch covering all five names.

### Telegram reports for scheduled tasks (`notify`)

A task can opt into reporting its terminal outcome to the paired Telegram owner: `TaskRecord.notify ∈ TASK_NOTIFY_TARGETS` (single member `"telegram"` today) or `null` (default — silent, the pre-v3 behaviour). Schema `TASK_SCHEMA_VERSION` 2 → 3 (idempotent `ALTER TABLE tasks ADD COLUMN notify TEXT`). The opt-in is exposed on the `tasks.cron` / `tasks.schedule` agent tools (`notify?: "telegram"`), CLI `task create --notify telegram`, and `TaskCreateInput`; the TUI create form and `POST /api/tasks` do not surface it yet (deferred — the HTTP create surface cannot express schedules either), and the OpenClaw / Hermes cron importers never set it.

Flow: `TaskRunner.runOne` installs a turn event hook **only** for opted-in tasks (every other task passes no hook at all), captures the final result text — the `assistant_reply` for `reply` terminals, or the `finish` tool's summary (`tool_call_executed` with `result.tool === "finish"`, `details.summary` with the compressed `summary` as fallback; same payload the TUI renders as the final feed line) for `finish` terminals — and on a terminal transition hands a `TaskReport` to `TaskRunnerOptions.reportSink`. Bootstrap wires the sink to `TelegramChannel.sendTaskReport`, which renders via [src/channels/telegram/task-report-message.ts](src/channels/telegram/task-report-message.ts) and posts to the owner's DM (`chatId = ownerUserId` — a user-bot private chat is addressed by the user's own id, and the owner id is only ever captured from a private DM). Boot ordering: bootstrap starts the `Scheduler` only **after** the Telegram channel object is constructed, so a report can never observe a missing channel; a channel that is not `up` yet queues the report itself (below).

Locked invariants (pinned by [src/tasks/task-runner.test.ts](src/tasks/task-runner.test.ts), [src/tasks/task-store.test.ts](src/tasks/task-store.test.ts), [src/channels/telegram/task-report-message.test.ts](src/channels/telegram/task-report-message.test.ts), [src/channels/telegram/telegram-channel.test.ts](src/channels/telegram/telegram-channel.test.ts)):

1. **Terminal-only, final result only.** Reports fire on `completed | failed | blocked`. Never on within-attempt retries (`running -> pending`), never on `cancelled` (operator-initiated or shutdown-driven), never mid-run — there are no progress updates. Recurring tasks report each firing off the completed row **before** `requeueRecurring` flips it back to `pending`.
2. **Best-effort, never load-bearing, never silent.** Every outcome is a `TaskReportDelivery` value; skips that drop a report are warn-logged with the reason, the task's own status is untouched, and a throwing or rejecting sink is isolated the same way. A channel with a configured token that is not `up` yet does not drop: the report lands in a bounded FIFO queue (`TASK_REPORT_QUEUE_LIMIT` = 20, oldest evicted with a warning) and flushes on the transition to `up` — this covers the boot race and a channel enabled later; with no token configured the report is skipped as before. Partial chunk delivery counts as `delivery_failed` (warn carries delivered/total chunk counts), never as `sent` — and the report format is pinned to always fit one outbound chunk at the current caps. Losing a report without a log line is forbidden.
3. **Plain text, bounded size.** Task reports are channel infrastructure (invariant 8 of §"Telegram remote-control channel") — never `parse_mode: "HTML"`. The result excerpt caps at `TASK_REPORT_RESULT_MAX_CHARS` (3000) and errors at 500 chars, both with an explicit `… [truncated]` marker.
4. **`notify` is an allow-list at both ends.** `TaskStore.create` rejects unknown targets with `TaskValidationError("notify")`; unknown persisted values clamp to `null` on read, so the runner only ever sees list members.
5. **Egress is explicit and opt-in.** A report sends the task prompt preview plus the result / error excerpt to the Telegram Bot API — that content leaves the machine. Only tasks that explicitly set `notify` are affected.
6. **Approval behaviour is unchanged.** This feature adds no Telegram approval relay for unattended scheduled runs; approval-requiring steps behave exactly as before.

### Configuration (env-only under `tasks.*`)

Extending §"Durable tasks" config:

- `tasks.schedulerEnabled` (default `true`, env `ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED`).
- `tasks.schedulerTickMs` (default `5000`).
- `tasks.schedulerBatch` (default `10`).
- `tasks.agentToolsEnabled` (default `true`, env `ATOMIC_AGENT_TASKS_AGENT_TOOLS_ENABLED`).
- `tasks.minIntervalMs` (default `1000`) — lower bound for `{ kind: "interval" }`.

Webhook config lives under `webhooks.*` in the user config file, not env.

### Metrics (tasks)

Added to [src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- Counters: `agent.tasks.scheduled`, `agent.tasks.recurring_requeued`, `agent.tasks.session_recreated`, `agent.tasks.session_auto_created`, `agent.scheduler.ticks`, `agent.scheduler.tick_errors`, `agent.webhooks.received`.
- Histograms: `agent.scheduler.batch_size`, `agent.scheduler.tick_duration_ms`.
- Webhook tag: `webhook_name`.

### CLI

`atomic-agent task create` now accepts scheduling flags:

- `--at <unix-ms>` — one-shot at absolute time.
- `--cron "<expr>" [--tz <iana>]` — recurring cron (allocates a persistent session eagerly, so this path boots the full runtime).
- `--every <seconds>` — recurring interval.
- `--session <id>` is now optional; omit for one-shot ephemeral or let recurring allocate its own.

`atomic-agent task list` gained `schedule` and `next-run` columns.

`atomic-agent task tick` — one-shot `runDue(now, limit=Infinity)` for ops debugging (does not start the long-lived ticker).

### TUI surface (Tasks tab)

The `atomic-agent tui` debug pane exposes the task store as a first-class tab. State slice `state.tasksPanel` in [src/tui/tui-state.ts](src/tui/tui-state.ts) drives three view modes — `list`, `detail`, `create` — plus an optional `cancelConfirm` modal.

Module map:

- [src/tui/tasks/tasks-panel-state.ts](src/tui/tasks/tasks-panel-state.ts) — state types + `createInitialTasksPanelState`.
- [src/tui/tasks/tasks-actions.ts](src/tui/tasks/tasks-actions.ts) — `TasksAction` union (`tasks_*` prefix); folded into the root `TuiAction` via a mixin.
- [src/tui/tasks/tasks-reducer.ts](src/tui/tasks/tasks-reducer.ts) — slice reducer invoked first by the root reducer, returns `null` to fall through.
- [src/tui/tasks/tasks-filter.ts](src/tui/tasks/tasks-filter.ts) — pure filter+sort (status bucket, substring search).
- [src/tui/tasks/tasks-summary.ts](src/tui/tasks/tasks-summary.ts) — `TaskRecord → TaskSummaryRow` with time/interval formatters.
- [src/tui/tasks/cron-preview.ts](src/tui/tasks/cron-preview.ts) — thin wrapper over `peekNextFirings` (still keeps `cron-parser` behind `task-schedule.ts`).
- [src/tui/tasks/tasks-form-validator.ts](src/tui/tasks/tasks-form-validator.ts) — create-form parser; errors surfaced as `preview.error`, never thrown.
- [src/tui/tasks/tasks-orchestrator.ts](src/tui/tasks/tasks-orchestrator.ts) — the only module that calls `runtime.taskStore` / `runtime.taskRunner` from TUI code. Owns a 5s `setInterval` refresher (opt-in on first entry to the tab).
- [src/tui/tasks/tasks-key-bindings.ts](src/tui/tasks/tasks-key-bindings.ts) — dedicated hotkey layer; disables the editor when `activeTab === "tasks"` so single-char hotkeys (`j/k/n/c/R/r/a/f/o`) never conflict with typing.
- Components in [src/tui/components/tasks-*.tsx](src/tui/components/).

Keyboard contract:

- **List mode** — `j/k` (or arrows) move cursor, Enter opens detail, `n` opens create form, `c` cancels (y/n confirm for recurring), `R` runs now, `r` manual refresh, `a` toggles auto-refresh, `f` cycles status filter.
- **Detail mode** — `o` opens the task's session, `R` runs now, `c` cancels, Esc returns to list.
- **Create form** — Tab/Shift+Tab cycles focus (`kind → expression → tz? → message → submit`), Left/Right cycles kind when focused, Enter submits on the submit field or advances otherwise, Ctrl+Enter submits from any field, Esc closes.
- **Cancel confirm modal** — `y` confirms, `n`/Esc dismisses.

Slash commands:

- `/tasks` — jump to the Tasks tab.
- `/task new` — jump + open the create form.
- `/task cancel <id>` — enqueue a cancellation (skips the modal — intentional, the operator knows the id).
- `/task run <id>` — execute one attempt via `TaskRunner.runOne`.

Locked invariants (pinned by [src/tui/tasks/tasks-reducer.test.ts](src/tui/tasks/tasks-reducer.test.ts), [src/tui/tasks/tasks-filter.test.ts](src/tui/tasks/tasks-filter.test.ts), [src/tui/tasks/tasks-form-validator.test.ts](src/tui/tasks/tasks-form-validator.test.ts), [src/tui/tasks/cron-preview.test.ts](src/tui/tasks/cron-preview.test.ts), [src/tui/tasks/tasks-summary.test.ts](src/tui/tasks/tasks-summary.test.ts), [src/tui/commands/slash-command-handler.test.ts](src/tui/commands/slash-command-handler.test.ts)):

1. **`TasksOrchestrator` is the only TUI module that touches `runtime.taskStore` / `runtime.taskRunner`.** Components dispatch actions; actions reach the orchestrator via `TuiAppCallbacks`.
2. **`cron-parser` stays behind `task-schedule.ts`.** TUI only imports `peekNextFirings` via `cron-preview.ts`.
3. **The editor is disabled on the Tasks tab.** Single-char hotkeys are free to use letter keys; Tab re-enters the debug-tab cycler unless a create form or cancel modal is open.
4. **Form validation is pure.** Neither the reducer nor the keybinding layer throws; all errors surface as `preview.error` or `runtime_info` lines.
5. **Firings feed is best-effort.** The orchestrator diffs task snapshots between refresh ticks; it is never the source of truth for billing or auditing — that stays in metrics + traces.

### Locked invariants (pinned by tests)

Pinned by [src/scheduler/scheduler.test.ts](src/scheduler/scheduler.test.ts), [src/tasks/task-runner.test.ts](src/tasks/task-runner.test.ts), [src/tasks/task-store.test.ts](src/tasks/task-store.test.ts), [src/http/route-webhooks.test.ts](src/http/route-webhooks.test.ts), [src/runtime/bootstrap.test.ts](src/runtime/bootstrap.test.ts), and colocated tool tests:

1. **`Scheduler` is the only new periodic timer.** Never `setInterval` outside `src/scheduler/`.
2. **Webhooks never call `runTurn` directly.** Always `TaskRunner.create`.
3. **Recurring requeue preserves `session_id`.** Only auto-recreation on `session_not_found` may overwrite it.
4. **One-shot `session_id` is stable after the first attempt.** Lazy-created sessions must be written back to the row before `runTurn`.
5. **Partial-index `idx_tasks_due` is the only scheduler path.** No full scans.
6. **`tasks.enabled=false` disables everything.** Scheduler doesn't start, webhook routes 404, agent tools unregistered.
7. **`cron-parser` is isolated behind `task-schedule.ts`.** Future replacement touches one file.
8. **`session.metadata.wakeReason` is audit-only.** Survives restart, never rendered into the prompt.
9. **Agent tool validation errors are structured, not thrown.** Including nested errors from schedule parsing.

### TUI surface (Memory tab)

The `atomic-agent tui` Manage pane exposes read-only inspection of the memory fabric. State slice `state.memoryPanel` in [src/tui/tui-state.ts](src/tui/tui-state.ts) drives `list` / `detail` views across six channels: `profile`, `notes`, `lessons`, `procedures`, `links`, `votes`.

Module map:

- [src/tui/memory/memory-panel-state.ts](src/tui/memory/memory-panel-state.ts) — slice types + `MEMORY_CHANNEL_ORDER`.
- [src/tui/memory/memory-orchestrator.ts](src/tui/memory/memory-orchestrator.ts) — the **only** TUI module that reads `runtime.profileStore`, `notesStore`, `lessonStore`, `procedureStore`, `linkStore`, and `voteStore`.
- [src/tui/memory/memory-reducer.ts](src/tui/memory/memory-reducer.ts) — pure fold of `memory_*` actions.
- [src/tui/components/memory-panel.tsx](src/tui/components/memory-panel.tsx) — list/detail router.

`AgentRuntime` exposes `readonly linkStore: LinkStore` (always constructed; recall expansion and link-generator remain gated on `memory.links.enabled`). Operator inspection uses `LinkStore.listAll({ limit })` (default 500, hard cap 1000).

Slash commands: `/memory` opens the tab; `/memory dump` keeps the legacy profile dump into chat (`ChatOrchestrator.dumpProfile()`).

**Locked invariants** (pinned by [src/tui/memory/memory-reducer.test.ts](src/tui/memory/memory-reducer.test.ts), [src/tui/memory/memory-filter.test.ts](src/tui/memory/memory-filter.test.ts), [src/memory/links/link-store.test.ts](src/memory/links/link-store.test.ts), [src/tui/commands/slash-command-handler.test.ts](src/tui/commands/slash-command-handler.test.ts)):

1. **`MemoryOrchestrator` is the only TUI module that touches memory stores.** Components dispatch actions; refresh runs via `memory_refresh_requested` on the event bus.
2. **Read-only.** No delete / vote / write paths in the tab.
3. **The editor is disabled on the Memory tab.** Single-char hotkeys (`j`/`k`/`r`/`f`/`[`/`]`/`g`) do not collide with typing.
4. **Note detail exposes link neighbours when `memory.links.enabled`.** `g` runs `linkStore.expand`; Enter on a neighbour opens that note by id.
5. **Config gates surface hints, not crashes.** Disabled channels show an empty list + `channelHint` string.

## Vision (multimodal input)

Image recognition is an opt-in feature wired through the active **`LlmProvider`** ([src/llm/provider/llm-provider.ts](src/llm/provider/llm-provider.ts)) — `LlamaServerProvider` for local `/v1/chat/completions`, `OpenAiProvider` / `OpenRouterProvider` for cloud. The text agent loop is unchanged — vision lives outside the conversation transcript, exposed only via the `vision.describe` tool.

### Surfaces

| Layer | Module | Responsibility |
|---|---|---|
| Detection | [src/llm/model-profile.ts](src/llm/model-profile.ts) `detectVisionSupport` | Inspects `/props` and stamps `ModelProfile.vision = { supported, source }`. Source priority: `modalities.vision` (current llama.cpp surface) → `has_multimodal` → `multimodal` → `mmproj` (legacy fallbacks). The first source that reports support wins; the resolved tag is surfaced through `ProviderCapabilities.visionSource` for diagnostics. |
| Provider | [src/llm/provider/llm-provider.ts](src/llm/provider/llm-provider.ts) | `LlmProvider` interface — `name`, `capabilities`, `describeImage(request)`. Future non-llamacpp adapters implement this surface. |
| Adapter | [src/llm/provider/llama-server/llama-server-provider.ts](src/llm/provider/llama-server/llama-server-provider.ts) | Speaks the OpenAI-compatible `/v1/chat/completions` endpoint with `messages: [{role:"user", content:[{type:"image_url", image_url:{url:"data:<mime>;base64,…"}}, {type:"text", text:prompt}]}]`. Sends `chat_template_kwargs: {enable_thinking: false}` + `reasoning_format: "none"` so Gemma-4 / other thinking-capable models do not park the answer in a separate `thinking` channel. Sniffs JPEG/PNG/WebP/GIF magic bytes for the `data:` MIME. **Does not pass `slot_id`** — chat-completions manages its own slots; the main agent slot and the reflection slot are not touched. `capabilities` is a getter (not a frozen field) that reads the live profile through `getProfile()`, so vision turns on the moment `ModelProfileManager` swaps to a multimodal profile (load-bearing for the TUI's `deferLlamaHealthCheck=true` cold start). |
| Tool | [src/tools/vision/describe.ts](src/tools/vision/describe.ts) + [load-image.ts](src/tools/vision/load-image.ts) | `vision.describe { prompt, path? \| paths? }`. Loads images from disk (`png`/`jpg`/`jpeg`/`webp`/`gif`), enforces per-call and per-image caps, calls the provider, returns a `CompressedToolResult` like any other tool. |
| Wiring | [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) | Constructs the `LlamaServerProvider` only when `config.vision.enabled === true`, threading a `getProfile` closure that resolves through `ModelProfileManager` (with the cold-start `profile` as fallback). When the provider is present, `vision.describe` stays in `effectiveToolDescriptors` for the entire session — capability is checked dynamically at call time, not at bootstrap. The descriptor is filtered out only when `config.vision.enabled === false`, so the prompt never advertises a tool the runtime cannot actually invoke. |
| Catalog | [src/local-llm/models-catalog.ts](src/local-llm/models-catalog.ts) | `LocalModelDef.supportsVision` + `mmprojUrl` / `mmprojFilename` / `mmprojFileSizeGb` for downloads. |
| Installer | [src/local-llm/model-installer.ts](src/local-llm/model-installer.ts) | `downloadMmproj` / `isMmprojDownloaded` for projector files alongside GGUF weights. |
| Daemon launch | [src/local-llm/daemon-lifecycle.ts](src/local-llm/daemon-lifecycle.ts) `buildLlamaServerArgs` | Pure builder for the `llama-server` argv. When `mmprojFile` is set, the builder emits `--mmproj <path>` **and** a fixed image-token / batch budget: `--image-min-tokens 560 --image-max-tokens 560 --ubatch-size 1024 --batch-size 2048`. The 560-token budget is the lowest tier in Unsloth's published Gemma-4 grid (70 / 140 / 280 / 560 / 1120) that produces stable general-purpose multimodal chat — at the default ~70 image tokens the clip embedding is too noisy and the model hallucinates instead of describing. The ubatch/batch bumps cover Gemma-4's non-causal vision attention which assumes the entire image-token batch fits in a single ubatch. Both managed-mode start paths (CLI `atomic-agent models start` and TUI `LocalModelsOrchestrator.startDaemon`) auto-resolve the projector via `isMmprojDownloaded` + `resolveMmprojFilePath` when `config.vision.enabled && model.supportsVision`. When the projector is missing or vision is disabled the server boots text-only and the vision flags are not emitted. |
| TUI | [src/tui/local-models/](src/tui/local-models/) | Pull modes `with-mmproj` (default), `gguf-only` (`g` hotkey), `mmproj-only` (Enter on a model whose GGUF is already present but mmproj is missing). |

### Locked invariants

1. **Vision calls never touch the main agent or reflection slots.** `LlamaServerProvider.describeImage` posts to `/v1/chat/completions` without a `slot_id` — chat-completions manages its own slots and never reuses the main agent slot or the reflection slot. The legacy `/completion` + `image_data` + `[img-N]` placeholder path is gone; sending a plain prompt without a chat template was load-bearing for the previous Gemma-4 hallucination bug. Pinned by [src/llm/provider/llama-server/llama-server-provider.test.ts](src/llm/provider/llama-server/llama-server-provider.test.ts) (asserts URL ends in `/v1/chat/completions`, body uses `image_url` content blocks, `chat_template_kwargs.enable_thinking === false`).
2. **Vision lives outside the conversation transcript.** `vision.describe` returns a `CompressedToolResult`; no changes to `ConversationTurn` or the variable tail. The model receives the description as a normal `### latest-result` block.
3. **Text completion bypasses the provider.** Only the vision verb goes through `LlmProvider`. The agent loop continues to call `LlamaServerClient.complete` / `completeStream` directly so llama.cpp-specific knobs (`slot_id`, `cache_prompt`, GBNF) stay first-class.
4. **Vision tool registration is config-only; capability is dynamic.** `registerVisionTools` short-circuits on `config.vision.enabled === false` or on a missing provider, but **does not** check `capabilities.vision` at registration time — that check would freeze the wrong answer when the runtime starts before the first `/props` probe lands (the TUI's `deferLlamaHealthCheck=true` cold start). `LlamaServerProvider.describeImage` re-checks `this.capabilities.vision` on every call against the live profile and throws `VisionUnsupportedError` when the active model is text-only. The bootstrap filters the descriptor out of `DEFAULT_TOOL_DESCRIPTORS` only when no provider was constructed — so disabling vision via config still produces a clean prompt.
5. **Grammar always allows `vision.describe`.** [grammars/tool-call.gbnf](grammars/tool-call.gbnf) keeps `vision-tool` as a sibling alternative regardless of registration. When the descriptor is absent the model never selects this branch in practice; if it ever did, the registry would reject the call cleanly.
6. **Vision daemon flags are tied to `--mmproj`.** `buildLlamaServerArgs` emits `--image-min-tokens 560 --image-max-tokens 560 --ubatch-size 1024 --batch-size 2048` together with `--mmproj <path>` — never independently. Removing the bundle will silently regress to the ~70-image-token default that the Gemma-4 / Qwen-VL families confabulate on. Pinned by [src/local-llm/daemon-lifecycle.test.ts](src/local-llm/daemon-lifecycle.test.ts).
7. **`vision.describe` is `tier: "frequent"` in the descriptor catalog.** The full `argsSchema` and `examples` are always rendered into the stable prefix, not the variable `### loaded-tools` tail. Demoting the tier would cause the agent to emit malformed first-shot calls (e.g. missing `prompt`) until the rare-tool auto-expansion kicks in on error. Pinned by [src/prompt/default-tool-descriptors-b.ts](src/prompt/default-tool-descriptors-b.ts).

### Configuration (`vision.*`)

User-config block (`config.json` v6; `ensureUserConfigFileSync` actively migrates older files on bootstrap — when the on-disk `version` is below `USER_CONFIG_VERSION`, the parsed contents are atomically rewritten with the bumped version and any newly-added blocks filled from `USER_CONFIG_DEFAULTS`. Existing user values are preserved verbatim and a single `migrated config vN → vM` line is emitted to stderr for audit. Read-only call sites (`readUserConfigFileSync`) stay non-mutating):

- `vision.enabled` (default `true`) — master switch. Set to `false` to skip provider construction and tool registration entirely.
- `vision.autoDetect` (default `true`) — when `true`, the provider's capabilities follow `ModelProfile.vision.supported`. When `false`, the provider trusts the operator and reports `vision: true` regardless of `/props`; useful when running a custom backend that does not expose multimodal flags.
- `vision.maxImagesPerCall` (default `4`) — per-call ceiling enforced both in the tool and in the provider (`describeImage` throws if exceeded).
- `vision.maxImageBytes` (default `10485760`) — per-image byte cap enforced after `loadImageFile` reads from disk.

### Out of scope (deferred)

Image inputs as first-class `ConversationTurn` payloads (the user pasting an image directly into the chat instead of going through the `vision.describe` tool), paste-from-clipboard / drag-and-drop ingestion in TUI, mmproj checksum verification, per-projector tuning of the image-token budget (today the 560-token tier is uniform across vision models), and an OpenAI-API provider adapter are all out of scope for this milestone. The provider abstraction is intentionally narrow — only `describeImage` — and will grow when a second adapter actually lands.

## Telegram remote-control channel

`atomic-agent` ships an opt-in Telegram bot that acts as a **remote control for the same single-user agent runtime** — not a separate process, not a multi-user service. When the user starts the TUI / `atomic-agent run` / `atomic-agent serve`, an enabled Telegram channel boots automatically and shares the runtime's `TurnController`, `ApprovalGate`, `SessionStore`, `MemoryStore`, and `ProfileStore`. Code lives in [src/channels/telegram/](src/channels/telegram/) (runtime side) and [src/tui/telegram/](src/tui/telegram/) (TUI panel).

### Lifecycle

The channel is **always constructed** at bootstrap when the `telegram` config block exists; only `start()` is gated on `config.telegram.enabled`. This is load-bearing for live-control: the TUI / slash commands can flip `enabled` on at runtime without restarting the host. When `enabled=true` but `TELEGRAM_BOT_TOKEN` is missing, the channel transitions to `down` with `lastError: "missing TELEGRAM_BOT_TOKEN"` instead of crashing the runtime. Errors are reported through `runtime.onChannelStatus` (a `ChannelStatus` sink in [src/runtime/channel-status.ts](src/runtime/channel-status.ts)) so CLI / TUI / sidecar can surface them without parsing logs.

Single-instance enforcement is a `<stateDir>/telegram.lock` file ([telegram-lockfile.ts](src/channels/telegram/telegram-lockfile.ts)); the second runtime to boot fails fast at `start()` with a `lock_held` reason. `stop()` releases the lock; bootstrap shutdown awaits `telegramChannel.stop()` before closing SQLite handles.

### Polling — explicit AGENTS.md carve-out

The Telegram client uses **long-polling** (`grammy.Bot.start()` under the hood). Long-polling is normally forbidden by §"Background autonomy" — `Scheduler` is the only periodic timer in the runtime, and §"Concurrency contract" disallows additional internal queues. Telegram is the **single bounded exception**:

- The polling loop is owned exclusively by the grammy adapter inside [telegram-bot-factory.ts](src/channels/telegram/telegram-bot-factory.ts); no other code in `src/channels/telegram/` calls `setInterval` / `setTimeout` for periodic work.
- Every Telegram update is processed in a **fire-and-forget** wrapper (`bot.on("message:text", …) → void handler(update).catch(…)`); the polling loop never blocks on `runTurn`. This is what makes `/cancel` work mid-turn.
- Updates always materialise into a normal `runtime.runTurn(..., { origin: "telegram" })` call. Telegram never writes to `SessionStore`, `ApprovalGate`, or `TurnController` directly. Per-session FIFO + cross-session parallelism are inherited from §"Concurrency contract" for free.
- The carve-out is bounded to grammy. New channels (Slack, WhatsApp, …) will need a similar one-time review before adopting long-polling, and **must not** route through this code path; the `src/channels/<name>/` folder is the seam.

### Sessions

Telegram has its own dedicated session, persisted as a pointer in `<stateDir>/telegram-session.json` ([telegram-session-pointer.ts](src/channels/telegram/telegram-session-pointer.ts)). The TUI session and the Telegram session never collide. `/new` from Telegram rotates the pointer; the TUI's `/new` does not. The pointer file is the only Telegram-specific session metadata; everything else lives in the shared `sessions.sqlite`.

### Approvals

When a `runtime.runTurn` call originated on Telegram (`{ origin: "telegram" }`), `ApprovalRouter` ([src/approval/approval-router.ts](src/approval/approval-router.ts)) routes the `ApprovalRequest` to `ApprovalBridge` ([approval-bridge.ts](src/channels/telegram/approval-bridge.ts)) instead of falling through to the host UI. The bridge:

- Sends a 2-button inline keyboard (`✅ Approve` / `❌ Deny`) to the owner's DM as plain text (no MarkdownV2 — escaping rules are easy to get wrong with tool names containing backticks / underscores).
- Validates the callback `userId` against the live `ownerUserId` mirror — a stale callback from a previous owner is rejected.
- Auto-denies after 8 minutes (`config.telegram.approvalTimeoutMs`) and edits the original message to `⏱ timed out — auto-denied` with the buttons removed.
- Folds button-click / timeout / external-cancel into a single `approvals.resolve()` call; double-resolution is prevented by a `pending` map check.

Known UX gap (deferred): `/cancel` aborts the turn but the inline-keyboard message lingers because the bridge does not know it was cancelled externally. Documented inline in `approval-bridge.ts`.

### Task reports

`TelegramChannel.sendTaskReport(report)` posts a scheduled task's terminal outcome to the paired owner's DM — the delivery half of §"Background autonomy" → "Telegram reports for scheduled tasks (`notify`)". Rendered by [task-report-message.ts](src/channels/telegram/task-report-message.ts) (truncation is surrogate-safe: excerpts are cut on code-point boundaries, same walk as `chunkUtf16`; the maximal report is pinned to fit one outbound chunk), sent through the same `sendOutbound` chunking / 429-retry path as replies, **always plain text** (a report is channel infrastructure and its error excerpts may carry `<` / `&`). Never throws: every outcome is a `TaskReportDelivery` value (`sent | queued | channel_not_up | not_paired | delivery_failed`). Not-`up` with a token configured queues into a bounded FIFO (`TASK_REPORT_QUEUE_LIMIT` = 20, oldest evicted with a warning) that `transition("up")` flushes fire-and-forget; the queue survives `stop()` so a later restart still delivers, and is deliberately not persisted (a report is a courtesy notification — the task row keeps the authoritative outcome). Any dropped chunk resolves `delivery_failed` with delivered/total counts in the warn, never a silent partial `sent`. The static `TelegramChannel.buildTaskReportSink({ resolveChannel, logger })` is the `TaskRunner.reportSink` wired in bootstrap; it warn-logs every dropping outcome and stays silent on `sent` / `queued` — pinned by `telegram-channel.test.ts`. Each fully delivered report counts one `messages_sent`.

### Live control

`TelegramChannel` exposes a small live-control API used by the TUI panel and `/telegram` slash commands:

- `setEnabled(enabled)` — flips `config.telegram.enabled` in `config.json` and starts/stops the channel.
- `setOwnerUserId(id | null)` — updates the live mirror + `config.json`; restarts when the channel is `up` so inbound-handler / approval-bridge re-capture the new value.
- `setToken(token | null)` — writes `TELEGRAM_BOT_TOKEN` into `<stateDir>/.env` via [dotenv-writer.ts](src/config/dotenv-writer.ts) (atomic, mode `0600`, never logged), mirrors into `process.env`, and restarts when `up`.
- `restart()` — clean stop + start; useful to reload a token without flipping `enabled`.
- `startPairing(timeoutMs?)` / `cancelPairing()` — opens a 60s window where the first eligible private DM claims ownership ([pairing-mode.ts](src/channels/telegram/pairing-mode.ts)). Only allowed when the channel is `up`. Inbound handler calls `tryClaimForPairing` **before** the owner check so an unowned bot can be paired.

Persistence is split: `enabled` and `ownerUserId` live in `<stateDir>/config.json`; the token lives only in `<stateDir>/.env`. The token is never copied into config, never echoed in TUI, and never logged on error paths (errors are scrubbed via `scrubErrorMessage` in [telegram-channel-types.ts](src/channels/telegram/telegram-channel-types.ts)).

### TUI panel

The "Telegram" tab in `atomic-agent tui` mirrors the channel state and exposes the live-control API. Architecture matches the existing Tasks / Skills tab pattern (see §"TUI surface (Tasks tab)"):

- [tui-telegram-orchestrator.ts](src/tui/telegram/tui-telegram-orchestrator.ts) is the **only** TUI module that imports `TelegramChannel` or reads `process.env.TELEGRAM_BOT_TOKEN`. The token never leaves this file: `setToken` calls into the channel by value; the UI mirrors its presence as a `hasToken: boolean`.
- The reducer ([telegram-panel-reducer.ts](src/tui/telegram/telegram-panel-reducer.ts)) is pure; every side effect (channel calls, persistence, timers) lives in the orchestrator.
- The pairing countdown ticker is owned by the orchestrator and is cleared on shutdown / resolution / dismissal. Pinned by [tui-telegram-orchestrator.test.ts](src/tui/telegram/tui-telegram-orchestrator.test.ts).

Slash commands: `/telegram enable|disable`, `/telegram start|stop` (alias for the same), `/telegram restart`, `/telegram pair`, `/telegram token` (opens the masked modal), `/telegram clear-token`, `/telegram clear-owner`. The `e` / `t` / `o` hotkeys mirror enable-toggle / token-prompt / pairing.

### Configuration

`config.telegram` (user config, v10) — see [src/config/config-schema.ts](src/config/config-schema.ts):

- `telegram.enabled` (default `false`) — master switch for `start()`.
- `telegram.ownerUserId` (default `null`) — numeric Telegram user id authorised to send DMs to the bot. When `null`, the bot ignores all messages and approvals are dropped.
- `telegram.parseMode` (default `"html"`) — agent-reply rendering mode. `"html"` converts the agent's markdown to Telegram's HTML subset via `convertMarkdownToTelegramHtml` and sends with `parse_mode: "HTML"` + `disable_web_page_preview: true`; on HTTP 400 ("can't parse entities") the same chunk is retried once as plain text so a formatter regression never silently swallows a reply. `"plain"` disables formatting entirely (legacy behaviour). Slash-command acks, infra messages (`Turn cancelled.`, `(no reply)`), and failure envelopes (`Turn failed [...]: ...`) **always** send as plain text regardless — only "agent content" is formatted, "channel infrastructure" stays unformatted so a stray `<` in an error message can never collide with the HTML grammar. MarkdownV2 is intentionally unsupported (escape surface too wide for typical LLM output). Added in config v10; older files transparently get `"html"`.
- `telegram.approvalTimeoutMs` (default `480000` = 8 min) — `ApprovalBridge` auto-deny window.

`TELEGRAM_BOT_TOKEN` (env / `<stateDir>/.env`) — bot token. Stored only in `.env` with mode `0600`; never copied into `config.json` or logged.

### Metrics

[src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- Counters: `agent.telegram.up`, `agent.telegram.down` (tagged by `outcome` + short `reason`), `agent.telegram.messages_received`, `agent.telegram.messages_sent`, `agent.telegram.approvals_resolved` (tagged by `resolver` + `approved`).
- The `messages_*` counters track agent-visible inbound (post owner-check, post slash-command-shortcut) and one-per-logical-outbound-message (agent replies and task reports), **not** raw Telegram updates / `sendMessage` chunks.

### Outbound formatting (HTML mode)

Agent replies are rendered as Telegram HTML by default ([config v10](src/config/config-schema.ts), `telegram.parseMode = "html"`). The path is:

- [markdown-to-html.ts](src/channels/telegram/markdown-to-html.ts) is a pure converter that maps a deliberately narrow LLM-friendly markdown subset (headings → `<b>`, bold/italic/strikethrough, inline + fenced code, links, lists, blockquotes) into Telegram's HTML subset (`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`). All non-tag text is HTML-escaped (`<`, `>`, `&`); link `href`s are validated against an `(https?|tg|mailto):` allowlist so unsafe schemes degrade to escaped plain text instead of becoming `<a>` tags.
- [outbound-sender.ts](src/channels/telegram/outbound-sender.ts) `sendOutbound` accepts `parseMode: "plain" | "html"`. The chunker always operates on raw input text (line-break aware, identical to plain mode); the conversion runs **per chunk** so an unbalanced markdown delimiter that straddles a chunk boundary degrades to literal text rather than producing a corrupt HTML tag. HTML chunks are sent with `parse_mode: "HTML"` and `disable_web_page_preview: true` (so a stray bare URL in the agent's reply does not unfurl an unwanted preview card).
- On HTTP 400 with a "can't parse entities" / "unsupported start tag" / "can't find end of" description, the same chunk is retried **once** as plain text and the `parseFallbacks` counter on `OutboundSendResult` increments. Other 400s drop the chunk like any non-429 error. This is the load-bearing safety net: a formatter regression never silently swallows a reply.

### Locked invariants

Pinned by [src/runtime/bootstrap.test.ts](src/runtime/bootstrap.test.ts), [src/channels/telegram/telegram-channel.test.ts](src/channels/telegram/telegram-channel.test.ts), [src/channels/telegram/inbound-handler.test.ts](src/channels/telegram/inbound-handler.test.ts), [src/channels/telegram/approval-bridge.test.ts](src/channels/telegram/approval-bridge.test.ts), [src/channels/telegram/pairing-mode.test.ts](src/channels/telegram/pairing-mode.test.ts), [src/channels/telegram/markdown-to-html.test.ts](src/channels/telegram/markdown-to-html.test.ts), [src/channels/telegram/outbound-sender.test.ts](src/channels/telegram/outbound-sender.test.ts), [src/config/dotenv-writer.test.ts](src/config/dotenv-writer.test.ts), [src/tui/telegram/telegram-panel-reducer.test.ts](src/tui/telegram/telegram-panel-reducer.test.ts), [src/tui/telegram/tui-telegram-orchestrator.test.ts](src/tui/telegram/tui-telegram-orchestrator.test.ts):

1. **Polling carve-out is scoped to grammy.** `setInterval` / long-polling outside `telegram-bot-factory.ts` is forbidden in `src/channels/telegram/`. Other channels must repeat the carve-out review.
2. **Telegram updates always go through `runtime.runTurn`.** Never directly into `SessionStore`, `ApprovalGate`, or `TurnController`.
3. **The token never leaves `src/channels/telegram/` or [tui-telegram-orchestrator.ts](src/tui/telegram/tui-telegram-orchestrator.ts).** UI state mirrors only the boolean `hasToken`; reducer actions never carry the value. Errors are scrubbed.
4. **`TelegramChannel` is always constructed when the `telegram` config block exists.** Bootstrap sets `runtime.telegramChannel` regardless of `enabled`; the live-control API stays callable from the TUI without a host restart.
5. **Pairing bypasses the owner check.** Inbound handler calls `tryClaimForPairing` **before** filtering by `ownerUserId` — the only path where a non-owner DM is allowed to claim ownership.
6. **Approval routing is per-session.** `ApprovalRouter.setForSession(sessionId, handler)` binds the Telegram session id to `ApprovalBridge`; everyone else falls through to the host UI handler. A fallback collision between two channels on the same session is intentionally not supported.
7. **`grammy` is imported from one file only.** [telegram-bot-factory.ts](src/channels/telegram/telegram-bot-factory.ts). Future replacement of the Telegram client touches one file.
8. **Only agent replies are formatted.** Slash-command acks (`/help`, `/status`, `/new`, `/cancel`), infra messages (`Turn cancelled.`, `(no reply)`), failure envelopes (`Turn failed [<category>]: ...`), pairing welcomes, task reports (`sendTaskReport`), and approval-keyboard text always send as plain text regardless of `telegram.parseMode`. The carve-out keeps a stray `<` in an error message from colliding with the HTML grammar and keeps the operator's mental model clean: formatted text == agent content, plain text == channel infrastructure.
9. **HTML conversion is tag-allowlisted.** `convertMarkdownToTelegramHtml` only emits tags from `{b, i, u, s, code, pre, a, blockquote}` and only `(https?|tg|mailto):` schemes for `<a href>`. New tag emission requires extending both the converter and the allowlist in [markdown-to-html.ts](src/channels/telegram/markdown-to-html.ts).
10. **Plain-text fallback on HTTP 400 'can't parse entities'.** When `parseMode === "html"`, a parse-rejected chunk is retried once with `parse_mode` stripped and the original raw markdown body — not the formatted HTML — so the operator sees the LLM's intent instead of the broken tags. `parseFallbacks` is surfaced separately from `dropped` for metrics + regression detection.

### Out of scope (deferred)

Multi-user pairing flows, per-chat session isolation, MarkdownV2 rendering (the escape surface is too wide for typical LLM output and `parse_mode: "MarkdownV2"` rejects the whole message on a single stray reserved char — see §"Outbound formatting"), structured menu / command surfaces beyond plain text, message editing for streaming output, file uploads (image / document ingestion through Telegram), webhook ingress as a Telegram-specific endpoint (the generic `/api/webhooks/:name` path is the existing surface), mid-run progress updates and an approval relay for unattended scheduled runs (task reports are terminal-only — see §"Background autonomy"), and a generic `Channel` abstraction (Slack / WhatsApp adapters) are all deferred. The seam is `src/channels/<name>/`; only extract shared interfaces when a second concrete channel actually lands.

## MCP client

`atomic-agent` is an **MCP (Model Context Protocol) client** that connects to external MCP servers and surfaces their tools / resources / prompts to the agent through the existing `ToolRegistry`. The runtime never exposes an MCP server interface itself — atomic-agent is a consumer, not a producer. Code lives in [src/mcp/](src/mcp/); the cold-path wiring is in [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) right after vision + before the descriptor filter / grammar build.

### Why MCP

Every MCP server adds a bounded, declarative surface of capabilities (tools / resources / prompts) without forcing the runtime to grow another bespoke integration. The model picks them by **qualified name** (`mcp.<server>.<tool>`); per-server trust levels decide how the runtime batches and approves calls; tools are loaded into the prompt at tier `frequent` so the model sees their full `argsSchema` in the stable prefix and can call them on the first shot without an intervening `tool.view`. The historical `rare`-tier rendering surfaced only one-line stubs under `# extras`, which in practice meant smaller local models almost never invoked MCP tools at all — visible but practically unusable without a discovery hop the model rarely thought to take. The trade-off is paid as a one-time bump in stable-prefix tokens proportional to the connected MCP catalog; operators wiring up chatty / untrusted servers should weigh that explicitly.

### Lifecycle

`McpManager` is constructed unconditionally at bootstrap (mirrors the Telegram channel pattern) — even when `config.mcp.servers[]` is empty — so any future live-control surface stays uniform. An empty configuration produces a zero-cost no-op manager: `start()` returns immediately, no resolver is installed, no aggregate tools are registered.

When at least one server is configured, bootstrap:

1. Constructs the manager.
2. Awaits `mcpManager.start()` — each `McpClient` opens its transport with a hard 15s connect timeout (`DEFAULT_CONNECT_TIMEOUT_MS` in `mcp-client.ts`), runs the MCP `initialize` handshake, installs the optional sampling handler, and refreshes the catalog. Failures are isolated per-server; one bad config never blocks bootstrap.
3. Registers the aggregate `mcp.resource.{list,read}` and `mcp.prompt.{list,get}` tools — single per-runtime registration; the tools dispatch by the `server` arg rather than producing one tool per server (the prompt would explode).
4. Builds `McpToolDescriptor[]` from every connected catalog and merges them into `effectiveToolDescriptors` via `mergeMcpDescriptors` — MCP descriptors land at the end of the prompt's `### tools` block at tier `frequent` (full `argsSchema` in `# common (full)`).
5. Applies the dynamic `mcp-server-tool` GBNF rule via `applyMcpToolNameRule(grammar, buildMcpToolNameRule(metas))`. The static `grammars/tool-call.gbnf` file ships a permissive placeholder; the runtime replaces it with an alternation of the actual qualified names so the LLM can only emit tools that resolve to a registered `ToolDefinition`.

`shutdown()` closes every `McpClient` (best-effort, errors swallowed), tears down every registered tool, and clears the dynamic resource-class resolver. The MCP shutdown step runs between Telegram channel shutdown and browser/SQLite teardown so in-flight sampling calls have a chance to drain before the LLM client is torn down.

### Module map

| File | Responsibility |
|---|---|
| [mcp-types.ts](src/mcp/mcp-types.ts) | Neutral type shapes: `McpServerConfig`, `McpToolMeta`, `McpResourceMeta`, `McpPromptMeta`, `McpServerStatus`, `McpTrustLevel`. No SDK objects leak out of `mcp-client.ts`. |
| [mcp-errors.ts](src/mcp/mcp-errors.ts) | `McpError` / `McpConnectError` / `McpRequestError` hierarchy + `scrubErrorMessage`. Every user-facing surface (status badge, log, TUI label) goes through the scrubber. |
| [mcp-resource-class.ts](src/mcp/mcp-resource-class.ts) | `qualifyMcpToolName` / `splitMcpToolName` + `createMcpResourceClassResolver` (the per-server trust → `ResourceClass` mapper). |
| [mcp-client.ts](src/mcp/mcp-client.ts) | **The only file that imports `@modelcontextprotocol/sdk`.** Wraps `Client` + the three transports (stdio / streamable_http / sse). Owns connect / refresh / RPC / close. |
| [mcp-sampling-handler.ts](src/mcp/mcp-sampling-handler.ts) | Routes `sampling/createMessage` from MCP servers to `LlamaServerClient.complete` with `slotId: -1` + `cachePrompt: false`. Also imports the SDK for the `CreateMessageRequest` / `CreateMessageResult` shapes; no other module needs them. |
| [mcp-tool-adapter.ts](src/mcp/mcp-tool-adapter.ts) | `createMcpToolDefinition(meta, client)` — wraps an MCP tool as a `ToolDefinition` for the registry. Projects the heterogenous MCP response into a single `output` string + structured `details`; folds errors into `status: "error"` so siblings inside a batch keep running. |
| [mcp-manager.ts](src/mcp/mcp-manager.ts) | One `McpClient` per server, lifecycle, status sink, tool register/unregister, dynamic resolver install/clear. |
| [mcp-descriptor-builder.ts](src/mcp/mcp-descriptor-builder.ts) | `buildMcpToolDescriptor` + `buildMcpToolDescriptors` + `mergeMcpDescriptors`. Every MCP tool ships at tier `frequent` (full schema in the stable prefix — discoverability over prefix size). Server-then-tool alphabetical sort → deterministic stable-prefix bytes. |
| [mcp-grammar-builder.ts](src/mcp/mcp-grammar-builder.ts) | `buildMcpToolNameRule` + `applyMcpToolNameRule`. Pure functions; deterministic sort + dedup ensure byte-stable output. |
| [mcp-resource-tools.ts](src/mcp/mcp-resource-tools.ts) / [mcp-prompt-tools.ts](src/mcp/mcp-prompt-tools.ts) | Aggregate read-only tools (`mcp.resource.list`, `mcp.resource.read`, `mcp.prompt.list`, `mcp.prompt.get`). Dispatch by `server` arg. Resource class `pure_read`. |

### Resource classification

Every MCP-namespaced tool resolves to a `ResourceClass` through the dynamic resolver installed by `McpManager.ensureResolver()`. The resolver is the **only** non-static path through `resourceClassFor` (see `setDynamicResourceClassResolver` in [src/agent/tool-resource-class.ts](src/agent/tool-resource-class.ts)).

| Trust level on `McpServerConfig` | Resolved class | Behaviour |
|---|---|---|
| (default / omitted) | `approval_gated` | Every call routes through the approval gate; cannot appear in multi-call batches. Safe for arbitrary third-party servers. |
| `pure_read` | `pure_read` | Fans out in parallel inside batches alongside `os.fs.read` / `os.git.*`. **Opt-in only.** Use for servers you trust never to mutate any state. |

The aggregate native tools (`mcp.resource.*`, `mcp.prompt.*`) are classified as `pure_read` in the static `TOOL_RESOURCE_CLASS` table — they never mutate state regardless of which server they dispatch to.

### Sampling forwarding

MCP servers can request the **client's** LLM to generate text on their behalf via `sampling/createMessage`. atomic-agent forwards those requests to the same `LlamaServerClient` that drives the agent loop — but always on `slotId: -1`. This is the load-bearing safety invariant: the main agent slot and the reflection slot are never touched by MCP traffic. A misbehaving MCP server cannot evict the agent's KV cache mid-turn.

The handler is fire-safe — every error is folded into a thrown `Error` that the SDK converts into a JSON-RPC error sent back to the server. We never crash the client transport. No grammar is attached; MCP sampling is free-form text and the server owns any structure it expects.

### Configuration (`config.mcp.servers[]`)

User config v23. Older files transparently migrate by filling `mcp: { servers: [] }`. Per-server entries:

```ts
{
  name: "github",                     // kebab-case, max 32 chars, MCP_SERVER_NAME_RE
  description?: "GitHub API",         // free-form one-liner for TUI / logs
  enabled: true,                      // disabled servers are constructed but never connected
  transport: {                        // stdio / streamable_http / sse
    kind: "stdio",
    command: "npx",
    args: ["-y", "@github/mcp-server"],
    cwd?: "/optional"
  },
  trust?: "pure_read",                // default "approval_gated"
  env?: { GITHUB_TOKEN: "..." }       // overlays process.env for stdio transports only
}
```

Server name collisions are dropped at config parse time with a warning. Tool names from servers that fail `MCP_TOOL_NAME_RE` are silently dropped during catalog refresh — the agent never sees them.

### Locked invariants

Pinned by [mcp-client.test.ts](src/mcp/mcp-client.test.ts) (when added), [mcp-manager.test.ts](src/mcp/mcp-manager.test.ts), [mcp-resource-class.test.ts](src/mcp/mcp-resource-class.test.ts), [mcp-grammar-builder.test.ts](src/mcp/mcp-grammar-builder.test.ts), [mcp-descriptor-builder.test.ts](src/mcp/mcp-descriptor-builder.test.ts), [mcp-tool-adapter.test.ts](src/mcp/mcp-tool-adapter.test.ts), [mcp-sampling-handler.test.ts](src/mcp/mcp-sampling-handler.test.ts), [mcp-resource-tools.test.ts](src/mcp/mcp-resource-tools.test.ts), [mcp-prompt-tools.test.ts](src/mcp/mcp-prompt-tools.test.ts), and the bootstrap descriptor-filter test [filter-disabled-tools.test.ts](src/runtime/filter-disabled-tools.test.ts):

1. **`@modelcontextprotocol/sdk` is imported from exactly two files** — [mcp-client.ts](src/mcp/mcp-client.ts) and [mcp-sampling-handler.ts](src/mcp/mcp-sampling-handler.ts) (the latter only for `CreateMessageRequest` / `CreateMessageResult` type shapes). Everything else operates on the neutral types in `mcp-types.ts`. Future replacement of the SDK touches these two files only.
2. **Sampling always uses `slotId: -1`.** The main agent slot and the reflection slot are off-limits to MCP traffic. `cachePrompt: false` is set unconditionally. Pinned by `mcp-sampling-handler.test.ts > "INVARIANT 1 — always uses slotId: -1 and disables cache_prompt"`.
3. **Tool failure isolation.** A failed MCP call lands as `CompressedToolResult { status: "error" }`. Never throws out of `ToolDefinition.run`. Per-call failures inside a batch never abort siblings.
4. **Per-server failure isolation at connect.** One bad server config does not block bootstrap; its status flips to `down` and the rest keep running. Pinned by `mcp-manager.test.ts > "start() isolates per-server failures"`.
5. **MCP tools are always tier `frequent`.** The full `argsSchema` is rendered into `# common (full)` of the stable prefix so the model can invoke them on the first shot without a `tool.view` round-trip. This inverts the historical `rare` rendering — see the module-level comment in `mcp-descriptor-builder.ts` for the trade-off (one-time stable-prefix token bump in exchange for actual MCP usability on small local models). The summary stays `[mcp:<server>] <description>` regardless of tier. Pinned by `mcp-descriptor-builder.test.ts > "ships every MCP tool as tier 'frequent' so the full schema lands in the stable prefix"`.
6. **Deterministic descriptor and grammar ordering.** `buildMcpToolDescriptors` sorts by `(server, rawName)` and `buildMcpToolNameRule` sorts + dedups the qualified names. Same input → byte-identical output → KV-cache stability across runtime restarts with the same config.
7. **Resource-class default is `approval_gated`.** Unknown servers and missing trust entries both resolve to `approval_gated` so a stale model-emitted MCP name lands in the safe lane and is rejected by `registry.invoke` rather than escaping into a `pure_read` batch. Pinned by `mcp-resource-class.test.ts > "returns approval_gated for unknown servers (safe default — never null)"`.
8. **Dynamic resolver is installed by the manager and torn down on `shutdown()`.** Pinned by `mcp-manager.test.ts > "shutdown() closes all clients and clears the resolver"`.
9. **Aggregate native tools (`mcp.resource.*`, `mcp.prompt.*`) are `pure_read` and dispatch by `server` arg.** Single per-runtime registration; never one tool per server. Filter gate `mcp: { enabled }` in `filter-disabled-tools.ts` drops the descriptors from the prompt when no servers are configured. Pinned by `filter-disabled-tools.test.ts > "drops every mcp.* aggregate descriptor when mcp is disabled"`.
10. **GBNF placeholder fallback.** When `applyMcpToolNameRule` is called with a `null` rule (no MCP tools registered), the grammar is returned unchanged — the static permissive placeholder `mcp-server-tool ::= "\"mcp." [a-z0-9-]+ "." [a-zA-Z0-9._-]+ "\""` stays in place. The model will not generate such a name in practice (no descriptor advertises it), but the grammar fails open rather than fails closed.
11. **`McpManager` is always constructed.** Bootstrap creates it even when `config.mcp.servers[]` is empty so the live-control surface (TUI MCP panel) can mutate without restarting the host. Empty configuration is a zero-cost no-op.
12. **MCP `shutdown()` runs before browser / SQLite teardown.** Order: Telegram → MCP → browser → SQLite. In-flight sampling calls have a chance to drain before the LLM client is torn down.
13. **Variant γ — live add / remove without restart.** `McpManager.addServerLive(config)` connects a new client, registers its tools into `ToolRegistry`, and returns the freshly-discovered tool metas. `McpManager.removeServerLive(name)` disconnects, unregisters tools, and drops the entry. Both are idempotent on the server name (duplicate add or absent remove short-circuit without error). The TUI MCP orchestrator pairs these calls with `runtime.refreshMcp()` so the GBNF grammar and the prompt's `### tools` catalog are rebuilt from the live manager state, and the model sees the new / dropped qualified names on the next inference. **KV-cache invalidation on the stable prefix is intentional and one-shot** — semantically equivalent to a runtime restart, just without the process churn. The four MCP meta-tools (`mcp.resources.{list,read}` / `mcp.prompts.{list,get}`) are registered on demand the first time a server lands so a zero-server cold start does not pollute the descriptor catalog. Pinned by `mcp-manager.test.ts > "variant γ — live add / remove"` (6 cases: brand-new connect + tool registration, duplicate-name short-circuit, connect failure isolation, disconnect + tool unregister, absent-name short-circuit, round-trip idempotency).

### Out of scope (deferred)

`notifications/tools/list_changed` subscriptions (the SDK supports them; current phase ships catalog snapshots only — `refreshMcp()` is the manual / TUI-driven equivalent). Per-tool ACL (today trust is server-level; finer-grained allowlisting of specific tools within a server is deferred). MCP `roots` capability (the agent does not declare a workspace root to servers — every stdio server inherits the agent's CWD via `McpStdioTransport.cwd`). MCP elicitation (interactive multi-turn prompts from servers — out of scope for this milestone). Live mutation of `mcp.servers[i].enabled` from the TUI without an `addServerLive` / `removeServerLive` round trip (today `setServerEnabled` is reachable on the manager but the TUI does not surface it — only persist-driven add / remove is wired). Sampling-handler reattachment on the first live-added server (today sampling capability is decided at construction time; a server added live in a fresh-start-with-zero-servers process has no sampling handler — operators who need sampling should configure at least one server up front, or accept a restart). Server-side MCP exposure (atomic-agent is client-only and will stay that way — the runtime's tool surface is too coupled to local file system / browser / approval gating to safely advertise over MCP to external clients).

### TUI surface (Manage tab — Mcp panel)

Lives under [src/tui/mcp/](src/tui/mcp/) and [src/tui/components/mcp-*.tsx](src/tui/components/). Architecture mirrors the existing `LocalModels` / `Tasks` / `Memory` / `Skills` panel pattern — pure state slice + reducer, an orchestrator that is the **only** TUI module that touches `runtime.mcpManager` / `runtime.refreshMcp` / `persistMcpServer` / `removeMcpServer`, dedicated key bindings.

Hotkeys (list mode): `j`/`k` move cursor · Enter open detail · `n` add (JSON paste modal) · `d` remove (confirm modal) · `r` refresh · `a` toggle auto-refresh. Detail mode adds `1`/`2`/`3` tab switch, `[`/`]` cycle, `d` remove the open server. The add-server modal accepts both the bare `{name, transport: {...}}` shape and shortcut envelopes used by Claude Desktop / Cursor / Smithery / DeepWiki (`{mcpServers: {<name>: {command, args}}}` for stdio, `{url}` / `{serverUrl}` for HTTP, `{type: "sse"}` for SSE). Multi-line paste is auto-flattened by the reducer (`\n` / `\r` / `\t` → spaces) so the editor does not grow vertically. The remove-confirm modal claims `y`/Enter and `n`/Esc; the `submitting` flag guards against double-fire. Slash-command surface: `/mcp` opens the tab, `/mcp add` opens the add modal, `/mcp remove <name>` opens the remove confirm directly.

Locked invariants (pinned by [src/tui/mcp/mcp-reducer.test.ts](src/tui/mcp/mcp-reducer.test.ts), [src/tui/persist-mcp-server.test.ts](src/tui/persist-mcp-server.test.ts)):

1. **`McpOrchestrator` is the only TUI module that touches `runtime.mcpManager`, `runtime.refreshMcp`, `persistMcpServer`, `removeMcpServer`.** Components dispatch actions; the orchestrator owns the polling loop, snapshots manager state, drives variant γ live mutations, and emits typed actions onto the shared bus.
2. **Live config reads via `getConfig()` — never `runtime.config`.** `runtime.config` is a frozen bootstrap snapshot; `persistMcpServer` / `removeMcpServer` call `resetConfigCache()` so the next `getConfig()` returns the fresh server list. The orchestrator's `buildRows` / `buildDetail` go through `readConfiguredServers()` so adds and removes appear in the panel immediately.
3. **Persist before live mutation.** `addServerFromJson` writes `config.json` first, then calls `mcpManager.addServerLive` + `runtime.refreshMcp`. Live-connect failures degrade gracefully: the server stays in config and shows as `down`, the operator gets a `runtime_info` hint, and a restart will retry the connect. `removeServerFromJson` mirrors the symmetry — persist first, then `removeServerLive` + `refreshMcp`.
4. **The editor is disabled on the MCP tab while a modal is open.** `mcpTabBusy` in `app-key-bindings.ts` covers both `addModal !== null` (lets the `MultiLineEditor` capture every keystroke) and `removeConfirm !== null` (claims the `y`/`n` confirmation keys against the global nav cycler).
5. **Variant γ surface is opt-in but on by default.** Restarting the runtime is no longer required after add/remove — the prompt's `### tools` catalog and GBNF grammar are rebuilt on the next step. KV-cache for in-flight sessions is invalidated once per add/remove (the persona stays byte-stable; only the rendered tools block changes).

## Project path resolution (`os.fs.locate_project`)

Issue #77: users mention projects by name ("check my raylib project") instead of full paths. The read-only tool `os.fs.locate_project { name, limit? }` ([src/tools/os/fs-locate-project.ts](src/tools/os/fs-locate-project.ts) + [fs-locate-project-sources.ts](src/tools/os/fs-locate-project-sources.ts), registered with the other OS tools in `registerOsTools` — bootstrap constructs the `SessionStore` first and supplies the column-only projection through `RegisterOsToolsOptions.listRecentSessionDirs`) first takes a **direct-path fast path** — a pasted absolute path (`e:/_raylib`, `~/dev/app`) that exists as a directory is returned immediately (source `direct-path`) — and otherwise resolves the mention against three bounded sources, in priority order. The `name` argument is a short folder-name segment (the descriptor + examples teach the model to pass `raylib`, never the whole sentence — matching is per-basename, not phrase-tokenized):

1. **`cwd`** — the session working directory and its ancestors (basename match, bounded by path depth).
2. **`session-history`** — working dirs of recent sessions via `SessionStore.listRecentWorkingDirs`, a column-only projection (`working_dir`, `updated_at`) that never deserialises session payloads on this read path; stat-checked before use so deleted dirs never surface.
3. **`configured-root`** — the user-declared `projects.roots` dirs (config v36, default `[]`) and their direct children: ONE level, directories only, hidden names / `node_modules` / `__pycache__` / symlinks skipped. The listing streams via `opendir` and stops as soon as 500 ELIGIBLE dirs were seen, so loose files never consume the cap and a pathological root is never fully materialised. `ToolContext.signal` aborts between roots, between entries, and between the later stat/realpath batches.

Matching is case-insensitive and NFC-normalized on the basename with three tiers (exact > prefix > substring); a pasted fragment matches by its last segment with `\` normalized to `/` first. Candidate paths are canonicalized through `realpath` before dedup so symlink aliases of one dir (macOS `/tmp` vs `/private/tmp`) never read as a false ambiguity. Exactly one best-tier candidate ⇒ resolved path plus any weaker matches listed. Two or more best-tier candidates ⇒ the result says ambiguous and instructs the model to ask the user, never to guess. Zero ⇒ an honest miss that tells the model to ask for the full path or to suggest adding a parent dir to `projects.roots`.

**Locked invariants** (pinned by [src/tools/os/fs-locate-project.test.ts](src/tools/os/fs-locate-project.test.ts), [src/session/session-store.test.ts](src/session/session-store.test.ts), and [src/config/config-schema.test.ts](src/config/config-schema.test.ts)):

1. **No disk-wide scanning, ever.** The search space is the pasted path itself plus the three sources above; roots are scanned one level deep with no recursion. Empty `projects.roots` (the default) means nothing outside session history and the cwd chain is touched.
2. **Ambiguity is surfaced, not resolved.** Ties at the best match tier produce a candidate list and an ask-the-user instruction; `details.found` stays `false`. The verdict is computed on the full match list, so a small `limit` cannot fake confidence.
3. **A miss is honest, and honesty lives in the summary.** The miss text reports how many roots were actually scanned (never the configured count), and skipped / unreadable / truncated roots are repeated as `note:` lines in the output text — the model only ever sees the compressed summary (`toolResultTurn` carries no `details`), so details-only reporting would be invisible.
4. **Hidden dirs and dependency caches never match**, root scanning stops at one level, and the per-root cap applies after directory filtering.
5. **Resource class `pure_read`, descriptor tier `frequent`, segment-only teaching.** Fans out inside batches; the full args schema plus `examples` (`{"name":"raylib"}`) sit in the stable prefix so small local models can call it first-shot with a folder-name segment instead of copying a phrase (same rationale as the MCP `frequent` decision). Pinned by the `is pinned pure_read and frequent-tier` and `descriptor teaches a segment-only name` tests.
6. **The session-store read path is column-only.** `listRecentWorkingDirs` is a prepared `SELECT working_dir, updated_at` — no per-row `JSON.parse` on a tool that can appear 16 times in one batch.

Configuration: `projects.roots: string[]` in the user config file (v36, transparent migration; `~` expansion supported). Empty or non-absolute entries are skipped and reported (summary note + `details.invalidRoots`); unreadable roots land in `details.unreadableRoots` and the summary.

Deliberately out of scope: an opt-in whole-disk / drive index (the issue sketches it as a possible extra for people who want it — revisit only on real demand), fuzzy-distance matching, and per-root depth knobs.

## LLM reliability policy

Two narrow retry layers sit between the agent loop and `llama-server`. Both are deliberately bounded and never replay already-executed tool calls:

1. **Parser retry (step-executor).** If the first `parseToolCall` on a completion throws, the executor calls the unary `llmComplete` exactly once more with the same prompt/slot and re-parses. A `parse_retry` event is emitted for observability. If the second attempt also fails, the original error (with a raw-output preview) is thrown. The streaming path always falls back to unary for the retry so partial SSE deltas are not double-emitted.
2. **Transport retry (LlamaServerClient).** `complete()` and the initial pre-body fetch of `completeStream()` are wrapped in a bounded retry governed by `llama.completionRetries` (default 3) and `llama.completionRetryBackoffMs` (default 150ms, exponential with ±20% jitter). Retries fire **only** for network errors (`LlamaServerError.status === null`) and HTTP 5xx. Grammar/validation 4xx and abort signals short-circuit immediately. Once the SSE body starts streaming, no further retries happen — the conversation state on the server is considered indeterminate.

### Failure taxonomy

Every terminal failure the agent loop surfaces is normalised into a canonical `LlmFailureCategory` before `step_error` / `loop_failed` fire. The classes live in [src/llm/reliability/](src/llm/reliability/) and carry specialised fields for postmortem use.

| Category    | Class                | When it fires                                                                                         | Invariants                                                                                       |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `transport` | `TransportError`     | `LlamaServerError` with `status === null` or `status >= 500` (after the bounded retry is exhausted).  | Carries `status` and `url`. Transport retries already fired; runtime does not retry again here.  |
| `grammar`   | `GrammarError`       | `LlamaServerError` 4xx, or `ToolCallParseError` that survives the one-shot parser retry.              | Carries `rawPreview` of the completion body so postmortems can diagnose without replaying SSE.   |
| `model`     | `ModelError`         | `detectModelFailure` returns `truncated` / `empty` / `no_stop` on the initial or retry completion.    | **Never retried in-place** — the same prompt would reproduce the same wall. Parser retry skipped. |
| `tool`      | `ToolExecutionError` | Tool missing from the registry, or any unexpected error escaping the tool dispatch path.              | Carries `tool` name. Runtime tool failures from `registry.invoke` are folded into `CompressedToolResult { status: "error" }` and do **not** reach this category. |
| `cancelled` | `CancelledError`     | `ctx.signal.aborted` is true, or the caught error is an `AbortError` / message mentions `aborted`.    | The agent loop closes the turn with `reason: cancelled` and status `cancelled`, not `failed`.    |

`classifyFailure(err)` is the single source of truth for mapping raw thrown values into the taxonomy; `LlmFailure` instances short-circuit the classifier. `step-executor` wraps every escape with the correct subclass before the `step_error` event fires, and `agent-loop` classifies at the outer catch so `loop_failed` always carries `category` even for legacy errors.

### Observability propagation

`category` is plumbed through every observability surface:

- **Events.** `step_error.category` and `loop_failed.category` are mandatory fields on the `AgentLoopEvent` union. The `provider_switched` variant on the same union carries fallback-chain state changes (see §"Provider fallback chain").
- **Traces.** `TraceError.category` on the append-only NDJSON stream (see [src/tracing/trace/trace-event.ts](src/tracing/trace/trace-event.ts)).
- **Metrics.** `AgentMetrics.recordLlmFailure({ sessionId, category })` increments `agent.llm.failure` tagged by category — fired exactly once per failed turn from the agent-loop outer catch.
- **TUI.** `agent-event-reducer` renders `! [${category}] ${message}` in the step feed and `failed [${category}]: ${message}` in the run-status line.
- **Sidecar protocol.** `session_failed.category` and `error.code = step_error:<category>` for the Tauri host.
- **OpenAI SSE.** Atomic-extension clients receive `{ error, category }`; OpenAI-compatible clients receive `error.type = agent.<category>` (the `type` field is a loose string in the OpenAI error envelope).

## Provider fallback chain

A cross-provider circuit breaker layered **above** the single-provider reliability policy. Where the two retry layers above recover a request on the *same* provider, the fallback chain switches to a *different* configured provider when the active one is unavailable. It lives in [src/llm/fallback/](src/llm/fallback/). The `llmComplete` / `llmCompleteStream` seams that wrap it are built by [src/runtime/llm-fallback-seam.ts](src/runtime/llm-fallback-seam.ts) (`createFallbackCompleter` / `createFallbackStreamer`, injected with `{ fallbackChain, resolveSlice, recordUnaryUsage, recordStreamUsage }`) and wired in [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) — strictly **after** the per-provider retry budget (PR #90 `runOpenAiWithRetry`, `LlamaServerClient.completionRetries`) is spent, never inside it.

### Chain unit and config

The chain is an ordered list of **configured provider ids**, primary first. `CompletionRequest` carries no per-request model field — a provider instance pins its model at construction (`OpenAiProvider.defaultChatModel`), so a `model@provider` pair maps to one provider id in the registry; two models on the same upstream service are two provider entries. Config lives under `llm.fallback`:

```jsonc
"fallback": {
  "chain": ["openrouter-gpt", "groq-llama"],  // ordered provider ids; every id must be configured
  "appendLocal": true,                          // default true: append the llama-server provider id to the tail
  "failureThreshold": 3,                        // consecutive non-immediate failures before switching
  "cooldownMs": [30000, 60000, 300000],         // escalating ladder (must be non-decreasing); last entry is the cap
  "probeThrottleMs": 300000,                    // min gap between primary probes
  "failureWindowMs": 86400000                   // no-error window that resets the counter + ladder step
}
```

- `chain` defaults to `[activeTextProvider]` when absent. Unknown ids are rejected at config parse time (`parseLlmFallbackConfig`), and defensively dropped again at resolve time.
- The **active text provider is always the primary** — `resolveFallbackChain` hoists it to the head, so a TUI hot-swap re-primes the chain and drops any active override without editing `fallback.chain`.
- `appendLocal` auto-appends the configured `llama-server`-kind provider id to the tail (unless already present, or none is configured, or the flag is `false`).

### Reset policy (circuit breaker, per provider id, per session)

- **Which failures advance** is decided by `shouldAdvance(err)` from the reliability taxonomy: `transport` and `model` categories advance (provider unreachable or model dead); `grammar` / `tool` / `cancelled` never advance (same request fails identically everywhere, or it is our bug / a user abort). One centralized predicate — both wrappers route through it.
- **Immediate signals** (429 / 408 / any 5xx / network-null that is not our own request timeout) switch on the **first** occurrence, bypassing the threshold. All other advance-worthy failures increment a consecutive-failure counter and switch at `failureThreshold` (default 3). "Our own request timeout" covers **both** transports symmetrically — `OpenAiHttpError.timedOut` and `LlamaServerError.timedOut` (both surface as `status === null`) are weak evidence (one slow turn, not a down provider) and only count toward the threshold; a local timeout in particular must not switch immediately, since replaying it burns another full timeout of GPU time.
- **Per-session isolation.** One shared `ProviderFallbackChain` serves the main loop and every sub-runner (reflection, link-gen, vote, distill) across all concurrent sessions, so its mutable breaker state (`overrideId`, per-provider failure counters, cooldown ladder, probe throttle) is **partitioned by session id** (`runWithFallback(chain, attempt, sessionId)`). One session's success never clears another's armed cooldown, and their failure counters never cross-contaminate. A keyless call shares one default partition (back-compat for tests / non-session callers).
- **Sticky.** After switching, a per-partition `overrideId` keeps subsequent turns on the working provider — the dead primary is **not** retried every turn.
- **Escalating cooldown** on the failed provider: `30s → 60s → 300s` (cap), stepped each time it fails again while tripped. The counter and ladder step reset after `failureWindowMs` (24h) with no new failure, checked **lazily** on next access.
- **Probe.** When on an override and the primary's cooldown has elapsed **and** `probeThrottleMs` (5 min) has passed since the last probe, the next turn is routed back to the primary as a throttled probe. On success: clear the override, reset the breaker, emit a one-shot "switched back" notice. On failure: re-arm (escalate) the cooldown and stay on the override.
- **Notifications** ride a new `AgentLoopEvent`, `{ type: "provider_switched"; direction: "away" | "back"; from; to; reason }`, emitted through the same `turnController.emit` path as every other loop event — **at most one per state transition** (never on sticky turns). Bootstrap wires the chain's `noticeSink` to `emitAgentLoopEvent`.

### No new timer (invariant)

The probe is **lazy / turn-boundary driven** — `pickProvider()` reads `Date.now()` at the start of each completion and decides whether this turn probes. There is **no `setInterval`**: this respects the §"Background autonomy" invariant that `Scheduler` (plus the two documented carve-outs) is the only periodic timer in the runtime. If no turns arrive, no probe happens, which is correct — there is nothing to serve anyway. Same shape as the loop-detector per-turn check.

### Streaming

`llmCompleteStream` primes the first chunk (`primeStream`) inside the fallback attempt so a failure to **open** the stream (429/5xx before any output) advances the chain, while a stream that has begun emitting is never restarted (mirrors the openai-http "stream is live" contract). Later failures propagate as-is.

### Cross-transport fallover (request AND response)

A fallover can cross transports — the common `cloud (native_tools) → local (grammar)` default (`appendLocal`) does exactly that. Both the request shape and the response parse are decoupled from the primary:

- **Request.** Each attempt re-resolves `{ transport, adapter }` for the chosen link via `resolveActiveLlmSlice(providerId)`, so the wire shape is correct for whoever serves. `buildLlmStreamParams` keeps `grammar` **populated even on the native path** (it used to blank it) so a grammar-only link handed the request still has its GBNF; native providers ignore `grammar` and read `tools`, so carrying both is safe.
- **Response.** The completion is stamped with `servedTransport` — the transport of the link that actually answered — by the fallback seams in [src/runtime/llm-fallback-seam.ts](src/runtime/llm-fallback-seam.ts) (`createFallbackCompleter` / `createFallbackStreamer`). `step-executor.parseDepsFor(completion, deps)` prefers `servedTransport` over the caller's configured `toolTransport` for every parse decision (`tryParseToolCalls`, the empty-completion recovery gate). Without this, a native primary that fell over to a grammar link parsed the grammar reply as OpenAI `tool_calls` and silently broke tool-calling. The stamp is pinned directly on the real seam factories by [src/runtime/llm-fallback-seam.test.ts](src/runtime/llm-fallback-seam.test.ts) (deleting either stamp turns it red) and end-to-end through the loop by [src/llm/fallback/fallback-e2e.integration.test.ts](src/llm/fallback/fallback-e2e.integration.test.ts).

The remaining asymmetry: `tools` is populated only when the **primary's** transport is `native_tools`. Placing a native-tools provider **below** a grammar-only primary would reach it without a `tools` payload — an unusual ordering; order native-tools links at or above the first grammar-only link. Slot affinity is decided pre-request from the primary, so a cloud→local fallover runs the local link without slot-cache reuse for that turn (correctness-neutral). The grammar string itself is always built for the primary model.

### Locked invariants (Pinned by tests)

1. **429 / 5xx switches on the first failure; non-immediate transport failures switch at the threshold.** A self-inflicted request timeout on **either** transport (`OpenAiHttpError`/`LlamaServerError` `timedOut`) is non-immediate and only counts toward the threshold. Pinned by [src/llm/fallback/provider-fallback-chain.test.ts](src/llm/fallback/provider-fallback-chain.test.ts), [src/llm/fallback/should-advance.test.ts](src/llm/fallback/should-advance.test.ts).
2. **Sticky — the dead primary is not re-picked every turn**; only a throttled probe returns to it. Pinned by [src/llm/fallback/provider-fallback-chain.test.ts](src/llm/fallback/provider-fallback-chain.test.ts), [src/llm/fallback/run-with-fallback.test.ts](src/llm/fallback/run-with-fallback.test.ts).
3. **Cooldown escalates 30/60/300 and caps at 300s.** Pinned by [src/llm/fallback/provider-fallback-chain.test.ts](src/llm/fallback/provider-fallback-chain.test.ts).
4. **`grammar` / `tool` / `cancelled` never advance.** Pinned by [src/llm/fallback/should-advance.test.ts](src/llm/fallback/should-advance.test.ts), [src/llm/fallback/run-with-fallback.test.ts](src/llm/fallback/run-with-fallback.test.ts).
5. **Whole-chain exhaustion rethrows the last (already-humanized) error** so `loop_failed` classification is unchanged. Pinned by [src/llm/fallback/run-with-fallback.test.ts](src/llm/fallback/run-with-fallback.test.ts).
6. **Exactly one switch notice per state transition** (away / back), none on sticky turns. Pinned by [src/llm/fallback/provider-fallback-chain.test.ts](src/llm/fallback/provider-fallback-chain.test.ts).
7. **`appendLocal` appends the local provider when configured, nothing when not.** Pinned by [src/llm/fallback/fallback-config.test.ts](src/llm/fallback/fallback-config.test.ts).
8. **A cross-transport fallover parses the response with the served link's transport, not the primary's**, and the turn reaches the fallback's answer instead of `loop_failed`. Pinned by [src/llm/fallback/fallback-e2e.integration.test.ts](src/llm/fallback/fallback-e2e.integration.test.ts) (real `AgentLoop` + `step-executor`, both unary and streaming).
9. **Breaker state is partitioned by session** — one partition's success does not clear another's armed cooldown, and a keyless call shares one default partition. Pinned by [src/llm/fallback/provider-fallback-chain.test.ts](src/llm/fallback/provider-fallback-chain.test.ts) ("partition isolation").
10. **The cooldown ladder must be non-decreasing** — a decreasing `cooldownMs` is rejected at parse time so "escalating" stays true. Pinned by [src/config/llm-config.test.ts](src/config/llm-config.test.ts).

### TUI: the Fallback pane

The LLM tab gains a fourth pane, `fallback`, reached with `←`/`→` after Local / Cloud / External ([src/tui/llm-panel/llm-panel-state.ts](src/tui/llm-panel/llm-panel-state.ts) `LLM_PANEL_MODES`). It is the operator surface for `llm.fallback` — the same config the engine reads, edited through the same read → mutate → `writeUserConfigFileSync` → `resetConfigCache` path as every other provider setting. It lives in [src/tui/llm-panel/fallback/](src/tui/llm-panel/fallback/) plus the render in [src/tui/components/llm-fallback-rows.tsx](src/tui/components/llm-fallback-rows.tsx).

**What it shows.** The *effective* chain from `resolveFallbackChain`, one numbered link per row (`1. provider/model [kind]`), the active text provider always the head and tagged `active (primary)`, and the auto-appended local last resort tagged `local last resort (appendLocal)`. Below the list: the `appendLocal` toggle state and a `+ add link` row (present only when a configured provider is not yet in the chain).

**Keys** (do not collide with the tab's existing letters `f`/`n`/`c`/`e`/`E`/`s`/`B`/`L`/`r` or `[`/`]`): `j`/`k` move the row cursor; `<`/`>` move the selected link up/down in priority; `a` (or Enter) opens the add-link picker; `d` removes the selected link; `l` toggles `appendLocal`. The add-link picker owns the keyboard while open (↑/↓ move, Enter adds, Esc cancels).

**Persistence.** `FallbackOrchestrator` ([src/tui/llm-panel/fallback/fallback-orchestrator.ts](src/tui/llm-panel/fallback/fallback-orchestrator.ts)) is the **only** TUI writer of `llm.fallback.chain` / `llm.fallback.appendLocal`, via `setFallbackChainInConfig` in [src/tui/persist-llm-provider.ts](src/tui/persist-llm-provider.ts). It writes the operator's **declared** chain (displayed links minus the synthesised local tail) and re-validates with `parseLlmFallbackConfig` before writing, so an unknown id is rejected here, not on the next read. Timing knobs (`failureThreshold`, `cooldownMs`, …) set by hand are preserved across an edit. Nothing else writes this block, so the pane never fights the runtime `ProviderFallbackChain`.

**Live status is honest, not invented.** The runtime `ProviderFallbackChain` instance is bootstrap-local and **not** on `AgentRuntime`, so the pane cannot read live `cooldownUntil` / probe timers. It therefore never renders a countdown. Its one live signal is the last `provider_switched` `AgentLoopEvent` (already streamed to the TUI), mirrored into `fallbackPanel.lastSwitch`: `failed over A -> B (reason)` on `away`, `recovered primary B` on `back`, else `on primary (no fallover this session)`. If a future change surfaces the breaker state on `AgentRuntime`, the pane can upgrade to a real countdown — until then it shows config statics plus the last announced transition only.

#### Locked invariants (Pinned by tests)

1. **The pane lists the effective chain in order, active provider hoisted to the head and tagged, appended-local tagged.** Pinned by [src/tui/llm-panel/fallback/fallback-panel-selectors.test.ts](src/tui/llm-panel/fallback/fallback-panel-selectors.test.ts), [src/tui/components/llm-fallback-rows.test.tsx](src/tui/components/llm-fallback-rows.test.tsx).
2. **Reorder is clamped** — a move past either end is a no-op, and neither the active head nor the appended-local link can be reordered/removed. Pinned by [src/tui/llm-panel/fallback/fallback-chain-edits.test.ts](src/tui/llm-panel/fallback/fallback-chain-edits.test.ts).
3. **Move / add / remove / appendLocal-toggle persist to `config.json`** and re-mirror; hand-set timing knobs survive; the synthesised `appendLocal` local link is never written into the stored `chain` (no round-trip doubling); a provider hot-swap (`providers_refresh`) re-mirrors so the head follows the active provider. Pinned by [src/tui/llm-panel/fallback/fallback-orchestrator.test.ts](src/tui/llm-panel/fallback/fallback-orchestrator.test.ts).
4. **Keys route to the right intent** and the add-link picker owns the keyboard while open. Pinned by [src/tui/llm-panel/fallback/fallback-key-bindings.test.ts](src/tui/llm-panel/fallback/fallback-key-bindings.test.ts).
5. **`provider_switched` is mirrored into `fallbackPanel.lastSwitch`; the pane never invents a live countdown.** Pinned by [src/tui/llm-panel/fallback/fallback-panel-reducer.test.ts](src/tui/llm-panel/fallback/fallback-panel-reducer.test.ts), [src/tui/components/llm-fallback-rows.test.tsx](src/tui/components/llm-fallback-rows.test.tsx).
6. **Empty chain / nothing-addable shows a hint, not a broken list.** Pinned by [src/tui/components/llm-fallback-rows.test.tsx](src/tui/components/llm-fallback-rows.test.tsx), [src/tui/llm-panel/fallback/fallback-panel-reducer.test.ts](src/tui/llm-panel/fallback/fallback-panel-reducer.test.ts).

## Traceability and replay

Every run produces an append-only NDJSON trace at `<stateDir>/traces/<sessionId>.ndjson` — one event per line. Tracing is on by default for `atomic-agent run` / TUI / `atomic-agent serve`, and off by default in sidecar mode so the Tauri host decides whether to opt in.

Emitted `TraceEvent` types (see [src/tracing/trace/trace-event.ts](src/tracing/trace/trace-event.ts)):

- `session_started` — carries `workingDir` and optional `metadata`.
- `turn_started` / `turn_finished` — per macro-turn, with `reason` / `stepCount` / `durationMs`.
- `step_started` / `step_finished` — per inference step.
- `prompt_captured` — `{ stablePrefixHash, tail, tokens: { total, stablePrefix, tail }, slotId, cacheReused }`. The stable prefix is stored only as its salted hash (via `hashPrefix` from [src/llm/slot-manager.ts](src/llm/slot-manager.ts)) so trace files stay compact across steps; the variable tail is stored verbatim.
- `llm_completion` — full completion `content` + `reasoningContent` + `timing`, with `attempt: 1 | 2` (attempt 2 == parse retry). `reasoningContent` is sourced from two mutually-exclusive channels: **Channel A** is the dedicated `reasoning_content` SSE field (QwQ / DeepSeek-R1 with `--reasoning-format deepseek`); **Channel B** is the inline `<think>...</think>` / `<|channel>thought...<channel|>` block that the grammar-aware stream parser splits client-side. `consumeStream` accumulates both separately and prefers Channel A when both fire; the legacy `/completion` endpoint always falls back to Channel B because it never emits `reasoning_content`. Pinned by [src/agent/step-executor.test.ts](src/agent/step-executor.test.ts) "executeStep streaming reasoning accumulator".
- `tool_invocation` — executed tool call with args, status, summary, and optional details.
- `parse_retry`, `loop_detected`, `error`, `trace_truncated` — diagnostics.

Invariants:

- **Append-only.** Sinks never rewrite past lines. `trace_truncated` is a synthetic final marker when the per-session cap (`tracing.trace.maxBytesPerSession`, default 10 MiB) is hit; further events are dropped silently.
- **Per-session file.** One NDJSON per `sessionId`; no cross-session mixing.
- **Monotonic `seq`.** Every event carries a monotonic in-session sequence starting at `0`.
- **No redaction yet.** Secret redaction is an explicit NON-goal of this milestone; treat trace files as sensitive local artefacts.

CLI:

- `atomic-agent trace list [--limit N]` — most recent trace files in `<stateDir>/traces/`.
- `atomic-agent trace show <sessionId> [--step N] [--raw]` — pretty-print the chronology. `--raw` includes the full prompt tail and completion content; otherwise they are summarised.
- `atomic-agent trace export <sessionId> [--format ndjson|json]` — dump the file as-is (ndjson) or as a JSON array.
- `atomic-agent trace replay <sessionId> [--step N]` — rebuild the stable prefix from the current runtime (tools / capabilities / skills / persona) and compare its hash to the recorded `stablePrefixHash`. Drift means the upper prompt changed since recording — useful for postmortem when cache hits dropped.

Replay lives in [src/replay/](src/replay/). It is a **prompt-drift postmortem**, not a simulator: it does not reproduce LLM non-determinism or external world state (browser, filesystem). `replayInference` (programmatic, not wired to the CLI yet) can optionally rerun `LlamaServerClient` with the recorded prompts for regression tests across llama-server upgrades.

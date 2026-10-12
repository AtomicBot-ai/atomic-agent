# Model behavior mode

Status: current
Owner: src/llm/

`modelMode` records the behavior policy for a model, initially selected when adding a provider and manually overridable. It is independent of server location, tool transport and `llm.runMode.mode`, which selects local/cloud/Fusion routing. `local` keeps existing prompt packing, caps and result aging. `cloud` keeps full selected instructions and obtained tool output in an append-only model-visible history. Research stopping, Fusion reading limits and background memory extraction still use their existing policies; their adaptation remains in [the implementation plan](../../../docs/plans/cloud-model-adaptation.md).

## Configuration and switching

Each `llm.providers[]` entry accepts two optional fields:

```json
{
  "id": "remote",
  "kind": "openrouter",
  "defaultChatModel": "large-model",
  "modelMode": "cloud",
  "modelModes": { "small-model": "local" }
}
```

Resolution uses the exact model ID override first, then the provider default, then `local`. A missing or null field is absent; invalid modes and invalid map entries fail configuration validation. Runtime resolution does not infer policy from an endpoint, rewrite numerical limits or change model selection.

When adding a new connection through [provider commands](../../config/llm-provider-commands.ts), including the wizard, an explicit `modelMode` wins. Otherwise the writer saves `cloud` for OpenRouter, AI/ML API, Gemini, Claude/Codex subscription CLIs, and OpenAI-compatible entries whose URL origin matches OpenAI or a nonlocal [provider preset](../provider/presets/provider-presets.ts). Matching uses the actual URL origin, not the entry name; API path suffixes do not affect it. Local servers and unknown/custom endpoints receive `local`; their policy can be changed manually. This is a one-time saved default, not a new runtime `auto` mode.

The [v75 config migration](../../config/docs/compatibility.md) applies that same classification to existing providers in older files: a recognized cloud provider without a saved default receives `modelMode: "cloud"`. Explicit policies and model overrides are preserved; local/unknown providers are unchanged. Loading persists the upgraded config through the existing atomic writer. Files already at version 75 or newer are not reclassified, including after the operator removes a default with `inherit`. A missing version follows the existing current-version rule.

Overrides live in `modelModes`, separate from `userModels`, so changing behavior does not replace catalog capabilities or context-window metadata with a partial custom model entry. [Config validation](../../config/model-mode.ts), [provider parsing](../../config/llm-config.ts) and [persistence](../../config/model-mode-commands.ts) own the stored representation. After migration, provider updates preserve either field when it is omitted by the caller, including an absent default. The wizard returns the policy actually saved by the shared writer.

The TUI command is:

```text
/llm model-mode
/llm model-mode cloud
/llm model-mode local
/llm model-mode local remote small-model
/llm model-mode inherit remote small-model
```

With no arguments it shows the saved policy for the active configured provider/model. A mode without a provider ID changes the active provider's default; an explicit provider ID targets that provider. The optional final model ID changes only that model's override. `inherit` removes the selected override; it is not a third stored mode. A model override continues to win when the provider default changes. The command reports the effective mode and its source (`model`, `provider`, or `legacy`). Its model ID is the configured ID or managed local ID, not a discovery query to an external server.

Saving takes effect on the next turn without restarting the runtime. The command describes the effective context policy. Wizard labels and a visual indication of a pending change remain planned. This command does not switch the serving model or erase history. After migration, providers without a saved default resolve to `local` unless a model override applies. Removing the provider default with `inherit` restores that fallback; reconfiguration does not reapply automatic selection.

## Lifetime and propagation

[The resolver](../model-mode.ts) captures an immutable, credential-free snapshot of all providers' policy settings and selected model IDs. [The turn service](../../runtime/composition/runtime-turn-service.ts) owns this snapshot for one execution of a user turn. A Fusion worker started while its parent is active inherits the same snapshot, then resolves its own pinned provider. Standalone ephemeral turns capture their own snapshot. The runtime releases its parent lookup when the turn ends.

The snapshot travels through explicit loop/step dependencies to inference. Background reflection receives the originating turn's snapshot even when it outlives that turn. [Link attempts](../../runtime/llm-link-attempt.ts) resolve policy for the actual provider attempted, including fallback, for unary and streamed requests. Retries retain the snapshot. This fixes policy settings for the turn, not every other live runtime setting or the state of an external model server.

`BuiltPrompt.modelMode` describes the provider whose prompt was prepared. The metadata itself does not enter prompt text or token accounting. A fallback attempt resolves its own `CompletionRequest.modelMode`, rebuilds the prompt when transitioning to/from cloud, and checks its actual context window. A sticky fallback is also resolved before the next step's maintenance, so an already-cloud session cannot compact early because of the primary's local pair cap. The completion carries the serving policy to tool dispatch and commit. Provider wire builders do not serialize policy or budget metadata. Next-turn previews resolve current saved settings; they are not a report of a running turn's older snapshot.

## Cloud context and caching

[Cloud assembly](../../prompt/build-cloud-prompt.ts) bypasses section, pair, batch and render quotas. Loaded skills/tools, selected profile facts, recalled note bodies and obtained tool text remain complete. Selected memory/lesson/procedure indexes remain discovery pointers; choosing relevant memory and tool retrieval ranges is separate from shortening a returned result. Explicit source limits and safety gates remain enforced. Previously clipped local history cannot be restored by changing the flag.

[The session journal](../../session/cloud-context.ts) persists exact messages and transcript-based call IDs. Replying, retrying, previewing or restarting does not rewrite old bodies. A loaded skill returned by `skill.view` is retained once; missing bodies and state changes become full context messages with stable IDs and explicit supersession. Unchanged state adds nothing. Native and flat prompts project the same logical journal. The native cloud prompt has no separately rebuilt final user tail, and Anthropic cache control marks the last content-bearing history message. Stable system/catalog bytes remain shared with local assembly. Live catalog/config/role changes and provider framing can still change the cached prefix; actual cache hits are provider measurements, not guaranteed by this layout.

Runtime commits journal candidates before inference under the session owner; ephemeral workers retain them in memory. Pure preview never writes. Cancellation persists completed tool pairs, including full results, before ending the cloud turn. Compaction replaces covered history only in the model projection and carries active instructions/state in full; the original journal and transcript stay available. Cloud does not use mechanical trimming if compaction fails. See [assembly](../../prompt/docs/assembly.md) and [compaction](../../runtime/docs/compaction.md).

Capacity estimates include prompt content, native schemas, message overhead, output reserve and a 1024-token safety margin. The final OpenAI body is checked again after strict/schema and model parameter conversion, including the effective output cap. A known overflow is rejected without deleting messages. Unknown windows have no invented section ceiling and are still subject to the provider's rejection. Estimates use the shared heuristic, not the provider tokenizer. Preview shares cloud assembly and schema accounting; live recall and provider overrides can change the eventual request.

## Evidence

- [Config compatibility](../../config/model-mode.test.ts), [migration persistence](../../config/config-file.test.ts) and [resolution](../model-mode.test.ts): old files, v75 one-time migration, validation, precedence, independent providers and snapshot isolation.
- [Provider persistence](../../config/llm-provider-commands.test.ts), [command persistence](../../tui/commands/model-mode-command.test.ts) and [wizard preservation](../../tui/providers/save-provider-wizard.test.ts): automatic defaults for new connections, migration on load, manual precedence after migration, both switching directions, config reload and preserved model metadata.
- [Turn service](../../runtime/composition/runtime-turn-service.test.ts), [Fusion loop](../../agent/agent-loop-fusion-seams.test.ts), [fallback](../../runtime/llm-fallback-seam.test.ts), [finalization](../../agent/turn/turn-finalization.test.ts) and [reflection](../../memory/reflection/reflection-runner.test.ts): inheritance and request propagation.
- [Prompt baseline](../../prompt/model-mode-baseline.test.ts): unchanged local prompt bytes, budgets, loaded-skill truncation and result aging; complete cloud content and no policy fields on the wire.
- [Cloud history](../../prompt/cloud-context.test.ts): long skills/results/state, prefix preservation, deduplication, restart, switching, stable call IDs and final schema/output accounting.
- [Cloud execution seam](../../agent/cloud-context-seam.test.ts): full raw batch through compression and persistence, warning preservation, cancellation, pre-inference save and unary/stream fallback policy rebuilding.
- [Compaction](../../runtime/context-compaction.test.ts) and [preview](../../runtime/composition/runtime-prompt-preview.test.ts): full active instructions across a real checkpoint, journaled state in summary input and preview purity.

These are offline compatibility checks. They do not measure cache hit rates, model quality, latency or cloud cost.

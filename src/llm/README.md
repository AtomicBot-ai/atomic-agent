# Inference protocols and model profiles

Status: current
Owner: src/llm/

This area owns inference protocols and model profiles. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [model-profile.ts](model-profile.ts)
- [profile-invariants.ts](profile-invariants.ts)
- [server-template-policy.ts](server-template-policy.ts)
- [llama-server-client.ts](llama-server-client.ts)
- [dry-sampler.ts](dry-sampler.ts): the opt-in DRY anti-repeat fields for `/completion` (`localModels.drySampler`)
- [model-sampling-fields.ts](model-sampling-fields.ts): who decides each `/completion` sampling field: request, env, the model's own recommendation ([gguf-sampling.ts](../local-llm/catalog/gguf-sampling.ts), opt-in `localModels.modelSampling`), built-in default
- [slot-manager.ts](slot-manager.ts)
- [toolcall-bench/](toolcall-bench/index.ts): the fixed tool-call reliability prompts, their scoring, and asking one question to several models, and the model council: judge prompt and its Agree / Disagree / Unique parser, seats with Self-MoA repeats, peer ranking, the chairman prompt, the cost forecast and `runCouncil` over all stages (`models toolcall-bench`, `models ask`, `models council`, `/council`, `POST /api/council`, ATO-2432)
- [transport-deadlines.ts](transport-deadlines.ts) and [offline-network.ts](offline-network.ts): the process-wide HTTP pool and the offline-mode kill switch composed into it ([offline mode](docs/offline-network.md), ATO-1084); every socket the pool opens to a loopback address marks its errors ([loopback socket mark](loopback-socket-mark.ts), ATO-2767), so a local server's read reset is provably local to the process-global handler
- [openai-privacy-shield.ts](provider/openai/openai-privacy-shield.ts): Privacy Shield on the cloud wire (ATO-1081). Every cloud provider is an `OpenAiProvider`; with `privacy.shield.enabled` its body `messages` go out masked by the session vault and the reply, reasoning and tool-call arguments come back unmasked, streamed chunks included. With `privacy.shield.localNames` it first awaits the local name pass (ATO-2394) so names and addresses go out as placeholders too. Never for a server on this machine or the local network ([privacy shield](../privacy/README.md)).
- [api-key-command.ts](provider/openai/api-key-command.ts): a provider key printed by `apiKeyCommand` (Vertex AI's `gcloud auth print-access-token`), run without a shell and cached briefly. Its environment is the agent shell command's filtered one, so it cannot read the agent's other provider keys; password-manager and cloud-CLI sign-ins (`OP_SESSION_*`, `BW_SESSION`, `AWS_*`, `CLOUDSDK_*`, ...) stay ([api-key-command-env.ts](provider/openai/api-key-command-env.ts), ATO-1716).

## Ownership and dependencies

Model profiles connect prompt framing, grammar and streamed parsing. Provider adapters own transport-specific request/response formats; fallback owns per-session provider stickiness and probes. SlotManager coordinates local inference resources while runtime owns wiring. Inspect provider/openai for strict or tagged schema changes and grammar for constrained local decoding.

## Task-specific reading

Read docs/profiles.md for framing/grammar and docs/fallback.md for reliability; provider/openai tests for wire/schema changes.

Read [subscription OAuth primitives](provider/subscription-oauth/README.md) before wiring any subscription sign-in; they are not used by a provider yet.

Read [model behavior mode](docs/model-mode.md) for the explicit local/cloud policy flag, configuration precedence, per-turn lifetime and full cloud context. Native message IDs remain stable across checkpoints; the final OpenAI body checks messages, schemas and output reserve against a known cloud window before sending.

Read [router/README.md](router/README.md) for the opt-in rule-based model router (`llm.router`, ATO-483): it puts a provider first in a turn's fallback chain by request features and stays silent under the local run mode, Fusion or a pinned turn.

## Validation

`npx vitest run src/llm`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

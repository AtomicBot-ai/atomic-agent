# Local, Cloud and Fusion resolution

Status: current
Owner: src/llm/run-mode/

The resolver derives the effective mode from live provider configuration and validated pins. A stored mode label alone does not guarantee that its designated orchestrator is active. Switching providers re-resolves behavior; worker and orchestrator provider kind/id validation belongs to config.

A role's model is sent, not only shown (ATO-1560): on a provider that serves several models (cloud, LM Studio, Ollama) the resolver sets `orchestratorTurnModel`, `workerTurnModel` and the `turnModel` of escalation, judge and role models whenever the picked model is not the entry's own chat model. Worker, escalation and judge calls carry it as a per-turn model; the orchestrator's unpinned requests get it from [fusion-link-model.ts](fusion-link-model.ts) in the fallback seam. A `llama-server` leg never gets one: it serves the model it loaded.

A worker on a `llama-server` other than the main local one (`localModels.url`, passed as `localServerUrl`) is somebody else's llama.cpp (ATO-1562, [foreign-llama-server.ts](foreign-llama-server.ts)). Its unpinned label is its entry's `model`, never the managed model; `fusion.delegate` then labels its rows with what the server's `/props` says it serves.

Read [LLM instructions](../AGENTS.md), [resolver](resolve-run-mode.ts), [resolver tests](resolve-run-mode.test.ts), [run-mode schema](../../config/llm-run-mode-config.ts), and [workers](../../tools/fusion/README.md).

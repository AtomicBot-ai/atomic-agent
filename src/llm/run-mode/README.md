# Local, Cloud and Fusion resolution

Status: current
Owner: src/llm/run-mode/

The resolver derives the effective mode from live provider configuration and validated pins. A stored mode label alone does not guarantee that its designated orchestrator is active. Switching providers re-resolves behavior; worker and orchestrator provider kind/id validation belongs to config.

Read [LLM instructions](../AGENTS.md), [resolver](resolve-run-mode.ts), [resolver tests](resolve-run-mode.test.ts), [run-mode schema](../../config/llm-run-mode-config.ts), and [workers](../../tools/fusion/README.md).

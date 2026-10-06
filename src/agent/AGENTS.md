# Agent turn and step execution

Scope: `src/agent/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Preserve one inference per step. Grammar completions are arrays, including solo calls; parsing compatibility with old bare objects is not the production grammar.
- Preserve resource-class planning, synchronous loop gates, batch-index result order and the terminal-tail barrier. A reply batched with work can be a progress note; read the batching contract before changing this decision.
- Keep parse recovery distinct from tool failures and cancellation. Terminal verbs are not loop-gated. Do not restart already committed streamed output.
- Turn policies, read coverage, evidence checks and steering must stay enforced at dispatch, not just taught in the prompt.

## Read when relevant

Read docs/batching.md for dispatch, docs/recovery.md for failures/progress, and ../prompt/AGENTS.md plus ../llm/AGENTS.md for inference changes.

## Checks

Run `npx vitest run src/agent` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.

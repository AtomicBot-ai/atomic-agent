# Prompt assembly and cache contracts

Scope: `src/prompt/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Stable-prefix bytes must stay stable within their session/role scope. A descriptor/skill/persona change can invalidate the cache once; tool.view or profile writes belong in the tail.
- Preserve the actual section order in build-prompt.ts, including request and route when present. Step-mutable profile/lessons/procedures/loaded sections follow conversation.
- Do not remove the tool catalog on a terminal-only step: grammar and dispatch enforce the restriction. Preserve packer low-water behavior and all token-budget deductions.
- Prompt, grammar and stream parser must agree on who emits reasoning markers. Follow ../llm/AGENTS.md; never update a golden hash merely to silence an unexplained change.

## Read when relevant

Read README.md and docs/assembly.md for prompt/budget edits; ../tools/AGENTS.md for descriptor/schema edits.

## Checks

Run `npx vitest run src/prompt` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.

# Prompt assembly

Status: current
Owner: src/prompt/

## Stable prefix

`buildStablePrefix` owns persona, rules, skill catalog, tools, capabilities and instructions. Catalog/role changes intentionally alter these bytes; loading a tool/skill or writing a profile does not. The grammar is sent per request, outside the cached prefix.

## Variable tail

The actual flat assembly in `build-prompt.ts` is:

1. Optional memory-index, session-facts, recalled; world.
2. Optional request when the original user request was packed out of view.
3. Optional context summary, then fresh conversation.
4. Optional route, profile, lessons, procedures, loaded-skills, loaded-tools, task-policy, notice.
5. Respond anchor and profile-specific generation framing.

Empty optional sections are omitted. Notice composition and structured messages share this contract. Sections changed by a step follow conversation; moving them above it can invalidate already read transcript context. The turn's memory snapshot is fetched before stepping.

## Budget and packing

Configured caps, context-window detection, reserved completion capacity and section budgets jointly bound the prompt. ConversationMaxTokens=0 means auto; the configured fallback when a window is unknown is not an arbitrary tiny token share. The packer retains its cut between overflows and cuts deeper when prefix reuse is unavailable. Profile, lessons, procedures and loaded sections consume room that must not be counted twice.

Read the implementation for exact defaults; historical ~2.5k targets are not a universal current window ceiling.

`sessionSectionsMaxTokens` bounds session-facts and loaded-skills. An explicit cap is enforced verbatim, without a floor or a clamp to the model window: later world/memory/tool sections are not known at that point. An oversized cap can squeeze conversation to its floor and still overflow the window. These limitations are pinned in build-prompt tests; do not infer a total-prompt guarantee from this one cap.

## Sources and tests

- [Assembly](../build-prompt.ts), [stable prefix](../stable-prefix.ts), [budget](../token-budget.ts).
- [Assembly tests](../build-prompt.test.ts), [auto cap](../conversation-cap-auto.test.ts), [profile invariants](../../llm/profile-invariants.test.ts).
- [Model framing](../../llm/docs/profiles.md), [tool contracts](../../tools/docs/contracts.md).

The pure [compaction planner](../plan-compaction.ts) measures history before mechanical packing. [The session projection](../../session/session-compaction.ts) feeds flat/native prompts and preview from one checkpoint and suffix, retaining covered task/user requests verbatim. Summary tokens are counted separately. Model calls and persistence belong to [runtime compaction](../../runtime/docs/compaction.md), never to prompt assembly or preview.

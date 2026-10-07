# Profiles, grammar and reasoning ownership

Status: current
Owner: src/llm/

## Ownership

Qwen-thinking prefills `<think>` in the prompt. Its grammar starts inside the reasoning body and normalization restores the opening tag before parsing. Nemotron shares this profile's opener ownership.

Gemma-thinking uses a system turn containing `<|think|>` and ends at the model-turn opener. The model emits `<|channel>thought`; the grammar includes that opener. Neither completion normalization nor the stream parser may prepend a second opener. A prefilled Gemma thought channel has different semantics and cannot replace native framing.

Thinking=off on a hand-built Qwen prompt uses its explicit disabled marker and plain grammar. Gemma has no equivalent marker in this path. The server-template path separately passes the template switch when supported; auto selects templating for plain-instruct profiles.

## Bounds and wire contract

ReasoningBudgetTokens defaults to 1500; the grammar body uses an approximately four-characters-per-token bound. Zero retains the unbounded variant. Whitespace between the reasoning-close sentinel and array is bounded. Forced terminal steps use the unbounded reasoning variant. Preserve these distinctions in grammar, unary parsing, streaming and repair prompts.

Native-tool wire contracts live under provider/. Strict conversion is per tool, does not close an originally open schema, and tracks which top-level optional arguments were widened to null. Do not drop required nullable data. Emitted strict functions force parallel_tool_calls=false. Nested third-party schemas require inspecting both tagged validation and null normalization rather than assuming built-in flat shapes.

## Sources and tests

- [Profiles](../model-profile.ts), [template policy](../server-template-policy.ts), [grammar](../grammar/build-grammar.ts), [prelude variants](../grammar/reasoning-prelude.ts).
- [Profile assertions](../profile-invariants.ts), [profile tests](../profile-invariants.test.ts), [grammar tests](../grammar/build-grammar.test.ts), [stream parser tests](../grammar/stream-parser.test.ts).
- [Strict schema conversion](../provider/openai/strict-tool-schema.ts), [native adapter tests](../provider/openai/openai-tool-call-adapter.test.ts), [tagged adapter tests](../provider/openai/qwen-tagged-tool-response-adapter.test.ts).

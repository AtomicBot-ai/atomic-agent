# LLM health projection

Status: current
Owner: src/tui/llm-health/

Read [TUI instructions](../AGENTS.md). [Health state](llm-health-state.ts) defines the UI status; [badge and llmHealthLook](llm-health-badge.tsx) map it to theme colors/glyphs for page or rail surfaces. [Composer controls](../composer-switch/composer-backend-control.tsx) import that mapping directly instead of maintaining another status table.

[The poller](llm-health-poller.ts) owns its interval and probe-in-flight gate; its owner explicitly starts/stops it. URL changes reset settlement/model discovery. Local health/model projection is gated by the active text route, so cloud sessions do not inherit an unrelated daemon label. Config, llama health requests and managed credentials belong to their domains. Relocating the view leaves those timers, requests and glyphs unchanged.

Run `npx vitest run src/tui/llm-health src/tui/composer-switch` for polling lifecycle, URL/route projection and consumer controls; there is no dedicated badge test at this point. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`.

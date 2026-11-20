# Last-resort fallback question (ATO-1461)

Status: current
Owner: src/tui/append-local-question/

People who turned on "local model as the last-resort fallback" (`llm.fallback.appendLocal: true`) before v0.7.0 are asked once at startup: "Local model is set as your last-resort fallback. Keep it?". [AppendLocalQuestionOrchestrator](append-local-question-orchestrator.ts) reads and records the answer through [runtime/append-local-question.ts](../../runtime/append-local-question.ts), the same files the desktop reads through `GET` / `POST /api/fallback/local-question`, so an answer in one is not asked again in the other. [Keys](append-local-question-key-bindings.ts): `y` / `k` keeps, `n` / `t` turns it off (writes `appendLocal: false`), both remembered; `Esc` closes without an answer so the next start asks again. The [modal](append-local-question-modal.tsx) waits behind the folder trust question. Turning the switch on by hand in the Fallback pane counts as Keep.

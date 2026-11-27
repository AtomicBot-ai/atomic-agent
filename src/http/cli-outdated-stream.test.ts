import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-2523: the subscription CLI that answered is older than Atomic Agent
 * supports. A host that opted into extensions gets one named frame with
 * the update commands and the chat sentence; the plain OpenAI stream
 * stays as it was.
 */
describe("cli_outdated over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = (extensionsEnabled: boolean) =>
    ({
      completionId: "cmpl-1",
      created: 0,
      session: { id: "sess-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    }) as never;
  const event = {
    type: "cli_outdated" as const,
    stepIndex: 0,
    cli: "codex" as const,
    productName: "Codex",
    version: "0.121.0",
    minimum: "0.122.0",
    updateCommands: ["npm install -g @openai/codex@latest"],
  };

  it("carries the version, the commands and the sentence for the chat", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))(event as never);
    expect(sse.written).toEqual([
      {
        name: "cli_outdated",
        payload: {
          object: "atomic.cli_outdated",
          session_id: "sess-1",
          step_index: 0,
          cli: "codex",
          version: "0.121.0",
          minimum: "0.122.0",
          update_commands: ["npm install -g @openai/codex@latest"],
          notice:
            "Codex 0.121.0 is out of date: run `npm install -g @openai/codex@latest` (Atomic Agent needs 0.122.0 or newer).",
        },
      },
    ]);
  });

  it("stays off the plain OpenAI stream", () => {
    const plain = makeSse();
    buildStreamEventHook(plain.writer as never, env(false))(event as never);
    expect(plain.written).toEqual([]);
  });
});

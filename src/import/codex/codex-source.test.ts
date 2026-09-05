import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexSource } from "./codex-source.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("CodexSource", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "codex-src-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reads AGENTS.md and only allowlisted auth keys", () => {
    writeFileSync(join(stateDir, "AGENTS.md"), "prefer bun\n");
    writeFileSync(
      join(stateDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-x",
        tokens: { access: "not-this" },
      }),
    );
    const source = new CodexSource(stateDir);
    expect(source.readAgentsMd()).toBe("prefer bun");
    expect([...source.readAuthKeys(["OPENAI_API_KEY"]).entries()]).toEqual([
      ["OPENAI_API_KEY", "sk-x"],
    ]);
  });

  it("treats a null OPENAI_API_KEY (ChatGPT login) as nothing to migrate", () => {
    writeFileSync(
      join(stateDir, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }),
    );
    const source = new CodexSource(stateDir);
    expect(source.readAuthKeys(["OPENAI_API_KEY"]).size).toBe(0);
  });

  it("lists rollouts recursively across date shards, newest first", () => {
    const dayA = join(stateDir, "sessions", "2026", "08", "01");
    const dayB = join(stateDir, "sessions", "2026", "08", "02");
    mkdirSync(dayA, { recursive: true });
    mkdirSync(dayB, { recursive: true });
    const older = join(dayA, "rollout-2026-08-01-aaa.jsonl");
    const newer = join(dayB, "rollout-2026-08-02-bbb.jsonl");
    writeFileSync(older, "");
    writeFileSync(newer, "");
    utimesSync(older, new Date("2026-08-01T10:00:00Z"), new Date("2026-08-01T10:00:00Z"));
    utimesSync(newer, new Date("2026-08-02T10:00:00Z"), new Date("2026-08-02T10:00:00Z"));

    const metas = new CodexSource(stateDir).listSessions();
    expect(metas.map((m) => m.id)).toEqual([
      "2026-08-02-bbb",
      "2026-08-01-aaa",
    ]);
  });

  it("projects a rollout's response items and drops the wrappers", () => {
    const dir = join(stateDir, "sessions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-x.jsonl");
    writeFileSync(
      file,
      [
        line({
          timestamp: "2026-08-02T10:00:00Z",
          type: "session_meta",
          payload: { id: "sess-1", cwd: "/work" },
        }),
        line({
          timestamp: "2026-08-02T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<user_instructions>be terse</user_instructions>" }],
          },
        }),
        line({
          timestamp: "2026-08-02T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "list the files" }],
          },
        }),
        line({
          timestamp: "2026-08-02T10:00:03Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "an ls will do" }],
          },
        }),
        line({
          timestamp: "2026-08-02T10:00:04Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            call_id: "c1",
            arguments: JSON.stringify({ command: ["ls"] }),
          },
        }),
        line({
          timestamp: "2026-08-02T10:00:05Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "c1",
            output: "README.md",
          },
        }),
        line({
          timestamp: "2026-08-02T10:00:06Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "just README.md" }],
          },
        }),
        line({ timestamp: "2026-08-02T10:00:07Z", type: "event_msg", payload: { type: "noise" } }),
      ].join(""),
    );

    const source = new CodexSource(stateDir);
    const session = source.readSession(source.listSessions()[0]!);
    expect(session.id).toBe("sess-1");
    expect(session.cwd).toBe("/work");
    expect(session.startedAtMs).toBe(Date.parse("2026-08-02T10:00:00Z"));
    expect(session.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(session.messages[0]!.blocks).toEqual([
      { type: "text", text: "list the files" },
    ]);
    expect(session.messages[2]!.blocks).toEqual([
      { type: "toolCall", id: "c1", name: "shell", args: { command: ["ls"] } },
    ]);
    expect(session.messages[3]!.blocks).toEqual([
      { type: "toolResult", callId: "c1", text: "README.md" },
    ]);
  });
});

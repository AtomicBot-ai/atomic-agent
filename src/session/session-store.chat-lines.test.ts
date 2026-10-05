import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";
import type { ConversationTurn } from "./conversation-turn.js";

// ATO-199: the profile's name check reads every stored user message
// through `listChatLines`, so it must hand back exactly the user
// messages and closing replies, in order, and never throw on a bad row.
describe("SessionStore.listChatLines", () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-sess-lines-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns user messages and closing replies in transcript order", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "Меня зовут Надя", at: 1 },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a" }, at: 2 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "Анна", at: 3 },
      { kind: "assistant_reply", text: "working on it", progressNote: true, at: 4 },
      { kind: "assistant_reply", text: "Привет, Надя!", at: 5 },
      { kind: "user", text: "спасибо", steered: true, at: 6 },
    ];
    store.save({ ...createEmptySessionState({ id: "s1", workingDir: "/w" }), turns });
    expect(store.listChatLines("s1")).toEqual([
      { kind: "user", text: "Меня зовут Надя" },
      { kind: "assistant_reply", text: "Привет, Надя!" },
      { kind: "user", text: "спасибо" },
    ]);
  });

  it("is empty for an unknown id and for a payload that will not parse", () => {
    const raw = new DatabaseCtor(join(tmp, "sessions.sqlite"));
    try {
      raw
        .prepare(
          `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
           VALUES ('bad', '/w', 'pending', '{not json', 9, 9000)`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
           VALUES ('odd', '/w', 'pending', '{"turns":["text",{"kind":"user","text":7}]}', 9, 9000)`,
        )
        .run();
    } finally {
      raw.close();
    }
    expect(store.listChatLines("missing")).toEqual([]);
    expect(store.listChatLines("bad")).toEqual([]);
    expect(store.listChatLines("odd")).toEqual([]);
  });
});

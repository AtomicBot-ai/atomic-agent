import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationTurn } from "../conversation-turn.js";
import { createEmptySessionState } from "../session-state.js";
import { SessionStore } from "../session-store.js";
import { exportDataset } from "./export-dataset.js";
import { createDatasetScrubber } from "./scrub-dataset-text.js";

const OPENAI = "sk-proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34";

let tmp: string;
let store: SessionStore;
let out: string;

function saveChat(id: string, updatedAt: number, turns: ConversationTurn[]): void {
  store.save({ ...createEmptySessionState({ id, workingDir: "/w" }), turns, updatedAt });
}

function readLines(): unknown[] {
  return readFileSync(out, "utf8").trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atomic-agent-dataset-"));
  store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  out = join(tmp, "dataset.jsonl");
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("exportDataset (ATO-1104)", () => {
  it("writes one scrubbed chat per line, newest first, without tool calls or tool output", () => {
    saveChat("s-old", 1_000, [
      { kind: "user", text: "old question", at: 1 },
      { kind: "assistant_reply", text: "old answer", at: 2 },
    ]);
    saveChat("s-new", 2_000, [
      { kind: "user", text: `my key is ${OPENAI}, mail me at nadya@example.com`, at: 1 },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "/Users/nadya/.env" }, at: 2 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "SECRET_TOOL_OUTPUT", at: 3 },
      { kind: "assistant_reply", text: "working on it", progressNote: true, at: 4 },
      { kind: "assistant_reply", text: "Saved it under /Users/nadya/notes.md", at: 5 },
    ]);
    saveChat("s-quiet", 3_000, [{ kind: "user", text: "no answer yet", at: 1 }]);

    const scrubber = createDatasetScrubber({ homeDir: "/Users/nadya" });
    const result = exportDataset({ store, outFile: out, scrubber, pageSize: 1 });

    expect(result).toEqual({ records: 2, messages: 4, sessionsRead: 3, sessionsSkipped: 1 });
    expect(readLines()).toEqual([
      {
        messages: [
          { role: "user", content: "my key is [redacted:openai-key], mail me at <email>" },
          { role: "assistant", content: "Saved it under ~/notes.md" },
        ],
      },
      {
        messages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
      },
    ]);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("SECRET_TOOL_OUTPUT");
    expect(text).not.toContain("working on it");
    expect(scrubber.counts).toEqual({ secrets: 1, emails: 1, homePaths: 1 });
    if (process.platform !== "win32") expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("stops at --sessions chats and at the --since date", () => {
    for (const [id, at] of [["a", 1_000], ["b", 2_000], ["c", 3_000]] as const) {
      saveChat(id, at, [
        { kind: "user", text: `q ${id}`, at: 1 },
        { kind: "assistant_reply", text: `a ${id}`, at: 2 },
      ]);
    }
    const scrubber = () => createDatasetScrubber({ homeDir: "/Users/nadya" });

    expect(exportDataset({ store, outFile: out, scrubber: scrubber(), maxSessions: 2 }).records).toBe(2);
    expect(readLines().map((r) => (r as { messages: { content: string }[] }).messages[0]!.content)).toEqual([
      "q c",
      "q b",
    ]);

    rmSync(out);
    expect(exportDataset({ store, outFile: out, scrubber: scrubber(), sinceMs: 2_000 }).records).toBe(2);
    rmSync(out);
    expect(exportDataset({ store, outFile: out, scrubber: scrubber(), sinceMs: 5_000 }).records).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("");
  });

  it("never writes over a file that is already there", () => {
    writeFileSync(out, "keep me");
    expect(() =>
      exportDataset({ store, outFile: out, scrubber: createDatasetScrubber({ homeDir: "/h" }) }),
    ).toThrow();
    expect(readFileSync(out, "utf8")).toBe("keep me");
  });

  it("removes a half-written file when reading fails", () => {
    const broken = {
      listSummaryPage: () => {
        throw new Error("disk gone");
      },
      listChatLines: () => [],
    };
    expect(() =>
      exportDataset({ store: broken, outFile: out, scrubber: createDatasetScrubber({ homeDir: "/h" }) }),
    ).toThrow("disk gone");
    expect(existsSync(out)).toBe(false);
  });
});

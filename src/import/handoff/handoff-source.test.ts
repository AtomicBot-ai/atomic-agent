import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HandoffNotFoundError,
  defaultHandoffSourceDir,
  listHandoffCandidates,
  readHandoffTranscript,
} from "./handoff-source.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

function claudeSession(
  stateDir: string,
  id: string,
  cwd: string,
  text: string,
  at: string,
  extra: string[] = [],
): void {
  const dir = join(stateDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(
    file,
    [
      line({
        type: "user",
        cwd,
        timestamp: at,
        message: { role: "user", content: text },
      }),
      ...extra,
    ].join(""),
  );
  const when = new Date(at);
  utimesSync(file, when, when);
}

describe("handoff source", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "handoff-src-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("defaults to the same dirs and env vars as atag import", () => {
    expect(defaultHandoffSourceDir("claude-code", {}, "/h")).toBe("/h/.claude");
    expect(defaultHandoffSourceDir("codex", {}, "/h")).toBe("/h/.codex");
    expect(
      defaultHandoffSourceDir("claude-code", { CLAUDE_CODE_STATE_DIR: "/x" }, "/h"),
    ).toBe("/x");
    expect(defaultHandoffSourceDir("codex", { CODEX_STATE_DIR: "/y" }, "/h")).toBe("/y");
  });

  it("lists Claude Code sessions newest first with cwd and a title", () => {
    claudeSession(stateDir, "old", "/work/a", "first task", "2026-11-01T10:00:00Z");
    claudeSession(stateDir, "new", "/work/b", "second task\nmore", "2026-11-02T10:00:00Z");
    const list = listHandoffCandidates({ agent: "claude-code", sourceDir: stateDir });
    expect(list.map((c) => c.id)).toEqual(["new", "old"]);
    expect(list[0]).toMatchObject({
      agent: "claude-code",
      cwd: "/work/b",
      title: "second task",
      messageCount: 1,
    });
  });

  it("respects the list limit and skips empty transcripts", () => {
    claudeSession(stateDir, "a", "/w", "one", "2026-11-01T10:00:00Z");
    claudeSession(stateDir, "b", "/w", "two", "2026-11-02T10:00:00Z");
    const emptyDir = join(stateDir, "projects", "empty");
    mkdirSync(emptyDir, { recursive: true });
    const empty = join(emptyDir, "z.jsonl");
    writeFileSync(empty, "");
    const when = new Date("2026-11-03T10:00:00Z");
    utimesSync(empty, when, when);
    const list = listHandoffCandidates({
      agent: "claude-code",
      sourceDir: stateDir,
      limit: 1,
    });
    expect(list.map((c) => c.id)).toEqual(["b"]);
  });

  it("latest prefers the newest session that ran in this folder", () => {
    claudeSession(stateDir, "here", "/work/here", "my task", "2026-11-01T10:00:00Z");
    claudeSession(stateDir, "elsewhere", "/work/other", "other", "2026-11-02T10:00:00Z");
    const picked = readHandoffTranscript({
      agent: "claude-code",
      sourceDir: stateDir,
      session: "latest",
      workingDir: "/work/here",
    });
    expect(picked.candidate.id).toBe("here");
    expect(picked.mapped.turns[0]).toMatchObject({ kind: "user", text: "my task" });
  });

  it("latest falls back to the newest session anywhere", () => {
    claudeSession(stateDir, "a", "/work/a", "x", "2026-11-01T10:00:00Z");
    claudeSession(stateDir, "b", "/work/b", "y", "2026-11-02T10:00:00Z");
    const picked = readHandoffTranscript({
      agent: "claude-code",
      sourceDir: stateDir,
      session: "latest",
      workingDir: "/nowhere",
    });
    expect(picked.candidate.id).toBe("b");
  });

  it("finds a session by unique id prefix and refuses an ambiguous one", () => {
    claudeSession(stateDir, "abc-111", "/w", "x", "2026-11-01T10:00:00Z");
    claudeSession(stateDir, "abc-222", "/w", "y", "2026-11-02T10:00:00Z");
    const read = (session: string) =>
      readHandoffTranscript({
        agent: "claude-code",
        sourceDir: stateDir,
        session,
        workingDir: "/w",
      });
    expect(read("abc-1").candidate.id).toBe("abc-111");
    expect(() => read("abc")).toThrow(HandoffNotFoundError);
    expect(() => read("zzz")).toThrow(/no Claude Code session matches/);
  });

  it("says so when there are no sessions at all", () => {
    expect(() =>
      readHandoffTranscript({
        agent: "codex",
        sourceDir: stateDir,
        session: "latest",
        workingDir: "/w",
      }),
    ).toThrow(/no Codex sessions found/);
  });

  it("reads a Codex rollout and titles it from the first user line", () => {
    const dir = join(stateDir, "sessions", "2026", "11", "02");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-2026-11-02-xyz.jsonl");
    writeFileSync(
      file,
      [
        line({ type: "session_meta", payload: { id: "xyz", cwd: "/work/codex" } }),
        line({
          timestamp: "2026-11-02T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "port the parser" }],
          },
        }),
      ].join(""),
    );
    const picked = readHandoffTranscript({
      agent: "codex",
      sourceDir: stateDir,
      session: "latest",
      workingDir: "/work/codex",
    });
    expect(picked.candidate).toMatchObject({
      agent: "codex",
      id: "2026-11-02-xyz",
      cwd: "/work/codex",
      title: "port the parser",
    });
  });
});

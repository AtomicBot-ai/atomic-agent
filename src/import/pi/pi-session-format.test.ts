import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPiFormatSessions,
  readPiFormatSession,
} from "./pi-session-format.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

const T0 = Date.parse("2026-08-02T10:00:00Z");
const OLD = new Date("2026-08-01T00:00:00Z");
const NEW = new Date("2026-08-03T00:00:00Z");

describe("listPiFormatSessions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-fmt-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns nothing when the sessions root is missing", () => {
    expect(listPiFormatSessions(join(root, "absent"))).toEqual([]);
  });

  it("lists cwd subdirs and top-level files, newest first", () => {
    const workDir = join(root, "--work--");
    mkdirSync(workDir, { recursive: true });
    const older = join(workDir, "2026-08-01T00-00-00-000Z_sess-a.jsonl");
    writeFileSync(older, "");
    utimesSync(older, OLD, OLD);
    const newer = join(root, "loose.jsonl");
    writeFileSync(newer, "");
    utimesSync(newer, NEW, NEW);
    // An Oh-My-Pi backup file does not end in `.jsonl` and is ignored.
    writeFileSync(join(workDir, "x.jsonl.123.bak"), "");

    const metas = listPiFormatSessions(root);
    expect(metas.map((m) => m.id)).toEqual(["loose", "sess-a"]);
    expect(metas[1]!.file).toBe(older);
  });

  it("takes the id after the first underscore of the filename", () => {
    const dir = join(root, "--home--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-08-02T10-00-00-000Z_sess_1.jsonl"), "");
    expect(listPiFormatSessions(root).map((m) => m.id)).toEqual(["sess_1"]);
  });
});

describe("readPiFormatSession", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-fmt-read-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(name: string, content: string): string {
    const file = join(root, name);
    writeFileSync(file, content);
    return file;
  }

  it("projects the header and the three conversation roles", () => {
    const file = writeSession(
      "t_sess-file.jsonl",
      [
        line({
          type: "session",
          version: 3,
          id: "sess-header",
          timestamp: "2026-08-02T10:00:00.000Z",
          cwd: "/work",
        }),
        line({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-02T10:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: T0 },
        }),
        line({
          type: "thinking_level_change",
          id: "e2",
          parentId: "e1",
          timestamp: "2026-08-02T10:00:02.000Z",
          thinkingLevel: "high",
        }),
        line({
          type: "message",
          id: "e3",
          parentId: "e2",
          timestamp: "2026-08-02T10:00:03.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "on it" },
              {
                type: "toolCall",
                id: "tc-1",
                name: "bash",
                arguments: { command: "ls" },
              },
            ],
            stopReason: "toolUse",
            timestamp: T0 + 1000,
          },
        }),
        line({
          type: "message",
          id: "e4",
          parentId: "e3",
          timestamp: "2026-08-02T10:00:04.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "bash",
            content: [{ type: "text", text: "README.md" }],
            isError: false,
            timestamp: T0 + 2000,
          },
        }),
        line({
          type: "message",
          id: "e5",
          parentId: "e4",
          timestamp: "2026-08-02T10:00:05.000Z",
          message: { role: "custom", content: "hook noise", timestamp: T0 },
        }),
        "not json at all\n",
      ].join(""),
    );

    const data = readPiFormatSession({ id: "sess-file", file, mtimeMs: T0 });
    expect(data.id).toBe("sess-header");
    expect(data.cwd).toBe("/work");
    expect(data.title).toBeNull();
    expect(data.messages).toEqual([
      { role: "user", blocks: [{ type: "text", text: "hello" }], atMs: T0 },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "on it" },
          {
            type: "toolCall",
            id: "tc-1",
            name: "bash",
            args: { command: "ls" },
          },
        ],
        atMs: T0 + 1000,
      },
      {
        role: "toolResult",
        blocks: [
          {
            type: "toolResult",
            toolCallId: "tc-1",
            toolName: "bash",
            text: "README.md",
            isError: false,
          },
        ],
        atMs: T0 + 2000,
      },
    ]);
  });

  it("falls back from message ms to the entry ISO stamp to the mtime", () => {
    const file = writeSession(
      "t_sess-ts.jsonl",
      [
        line({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-02T10:00:07.000Z",
          message: { role: "user", content: "no ms stamp" },
        }),
        line({
          type: "message",
          id: "e2",
          parentId: "e1",
          message: { role: "user", content: "no stamps at all" },
        }),
      ].join(""),
    );
    const data = readPiFormatSession({ id: "sess-ts", file, mtimeMs: T0 + 9.4 });
    expect(data.id).toBe("sess-ts");
    expect(data.messages.map((m) => m.atMs)).toEqual([
      Date.parse("2026-08-02T10:00:07.000Z"),
      Math.round(T0 + 9.4),
    ]);
  });

  it("keeps the last Oh-My-Pi title across slot and audit entries", () => {
    const file = writeSession(
      "t_sess-title.jsonl",
      [
        line({
          type: "title",
          v: 1,
          title: "First draft",
          source: "auto",
          updatedAt: "2026-08-02T10:00:00.000Z",
          pad: "",
        }),
        line({
          type: "session",
          version: 3,
          id: "sess-t",
          timestamp: "2026-08-02T10:00:00.000Z",
          cwd: "/work",
        }),
        line({
          type: "title_change",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-02T10:00:05.000Z",
          title: "Renamed by hand",
          previousTitle: "First draft",
          source: "user",
        }),
      ].join(""),
    );
    const data = readPiFormatSession({ id: "sess-t", file, mtimeMs: T0 });
    expect(data.title).toBe("Renamed by hand");
  });

  it("throws a loud error when the transcript cannot be read", () => {
    expect(() =>
      readPiFormatSession({
        id: "gone",
        file: join(root, "gone.jsonl"),
        mtimeMs: T0,
      }),
    ).toThrowError(/failed to read/);
  });
});

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEmptySessionState } from "../session/session-state.js";
import { handoffToCommand, parseHandoffToArgs, type HandoffToStore } from "./handoff-command.js";

function chat() {
  const state = createEmptySessionState({ id: "s-1", workingDir: "/work", metadata: { title: "Task" } });
  state.turns = [{ kind: "user", text: "Ship the fix", at: 1 }];
  return state;
}

function storeWith(state = chat()): HandoffToStore {
  return {
    load: (id: string) => (id === state.id ? state : null),
    listByWorkingDir: () => [state],
    listRecent: () => [state],
  } as unknown as HandoffToStore;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-to-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseHandoffToArgs (ATO-1158)", () => {
  it("needs a known target and refuses mixing with --from", () => {
    expect(parseHandoffToArgs(["--to"])).toHaveProperty("error");
    expect(parseHandoffToArgs(["--to", "hermes"])).toEqual({ error: "--to must be claude or codex, not hermes" });
    expect(parseHandoffToArgs(["--to", "codex", "--from", "codex"])).toHaveProperty("error");
    expect(parseHandoffToArgs(["--to", "claude", "--out", "x.md"])).toEqual({
      to: "claude",
      out: "x.md",
      session: "latest",
      cwd: null,
    });
  });
});

describe("handoffToCommand (ATO-1158)", () => {
  it("with --out writes only that file", async () => {
    const dir = tempDir();
    let printed = "";
    const code = await handoffToCommand(["--to", "claude", "--out", "x.md"], {
      store: storeWith(),
      cwd: dir,
      stdout: (text) => {
        printed += text;
      },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(readdirSync(dir)).toEqual(["x.md"]);
    expect(readFileSync(join(dir, "x.md"), "utf8")).toContain("> Ship the fix");
    expect(printed).toBe("");
  });

  it("without --out prints to stdout and writes no file", async () => {
    const dir = tempDir();
    let printed = "";
    const code = await handoffToCommand(["--to", "codex"], {
      store: storeWith(),
      cwd: dir,
      stdout: (text) => {
        printed += text;
      },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(printed).toContain("# Handoff: Task");
    expect(printed).toContain("Codex");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("exits 1 when there is no chat to hand off", async () => {
    const empty = {
      load: () => null,
      listByWorkingDir: () => [],
      listRecent: () => [],
    } as unknown as HandoffToStore;
    let err = "";
    const code = await handoffToCommand(["--to", "claude", "--session", "s-missing"], {
      store: empty,
      stdout: () => undefined,
      stderr: (text) => {
        err += text;
      },
    });
    expect(code).toBe(1);
    expect(err).toContain("s-missing");
  });
});

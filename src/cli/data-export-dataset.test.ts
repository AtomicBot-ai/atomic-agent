import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmptySessionState, SessionStore } from "../session/index.js";
import { dataCommand } from "./data-command.js";
import { exportDatasetCommand } from "./data-export-dataset.js";

const GITHUB = "ghp_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";

let root: string;
let state: string;
let out: string;
let printed: string;
const write = (t: string): void => { printed += t; };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "data-export-"));
  state = join(root, ".atomic-agent");
  mkdirSync(state);
  out = join(root, "chats.jsonl");
  printed = "";
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seed(): void {
  const store = new SessionStore({ dbFile: join(state, "sessions.sqlite") });
  try {
    store.save({
      ...createEmptySessionState({ id: "s-1", workingDir: "/w" }),
      turns: [
        { kind: "user", text: `push with ${GITHUB} from /home/nadya/repo`, at: 1 },
        { kind: "assistant_reply", text: "Pushed.", at: 2 },
      ],
    });
  } finally {
    store.close();
  }
}

describe("atag data export-dataset (ATO-1104)", () => {
  it("writes the chats, scrubbed, and says what it replaced and that nothing was uploaded", async () => {
    seed();
    expect(await dataCommand(["export-dataset", "--out", out], { stateDir: state, write })).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8").trim())).toEqual({
      messages: [
        { role: "user", content: "push with [redacted:github-token] from ~/repo" },
        { role: "assistant", content: "Pushed." },
      ],
    });
    expect(printed).toContain("exported 1 chats (2 messages)");
    expect(printed).toContain("replaced 2 items: 1 keys or tokens, 0 emails, 1 home folder paths");
    expect(printed).toContain("nothing was uploaded");
  });

  it("needs --out, refuses an existing file and bad flags", () => {
    seed();
    const run = (args: string[]) => exportDatasetCommand(args, { stateDir: state, write, homeDir: "/h", known: [] });
    expect(run([])).toBe(2);
    expect(run(["--out", out, "--sessions", "0"])).toBe(2);
    expect(run(["--out", out, "--since", "not a date"])).toBe(2);
    expect(existsSync(out)).toBe(false);
    expect(run([`--out=${out}`, "--sessions=1", "--since=2020-01-01"])).toBe(0);
    expect(run(["--out", out])).toBe(2);
    expect(printed).toContain("already exists");
  });

  it("says so when there are no chats yet, without creating a database", () => {
    expect(exportDatasetCommand(["--out", out], { stateDir: state, write, homeDir: "/h", known: [] })).toBe(1);
    expect(printed).toContain("no chats to export yet");
    expect(existsSync(join(state, "sessions.sqlite"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("is listed in the data help", async () => {
    await dataCommand(["--help"], { stateDir: state, write });
    expect(printed).toContain("export-dataset --out <file.jsonl>");
  });
});

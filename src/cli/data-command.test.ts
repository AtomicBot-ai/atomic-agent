import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../native/load-better-sqlite3.js";
import { dataCommand } from "./data-command.js";

let root: string;
let state: string;
let out: string;
const write = (t: string): void => { out += t; };
const run = (args: string[]) => dataCommand(args, { stateDir: state, write, now: () => new Date("2026-10-27T10:00:00Z") });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "data-cmd-"));
  state = join(root, ".atomic-agent");
  mkdirSync(join(state, "models"), { recursive: true });
  mkdirSync(join(state, "browser-profile"));
  mkdirSync(join(state, "skills", "a"), { recursive: true });
  writeFileSync(join(state, "config.json"), '{"version":1}\n', { mode: 0o600 });
  writeFileSync(join(state, "models", "big.gguf"), "weights");
  writeFileSync(join(state, "browser-profile", "Cookies"), "secret");
  writeFileSync(join(state, "skills", "a", "SKILL.md"), "# a");
  const db = new Database(join(state, "sessions.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec("create table t(x); insert into t values (42)");
  db.close();
  out = "";
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("atag data (ATO-579)", () => {
  it("backup leaves out models and the browser profile; restore brings the rest back and keeps the models here", async () => {
    const archive = join(root, "b.tar.gz");
    expect(await run(["backup", archive])).toBe(0);
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    writeFileSync(join(state, "config.json"), '{"version":2}\n');

    expect(await run(["restore", archive])).toBe(2);
    expect(await run(["restore", archive, "--yes"])).toBe(0);
    expect(readFileSync(join(state, "config.json"), "utf8")).toBe('{"version":1}\n');
    expect(readFileSync(join(state, "skills", "a", "SKILL.md"), "utf8")).toBe("# a");
    expect(readFileSync(join(state, "models", "big.gguf"), "utf8")).toBe("weights");
    expect(existsSync(join(state, "browser-profile"))).toBe(false);
    const db = new Database(join(state, "sessions.sqlite"), { readonly: true });
    expect(db.prepare("select x from t").get()).toEqual({ x: 42 });
    db.close();
    expect(readdirSync(root).some((n) => n.startsWith(".atomic-agent.before-restore-"))).toBe(true);
  });

  it("a file that is not a backup is refused and nothing changes", async () => {
    const bogus = join(root, "x.tar.gz");
    writeFileSync(bogus, "not gzip");
    expect(await run(["restore", bogus, "--yes"])).toBe(1);
    expect(readFileSync(join(state, "config.json"), "utf8")).toBe('{"version":1}\n');
    expect(readdirSync(root).filter((n) => n.includes(".restore-"))).toEqual([]);
  });

  it("move puts the folder elsewhere and leaves a link at the old path", async () => {
    const target = join(root, "disk2", "atomic");
    expect(await run(["move", target])).toBe(0);
    expect(lstatSync(state).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(state, "config.json"), "utf8")).toBe('{"version":1}\n');
    expect(readFileSync(join(target, "config.json"), "utf8")).toBe('{"version":1}\n');
  });

  it("move refuses a folder that is not empty", async () => {
    mkdirSync(join(root, "full"));
    writeFileSync(join(root, "full", "f"), "x");
    expect(await run(["move", join(root, "full")])).toBe(2);
  });

  it("reset keeps the models and moves everything else aside", async () => {
    expect(await run(["reset", "--yes"])).toBe(2);
    expect(await run(["reset", "--keep-models"])).toBe(2);
    expect(await run(["reset", "--keep-models", "--yes"])).toBe(0);
    expect(readdirSync(state)).toEqual(["models"]);
    const aside = readdirSync(root).find((n) => n.startsWith(".atomic-agent.reset-"))!;
    expect(existsSync(join(root, aside, "config.json"))).toBe(true);
  });
});

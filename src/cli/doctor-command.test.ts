import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../config/index.js";
import { doctorCommand } from "./doctor-command.js";

let dir: string;
let out: string;
const write = (t: string): void => { out += t; };
const cfgPath = (): string => join(dir, "config.json");
const save = (tree: unknown): void => { writeFileSync(cfgPath(), JSON.stringify(tree, null, 2)); chmodSync(cfgPath(), 0o600); };
const read = (): Record<string, any> => JSON.parse(readFileSync(cfgPath(), "utf8"));
const run = (args: string[], findOnPath = (_: string) => true) =>
  doctorCommand(args, { stateDir: dir, write, context: { findOnPath } });

function withBrokenActiveProvider(): Record<string, any> {
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
  tree.llm = {
    ...tree.llm,
    activeTextProvider: "gone",
    providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" }],
  };
  return tree;
}

function withMcp(command: string): Record<string, any> {
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
  tree.mcp = { servers: [{ name: "files", enabled: true, transport: { kind: "stdio", command } }] };
  return tree;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-")); out = ""; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("atag doctor (ATO-577)", () => {
  it("a valid config is ok and exits 0", async () => {
    save(USER_CONFIG_DEFAULTS);
    expect(await run([])).toBe(0);
    expect(out).toMatch(/ok {2}config: .* is valid/);
  });

  it("broken JSON fails with no fix and is left alone", async () => {
    writeFileSync(cfgPath(), "{ not json");
    expect(await run(["--fix"])).toBe(1);
    expect(out).toMatch(/FAIL {2}config: .*not valid JSON/);
    expect(readFileSync(cfgPath(), "utf8")).toBe("{ not json");
  });

  it("an unknown active provider is offered a fix, which --fix applies with a backup that --undo restores", async () => {
    save(withBrokenActiveProvider());
    expect(await run([])).toBe(1);
    expect(out).toContain('set llm.activeTextProvider to "local-llama"');
    expect(read().llm.activeTextProvider).toBe("gone");

    out = "";
    expect(await run(["--fix"])).toBe(0);
    expect(read().llm.activeTextProvider).toBe("local-llama");
    expect(out).toMatch(/backed up config.json to .*doctor-backups/);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);

    out = "";
    expect(await run(["--undo"])).toBe(0);
    expect(read().llm.activeTextProvider).toBe("gone");
    expect(await run(["--undo"])).toBe(1);
  });

  it("an enabled MCP server whose command is missing is turned off by --fix", async () => {
    save(withMcp("definitely-not-installed-cmd"));
    expect(await run([], () => false)).toBe(0);
    expect(out).toMatch(/warn {2}mcp: files: command "definitely-not-installed-cmd" is not installed/);
    await run(["--fix"], () => false);
    expect(read().mcp.servers[0].enabled).toBe(false);
  });

  it("an installed MCP command is ok and nothing is written", async () => {
    save(withMcp("npx"));
    const before = readFileSync(cfgPath(), "utf8");
    await run(["--fix"], (c) => c === "npx");
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
    expect(out).toContain("mcp: files: npx found");
  });

  it.skipIf(process.platform === "win32")("a config readable by others is chmod 600 by --fix", async () => {
    save(USER_CONFIG_DEFAULTS);
    chmodSync(cfgPath(), 0o644);
    await run([]);
    expect(out).toMatch(/warn {2}config-mode: config.json is mode 644/);
    await run(["--fix"]);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
  });

  it("an unknown option is a usage error", async () => {
    expect(await run(["--fxi"])).toBe(2);
  });
});

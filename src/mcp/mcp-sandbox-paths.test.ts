import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildOsSandboxPolicy } from "../sandbox/os-sandbox.js";
import { mcpServerKeepReadable } from "./mcp-sandbox-paths.js";

// ATO-620 review, round 2: an absolute argument reopens only that exact
// file, never its folder, and never anything in a secret folder.
describe.skipIf(process.platform === "win32")("mcpServerKeepReadable", () => {
  let home: string;
  let state: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "atomic-mcp-keep-")));
    state = join(home, ".atomic-agent");
    mkdirSync(join(state, "plugins", "installed", "p", "lib"), { recursive: true });
    mkdirSync(join(home, ".ssh"));
    mkdirSync(join(home, "project"));
    writeFileSync(join(state, ".env"), "KEY=x\n");
    writeFileSync(join(state, "config.json"), "{}\n");
    writeFileSync(join(home, ".ssh", "known_hosts"), "host key\n");
    writeFileSync(join(home, "project", "conf.json"), "{}\n");
    writeFileSync(join(state, "plugins", "installed", "p", "server.js"), "");
    writeFileSync(join(state, "plugins", "installed", "p", "lib", "a.js"), "");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const keepFor = (args: string[], command = "node") =>
    mcpServerKeepReadable({ command, args, stateDir: state, home });

  const policyFor = (keepReadable: string[]) =>
    buildOsSandboxPolicy({
      workspaceRoots: [join(home, "project")],
      stateDir: state,
      keepReadable,
      network: true,
      home,
      tmp: join(home, "tmp"),
    });

  it("an argument in the state dir does not reopen the state dir", () => {
    const keep = keepFor(["--config", join(state, "config.json")]);
    expect(keep).toEqual([]);
    const p = policyFor(keep);
    expect(p.denyRead).toContain(state);
    expect(p.reopen).toEqual([]);
  });

  it("an argument in ~/.ssh does not reopen ~/.ssh", () => {
    const keep = keepFor([join(home, ".ssh", "known_hosts")]);
    expect(keep).toEqual([]);
    const p = policyFor(keep);
    expect(p.denyRead).toContain(join(home, ".ssh"));
    expect(p.reopen).toEqual([]);
  });

  it("an ordinary file argument is kept by its exact path, not its folder", () => {
    expect(keepFor([join(home, "project", "conf.json")])).toEqual([
      join(home, "project", "conf.json"),
    ]);
  });

  it("a plugin script opens its own plugin folder, and only that", () => {
    const plugin = join(state, "plugins", "installed", "p");
    expect(keepFor([join(plugin, "server.js")])).toEqual([plugin]);
    expect(keepFor([], join(plugin, "lib", "a.js"))).toEqual([plugin]);
    const p = policyFor([plugin]);
    expect(p.denyRead).toContain(state);
    expect(p.reopen).toEqual([{ path: plugin, write: false }]);
  });

  it("an absolute command keeps its own folder", () => {
    const cmd = join(home, "project", "conf.json");
    expect(keepFor([], cmd)).toEqual([dirname(cmd)]);
  });

  it("a command right in the state dir does not reopen the state dir", () => {
    expect(keepFor([], join(state, "config.json"))).toEqual([]);
  });
});

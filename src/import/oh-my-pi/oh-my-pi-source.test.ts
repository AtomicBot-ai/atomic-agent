import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OhMyPiSource } from "./oh-my-pi-source.js";

const SKILL_MD = "---\nname: sample\ndescription: A sample skill\n---\n";

describe("OhMyPiSource", () => {
  let sourceDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "omp-src-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  function seedSkill(...segments: string[]): void {
    const dir = join(sourceDir, "skills", ...segments);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
  }

  it("discovers skills one level only — Oh-My-Pi's own contract", () => {
    seedSkill("triage");
    seedSkill("group", "nested");
    const skills = new OhMyPiSource(sourceDir).listSkills();
    expect(skills.map((s) => s.name)).toEqual(["triage"]);
  });

  it("reads mcpServers with the config's enabled verdicts", () => {
    writeFileSync(
      join(sourceDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "server-filesystem"] },
          paused: { command: "npx", enabled: false },
          remote: { type: "http", url: "https://mcp.example.com/x" },
        },
        disabledServers: ["remote"],
      }),
    );
    const servers = new OhMyPiSource(sourceDir).readMcpServers();
    expect(
      servers.map((s) => ({ name: s.name, disabled: s.disabled })),
    ).toEqual([
      { name: "files", disabled: false },
      { name: "paused", disabled: true },
      { name: "remote", disabled: true },
    ]);
  });

  it("lets enabledServers force a server back on, like Oh-My-Pi does", () => {
    writeFileSync(
      join(sourceDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          revived: { command: "npx", enabled: false },
          paused: { command: "npx", enabled: false },
          untouched: { command: "npx" },
        },
        enabledServers: ["revived"],
      }),
    );
    const servers = new OhMyPiSource(sourceDir).readMcpServers();
    expect(
      servers.map((s) => ({ name: s.name, disabled: s.disabled })),
    ).toEqual([
      { name: "revived", disabled: false },
      { name: "paused", disabled: true },
      // The list force-enables; it is not an allowlist that turns
      // everything absent from it off.
      { name: "untouched", disabled: false },
    ]);
  });

  it("returns empty when mcp.json is missing and throws on corrupt JSON", () => {
    const source = new OhMyPiSource(sourceDir);
    expect(source.readMcpServers()).toEqual([]);
    writeFileSync(join(sourceDir, "mcp.json"), "{ not json");
    expect(() => source.readMcpServers()).toThrowError(/failed to parse/);
  });
});

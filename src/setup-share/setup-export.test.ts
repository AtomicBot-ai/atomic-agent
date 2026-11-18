import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportSetup } from "./setup-export.js";
import { makeStateDir, readTar, SECRET } from "./setup-share-test-helpers.js";

describe("exportSetup", () => {
  let root: string;
  let stateDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "setup-export-"));
    stateDir = join(root, "state");
    makeStateDir(stateDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const starterSkills = new Set(["skill-creator"]);

  it("exports only the allow-listed setup, never chats, memory, logs, keys or stray files", async () => {
    const out = join(root, "setup.tar.gz");
    const { manifest } = await exportSetup({ stateDir, outFile: out, starterSkills, now: new Date(0) });
    const entries = await readTar(out);
    expect([...entries.keys()].sort()).toEqual([
      "atomic-agent-setup/agents/reviewer.md",
      "atomic-agent-setup/config.json",
      "atomic-agent-setup/manifest.json",
      "atomic-agent-setup/skills/triage/SKILL.md",
      "atomic-agent-setup/skills/triage/scripts/run.sh",
    ]);
    expect(manifest.contents).toEqual({
      skills: ["triage"],
      agents: ["reviewer"],
      mcpServers: ["github", "remote"],
      providers: ["groq"],
      personas: ["pirate"],
      memory: false,
    });
    expect(manifest.leftOut).toEqual(expect.arrayContaining([expect.stringContaining("skills/triage/.env")]));
    expect(manifest.files.map((f) => f.path)).toContain("skills/triage/SKILL.md");
  });

  it("puts no secret anywhere in the bundle and lists what it blanked", async () => {
    const out = join(root, "setup.tar.gz");
    const { manifest } = await exportSetup({ stateDir, outFile: out, starterSkills });
    const all = [...(await readTar(out)).values()].join("\n");
    for (const secret of [SECRET, "ghp_abcdefghijklmnopqrstuvwxyz0123", "hunter2", "telegram-secret", "user:pw@", "api_key=abc", "/Users/me/secret-project"]) {
      expect(all).not.toContain(secret);
    }
    expect(manifest.redacted).toEqual(expect.arrayContaining([
      "mcp.servers[github].env.GITHUB_TOKEN",
      "mcp.servers[remote].transport.headers.Authorization",
      "llm.providers[groq].apiKey",
    ]));
  });

  it("adds memory only when asked", async () => {
    const out = join(root, "with-memory.tar.gz");
    const { manifest } = await exportSetup({ stateDir, outFile: out, starterSkills, includeMemory: true });
    const entries = await readTar(out);
    expect(entries.get("atomic-agent-setup/memory.sqlite")).toBe("memory-bytes");
    expect(manifest.contents.memory).toBe(true);
    expect(entries.has("atomic-agent-setup/sessions.sqlite")).toBe(false);
  });

  it("refuses to write the bundle inside the data folder", async () => {
    await expect(exportSetup({ stateDir, outFile: join(stateDir, "x.tar.gz"), starterSkills })).rejects.toThrow(/outside the data folder/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectImportAgents,
  importAgentDir,
} from "./detect-import-agents.js";

describe("detectImportAgents", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "detect-agents-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("detects nothing on a clean machine", () => {
    expect(detectImportAgents({ home, env: {} })).toEqual([]);
  });

  it("ignores a bare state dir with no importable artefact", () => {
    mkdirSync(join(home, ".hermes"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(detectImportAgents({ home, env: {} })).toEqual([]);
  });

  it("detects each agent from its own artefact, in pick order", () => {
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "state.db"), "");
    mkdirSync(join(home, ".openclaw", "agents"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");

    const detected = detectImportAgents({ home, env: {} });
    expect(detected.map((d) => d.id)).toEqual([
      "hermes",
      "openclaw",
      "claude-code",
      "codex",
    ]);
    expect(detected.map((d) => d.label)).toEqual([
      "Hermes",
      "OpenClaw",
      "Claude Code",
      "Codex",
    ]);
    expect(detected[0]!.dir).toBe(join(home, ".hermes"));
  });

  it("honours the *_STATE_DIR env overrides", () => {
    const custom = join(home, "elsewhere");
    mkdirSync(join(custom, "projects"), { recursive: true });
    const detected = detectImportAgents({
      home,
      env: { CLAUDE_CODE_STATE_DIR: custom },
    });
    expect(detected).toEqual([
      { id: "claude-code", label: "Claude Code", dir: custom },
    ]);
  });

  it("resolves default dirs off the injected home", () => {
    expect(importAgentDir("codex", { home, env: {} })).toBe(
      join(home, ".codex"),
    );
    expect(importAgentDir("codex", { home, env: { CODEX_STATE_DIR: "/x" } })).toBe(
      "/x",
    );
  });
});

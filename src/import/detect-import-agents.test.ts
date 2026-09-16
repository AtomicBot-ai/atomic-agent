import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectImportAgents, importAgentDir } from "./detect-import-agents.js";

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
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    expect(detectImportAgents({ home, env: {} })).toEqual([]);
  });

  it("detects each agent from its own artefact, in pick order", () => {
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "state.db"), "");
    mkdirSync(join(home, ".openclaw", "agents"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "mcp.json"), "{}");

    const detected = detectImportAgents({ home, env: {} });
    expect(detected.map((d) => d.id)).toEqual([
      "hermes",
      "openclaw",
      "claude-code",
      "codex",
      "pi",
      "oh-my-pi",
    ]);
    expect(detected.map((d) => d.label)).toEqual([
      "Hermes",
      "OpenClaw",
      "Claude Code",
      "Codex",
      "Pi",
      "Oh-My-Pi",
    ]);
    expect(detected[0]!.dir).toBe(join(home, ".hermes"));
    expect(detected[4]!.dir).toBe(join(home, ".pi", "agent"));
    expect(detected[5]!.dir).toBe(join(home, ".omp", "agent"));
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

    const piCustom = join(home, "pi-elsewhere");
    mkdirSync(join(piCustom, "sessions"), { recursive: true });
    expect(detectImportAgents({ home, env: { PI_STATE_DIR: piCustom } })).toEqual(
      [{ id: "pi", label: "Pi", dir: piCustom }],
    );
  });

  it("resolves default dirs off the injected home", () => {
    expect(importAgentDir("codex", { home, env: {} })).toBe(
      join(home, ".codex"),
    );
    expect(
      importAgentDir("codex", { home, env: { CODEX_STATE_DIR: "/x" } }),
    ).toBe("/x");
    expect(importAgentDir("pi", { home, env: {} })).toBe(
      join(home, ".pi", "agent"),
    );
    expect(importAgentDir("oh-my-pi", { home, env: {} })).toBe(
      join(home, ".omp", "agent"),
    );
    expect(
      importAgentDir("oh-my-pi", { home, env: { OMP_STATE_DIR: "/y" } }),
    ).toBe("/y");
  });
});

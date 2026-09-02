import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/index.js";
import { MemoryStore } from "../memory/memory-store.js";

import { memoryCommand } from "./memory-command.js";

describe("memoryCommand", () => {
  let stateDir: string;
  let vaultDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let savedVaultEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-memory-cli-"));
    vaultDir = join(stateDir, "vault");
    mkdirSync(vaultDir);
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    savedVaultEnv = process.env.OBSIDIAN_VAULT_PATH;
    delete process.env.OBSIDIAN_VAULT_PATH;
    resetConfigCache();
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    if (savedVaultEnv === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = savedVaultEnv;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  function stdout(): string {
    return stdoutChunks.join("");
  }

  function stderr(): string {
    return stderrChunks.join("");
  }

  function seedMemory(): void {
    const store = new MemoryStore({
      dbFile: join(stateDir, "memory.sqlite"),
      maxEntries: 100,
    });
    try {
      store.store({ content: "remember the milk", tags: ["errand"] });
    } finally {
      store.close();
    }
  }

  it("prints help when no subcommand is passed", async () => {
    const code = await memoryCommand([]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/atomic-agent memory/);
    expect(stdout()).toMatch(/export \[--vault/);
  });

  it("rejects an unknown subcommand with a usage error", async () => {
    const code = await memoryCommand(["nope"]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/unknown subcommand: nope/);
  });

  it("requires a vault path from --vault or OBSIDIAN_VAULT_PATH", async () => {
    const code = await memoryCommand(["export"]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--vault <path>/);
  });

  it("exports the state-dir corpus into the vault passed via --vault", async () => {
    seedMemory();
    const code = await memoryCommand(["export", "--vault", vaultDir]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/exported 1 notes, 0 lessons, 0 procedures -> /);
    expect(
      existsSync(join(vaultDir, "atomic-agent", "notes", "note-1.md")),
    ).toBe(true);
  });

  it("falls back to OBSIDIAN_VAULT_PATH and honors --folder", async () => {
    seedMemory();
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;
    const code = await memoryCommand(["export", "--folder", "brain"]);
    expect(code).toBe(0);
    expect(existsSync(join(vaultDir, "brain", "notes", "note-1.md"))).toBe(true);
  });

  it("maps a folder escaping the vault to a usage error", async () => {
    seedMemory();
    const code = await memoryCommand([
      "export",
      "--vault",
      vaultDir,
      "--folder",
      "..",
    ]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--folder must name a subfolder/);
  });

  it("reports a missing memory database as an operational failure", async () => {
    const code = await memoryCommand(["export", "--vault", vaultDir]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/memory export failed: no memory database/);
  });
});

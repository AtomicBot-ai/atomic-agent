import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/index.js";
import { MemoryStore } from "../memory/memory-store.js";
import {
  EmbeddingUnavailableError,
  type EmbeddingClient,
} from "../memory/embeddings/embedding-client.js";
import { EmbeddingStore } from "../memory/embeddings/embedding-store.js";
import type { MemoryEmbeddingConnection } from "../memory/embeddings/memory-embedding-connection.js";

import { handleReindex, memoryCommand } from "./memory-command.js";

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
    expect(existsSync(join(vaultDir, "brain", "notes", "note-1.md"))).toBe(
      true,
    );
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
  describe("reindex", () => {
    const dbFile = () => join(stateDir, "memory.sqlite");
    function seedNotes(...contents: string[]): number[] {
      const store = new MemoryStore({ dbFile: dbFile(), maxEntries: 100 });
      try {
        return contents.map((content) => store.store({ content }).id);
      } finally {
        store.close();
      }
    }
    function withVectors<T>(fn: (vectors: EmbeddingStore) => T): T {
      const store = new MemoryStore({ dbFile: dbFile(), maxEntries: 100 });
      try {
        return fn(new EmbeddingStore({ db: store.getDatabaseHandleForEmbeddings() }));
      } finally {
        store.close();
      }
    }
    function fakeClient(model: string, embed?: EmbeddingClient["embed"]): EmbeddingClient {
      return {
        dim: 2,
        model,
        embed: embed ?? (async () => ({ vector: new Float32Array([1, 0]), model })),
      };
    }
    const reachable = (client: EmbeddingClient) => async (): Promise<MemoryEmbeddingConnection> => ({
      state: "reachable",
      modelId: client.model,
      createClient: () => client,
    });
    const noSignal = { onInterrupt: () => () => {} };

    it("exits 1 with a hint when embeddings are off", async () => {
      const code = await memoryCommand(["reindex"]);
      expect(code).toBe(1);
      expect(stderr()).toMatch(/memory embeddings are off/);
    });

    it("exits 1 and says how to start the model when it does not answer", async () => {
      const code = await handleReindex([], {
        ...noSignal,
        connect: async () => ({ state: "unreachable", modelId: "m", why: "embedding daemon at http://127.0.0.1:1 is unreachable" }),
      });
      expect(code).toBe(1);
      expect(stderr()).toMatch(/is unreachable; start it with: atomic-agent models start-embedding/);
    });

    it("embeds the notes missing a vector and exits 0", async () => {
      seedNotes("first", "second");
      const code = await handleReindex([], { ...noSignal, connect: reachable(fakeClient("fake")) });
      expect(code).toBe(0);
      expect(stdout()).toMatch(/embedded 2 notes with fake; 0 left without a vector/);
      expect(withVectors((v) => v.countByModel("fake"))).toBe(2);
    });

    it("prints the result as JSON with --json", async () => {
      seedNotes("first");
      const code = await handleReindex(["--json"], { ...noSignal, connect: reachable(fakeClient("fake")) });
      expect(code).toBe(0);
      expect(JSON.parse(stdout())).toEqual({ model: "fake", embedded: 1, skipped: 0, remaining: 0 });
    });

    it("exits 1 when the model stops answering mid-run, keeping what was done", async () => {
      seedNotes("first", "second");
      let calls = 0;
      const client = fakeClient("fake", async () => {
        calls += 1;
        if (calls > 1) throw new EmbeddingUnavailableError("down");
        return { vector: new Float32Array([1, 0]), model: "fake" };
      });
      const code = await handleReindex([], { ...noSignal, connect: reachable(client) });
      expect(code).toBe(1);
      expect(stdout()).toMatch(/embedded 1 notes with fake; 1 left without a vector/);
      expect(stderr()).toMatch(/atomic-agent models start-embedding/);
    });

    it("exits 130 when interrupted", async () => {
      seedNotes("first", "second");
      let abort: () => void = () => {};
      const client = fakeClient("fake", async () => {
        abort();
        return { vector: new Float32Array([1, 0]), model: "fake" };
      });
      const code = await handleReindex([], {
        connect: reachable(client),
        onInterrupt: (fn) => { abort = fn; return () => {}; },
      });
      expect(code).toBe(130);
      expect(stderr()).toMatch(/interrupted/);
    });

    it("keeps other models' vectors unless --prune, and prunes them once the new model covers every note", async () => {
      const [id] = seedNotes("first");
      withVectors((v) => v.upsert({ memoryId: id!, model: "old", dim: 2, vector: new Float32Array([0, 1]), createdAt: 1 }));
      expect(await handleReindex([], { ...noSignal, connect: reachable(fakeClient("fake")) })).toBe(0);
      expect(withVectors((v) => v.countByModel("old"))).toBe(1);
      stdoutChunks.length = 0;
      expect(await handleReindex(["--prune", "--json"], { ...noSignal, connect: reachable(fakeClient("fake")) })).toBe(0);
      expect(JSON.parse(stdout())).toMatchObject({ embedded: 0, remaining: 0, pruned: [{ model: "old", deleted: 1 }] });
      expect(withVectors((v) => v.countPerModel())).toEqual([{ model: "fake", count: 1 }]);
    });

    it("does not prune while notes still lack a vector for the current model", async () => {
      const [id] = seedNotes("first", "second");
      withVectors((v) => v.upsert({ memoryId: id!, model: "old", dim: 2, vector: new Float32Array([0, 1]), createdAt: 1 }));
      const client = fakeClient("fake", async () => { throw new EmbeddingUnavailableError("down"); });
      expect(await handleReindex(["--prune"], { ...noSignal, connect: reachable(client) })).toBe(1);
      expect(withVectors((v) => v.countByModel("old"))).toBe(1);
      expect(stdout()).toMatch(/nothing pruned/);
    });

    it("rejects an unknown option", async () => {
      expect(await handleReindex(["--all"], noSignal)).toBe(2);
      expect(stderr()).toMatch(/unknown option: --all/);
    });
  });
});

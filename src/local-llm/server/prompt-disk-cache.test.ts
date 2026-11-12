import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePromptCacheDir } from "../backend-paths.js";
import {
  evictPromptCache,
  PROMPT_CACHE_MIN_TOKENS,
  promptCacheFingerprint,
  promptCacheLaunchArgs,
  restorePromptCaches,
  savePromptCaches,
} from "./prompt-disk-cache.js";

const ARGS = [
  "--no-webui", "-m", "/models/q.gguf", "--port", "19091", "--flash-attn", "auto",
  "--cache-type-k", "turbo3", "--cache-type-v", "turbo3", "--parallel", "2", "-kvu",
  "--ctx-size", "65536",
];
const FILE = { size: 17_900_000_000, mtimeMs: 1_700_000_000_000 };
const fp = (args: readonly string[] = ARGS, engineBuild = "atomic-core|b1|cuda", modelFile = FILE) =>
  promptCacheFingerprint({ args, engineBuild, modelFile });

describe("promptCacheFingerprint (ATO-456)", () => {
  const swap = (flag: string, value: string) => {
    const args = [...ARGS];
    args[args.indexOf(flag) + 1] = value;
    return args;
  };

  it("changes with the model, the engine build and every flag that shapes the cache", () => {
    const base = fp();
    expect(fp(swap("--ctx-size", "131072"))).not.toBe(base);
    expect(fp(swap("--cache-type-k", "q8_0"))).not.toBe(base);
    expect(fp(swap("--cache-type-v", "q8_0"))).not.toBe(base);
    expect(fp(swap("--flash-attn", "on"))).not.toBe(base);
    expect(fp(swap("--parallel", "4"))).not.toBe(base);
    expect(fp(swap("-m", "/models/other.gguf"))).not.toBe(base);
    expect(fp([...ARGS, "--swa-full"])).not.toBe(base);
    expect(fp(ARGS.filter((a) => a !== "-kvu"))).not.toBe(base);
    expect(fp(ARGS, "atomic-core|b2|cuda")).not.toBe(base);
    expect(fp(ARGS, undefined, { ...FILE, mtimeMs: FILE.mtimeMs + 5_000 })).not.toBe(base);
  });

  it("ignores what a saved cache does not depend on: port and the save path", () => {
    expect(fp(swap("--port", "19092"))).toBe(fp());
    expect(fp([...ARGS, "--slot-save-path", "/tmp/x"])).toBe(fp());
  });
});

describe("saving and restoring the slots' caches (ATO-456)", () => {
  let dataDir: string;
  let dir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "prompt-cache-"));
    expect(promptCacheLaunchArgs(dataDir)).toEqual(["--slot-save-path", resolvePromptCacheDir(dataDir)]);
    dir = resolvePromptCacheDir(dataDir);
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  /** A llama-server stand-in: `/slots`, and slot save/restore that touch real files. */
  function fakeServer(opts: {
    slots?: { id: number; is_processing: boolean }[];
    savedTokens?: Record<number, number>;
    refuseRestore?: boolean;
  }) {
    const calls: { slot: number; action: string; filename: string }[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
      if (url.pathname === "/slots") return new Response(JSON.stringify(opts.slots ?? []), { status: 200 });
      const slot = Number(url.pathname.split("/")[2]);
      const action = url.searchParams.get("action") ?? "";
      const filename = (JSON.parse(String(init?.body)) as { filename: string }).filename;
      calls.push({ slot, action, filename });
      if (action === "save") {
        writeFileSync(join(dir, filename), "state");
        return new Response(JSON.stringify({ id_slot: slot, filename, n_saved: opts.savedTokens?.[slot] ?? 0 }));
      }
      if (opts.refuseRestore) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ id_slot: slot, filename, n_restored: 1_000 }));
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  const writeSave = (name: string, fingerprint: string, savedAt: number, tokens = 5_000) => {
    writeFileSync(join(dir, name), "state");
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ fingerprint, tokens, savedAt }));
  };

  it("saves idle slots, keeps only the long ones, and stamps each with the fingerprint", async () => {
    const server = fakeServer({
      slots: [{ id: 0, is_processing: false }, { id: 1, is_processing: true }, { id: 2, is_processing: false }],
      savedTokens: { 0: 40_000, 2: PROMPT_CACHE_MIN_TOKENS - 1 },
    });
    const kept = await savePromptCaches({ dataDir, port: 19091, apiKey: "k", fingerprint: "fp", fetchImpl: server.fetchImpl, now: () => 1_000 });
    expect(kept).toBe(1);
    expect(server.calls.map((c) => c.slot)).toEqual([0, 2]);
    const [first, second] = server.calls;
    expect(JSON.parse(readFileSync(join(dir, `${first!.filename}.json`), "utf8"))).toEqual({ fingerprint: "fp", tokens: 40_000, savedAt: 1_000 });
    expect(existsSync(join(dir, second!.filename))).toBe(false);
  });

  it("does nothing when the server does not answer /slots", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    expect(await savePromptCaches({ dataDir, port: 1, apiKey: "k", fingerprint: "fp", fetchImpl })).toBe(0);
  });

  it("restores the newest matching saves into the low slots and deletes other launches' files", async () => {
    writeSave("slot-1-0.bin", "fp", 1);
    writeSave("slot-2-0.bin", "fp", 2);
    writeSave("slot-3-0.bin", "fp", 3);
    writeSave("slot-9-0.bin", "other", 9);
    const server = fakeServer({});
    const restored = await restorePromptCaches({ dataDir, port: 19091, apiKey: "k", fingerprint: "fp", slots: 3, fetchImpl: server.fetchImpl });
    expect(restored).toBe(2);
    // Two of three slots: the highest is left to the reflection side calls.
    expect(server.calls).toEqual([
      { slot: 0, action: "restore", filename: "slot-3-0.bin" },
      { slot: 1, action: "restore", filename: "slot-2-0.bin" },
    ]);
    expect(existsSync(join(dir, "slot-9-0.bin"))).toBe(false);
    expect(existsSync(join(dir, "slot-3-0.bin"))).toBe(false);
    // The oldest save was not loaded and stays, within the cap.
    expect(existsSync(join(dir, "slot-1-0.bin"))).toBe(true);
  });

  it("a one-slot launch restores into slot 0, and a refused file is dropped", async () => {
    writeSave("slot-5-0.bin", "fp", 5);
    const server = fakeServer({ refuseRestore: true });
    expect(await restorePromptCaches({ dataDir, port: 19091, apiKey: "k", fingerprint: "fp", slots: 1, fetchImpl: server.fetchImpl })).toBe(0);
    expect(server.calls).toEqual([{ slot: 0, action: "restore", filename: "slot-5-0.bin" }]);
    expect(existsSync(join(dir, "slot-5-0.bin"))).toBe(false);
  });

  it("eviction drops a state file with no fingerprint, then the oldest saves past the cap", () => {
    writeFileSync(join(dir, "slot-0-0.bin"), "cut short");
    writeSave("slot-1-0.bin", "fp", 1);
    writeSave("slot-2-0.bin", "fp", 2);
    const one = readFileSync(join(dir, "slot-2-0.bin")).length + readFileSync(join(dir, "slot-2-0.bin.json")).length;
    evictPromptCache(dataDir, one);
    expect(existsSync(join(dir, "slot-0-0.bin"))).toBe(false);
    expect(existsSync(join(dir, "slot-1-0.bin"))).toBe(false);
    expect(existsSync(join(dir, "slot-2-0.bin"))).toBe(true);
  });
});

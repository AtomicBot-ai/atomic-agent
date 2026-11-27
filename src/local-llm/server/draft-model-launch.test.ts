import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GgufMetadata } from "../catalog/gguf-metadata.js";
import { resolveDraftLaunch } from "./draft-model-launch.js";

const GIB = 1024 ** 3;
const HELP = "--model-draft FNAME\n--gpu-layers-draft N\n--ctx-size-draft N\n--device-draft <dev>\n";

function header(over: Partial<GgufMetadata> = {}): GgufMetadata {
  return {
    version: 3, tensorCount: 1, architecture: "gemma4", contextLength: null, blockCount: null, embeddingLength: null,
    headCount: null, headCountKv: null, keyLength: null, valueLength: null, keyLengthSwa: null, valueLengthSwa: null,
    slidingWindow: null, slidingWindowPattern: null, fullAttentionInterval: null, recurrentLayerPattern: null,
    hasRecurrentState: false, keys: {}, truncated: false, ...over,
  };
}

describe("resolveDraftLaunch (ATO-2424)", () => {
  let dir: string;
  let draftPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aa-draft-"));
    draftPath = join(dir, "draft.gguf");
    writeFileSync(draftPath, Buffer.alloc(1024));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = () => ({
    dataDir: dir,
    model: { id: "gemma-4-31b", draftModelId: "gemma-4-e4b" as const },
    engine: "llama-server" as const,
    device: "Vulkan0",
    binPath: "/b/llama-server",
    targetHeader: header(),
    contextSize: 32_768,
    kvBudgetBytes: 10 * GIB,
    mainKvBytes: 4 * GIB,
    pinnedDevice: "Vulkan0",
    readHeader: () => header(),
  });

  it("does nothing at all when draftModel is off: no file read, no --help", () => {
    const readHelp = vi.fn(() => HELP);
    const readHeader = vi.fn(() => header());
    expect(resolveDraftLaunch({ ...base(), preference: "off", readHelp, readHeader })).toBeNull();
    expect(readHelp).not.toHaveBeenCalled();
    expect(readHeader).not.toHaveBeenCalled();
  });

  it("adds an operator's draft file when the engine lists the draft flags", () => {
    const d = resolveDraftLaunch({ ...base(), preference: draftPath, readHelp: () => HELP });
    expect(d?.args.slice(0, 2)).toEqual(["--model-draft", draftPath]);
    expect(d?.args).toContain("--ctx-size-draft");
    expect(d?.draft).toBe(draftPath);
  });

  it("keeps the draft off on a build whose --help lacks a draft flag", () => {
    const d = resolveDraftLaunch({ ...base(), preference: draftPath, readHelp: () => "--model-draft FNAME\n" });
    expect(d?.args).toEqual([]);
    expect(d?.reason).toMatch(/does not list --gpu-layers-draft/);
  });

  it("never runs the engine under Atomic Core, and logs why the draft is off", () => {
    const readHelp = vi.fn(() => HELP);
    const d = resolveDraftLaunch({ ...base(), engine: "atomic-core", preference: draftPath, readHelp });
    expect(d?.args).toEqual([]);
    expect(d?.reason).toMatch(/Atomic Core/);
    expect(readHelp).not.toHaveBeenCalled();
  });

  it("drops a draft whose own cache cannot take back tokens either", () => {
    const d = resolveDraftLaunch({
      ...base(), preference: draftPath, readHelp: () => HELP, readHeader: () => header({ hasRecurrentState: true }),
    });
    expect(d?.args).toEqual([]);
    expect(d?.reason).toMatch(/recurrent/);
  });

  it("auto with the paired draft not on disk says how to fetch it", () => {
    const d = resolveDraftLaunch({ ...base(), preference: "auto", readHelp: () => HELP });
    expect(d).toEqual({ args: [], reason: "draft: off (draft model gemma-4-e4b is not downloaded; run 'atomic-agent models pull gemma-4-e4b')" });
  });
});

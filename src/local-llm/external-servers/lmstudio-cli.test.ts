import { describe, expect, it } from "vitest";

import {
  LMS_MISSING,
  LmStudioError,
  lmsGet,
  lmsLoad,
  lmsUnload,
  parseLmsList,
  plainLine,
  type LmsRunner,
} from "./lmstudio-cli.js";

function recorder(code = 0, stderr = "") {
  const calls: Array<{ bin: string; args: readonly string[] }> = [];
  const run: LmsRunner = async (bin, args) => {
    calls.push({ bin, args });
    return { code, stdout: "", stderr };
  };
  return { calls, run };
}

describe("LM Studio through lms (ATO-2490)", () => {
  it("load, unload and get pass an argument array with --yes where lms asks", async () => {
    const r = recorder();
    await lmsLoad("qwen/qwen3-8b", { bin: "/u/.lmstudio/bin/lms", run: r.run });
    await lmsUnload("qwen/qwen3-8b", { bin: "/u/.lmstudio/bin/lms", run: r.run });
    await lmsUnload(null, { bin: "/u/.lmstudio/bin/lms", run: r.run });
    await lmsGet("qwen/qwen3-8b", { bin: "/u/.lmstudio/bin/lms", run: r.run });
    expect(r.calls.map((c) => c.args)).toEqual([
      ["load", "qwen/qwen3-8b", "--yes"],
      ["unload", "qwen/qwen3-8b"],
      ["unload", "--all"],
      ["get", "qwen/qwen3-8b", "--yes"],
    ]);
  });

  it("no lms installed is a sentence that says how to get it", async () => {
    await expect(lmsLoad("a", { bin: null, run: recorder().run })).rejects.toThrow(LMS_MISSING);
  });

  it("a failed run keeps lms's words as detail", async () => {
    const err = await lmsLoad("a", { bin: "lms", run: recorder(1, "\u001b[31mError: model not found\u001b[0m").run }).catch((e) => e);
    expect(err).toBeInstanceOf(LmStudioError);
    expect(err.message).toBe("LM Studio could not load a.");
    expect(err.detail).toBe("Error: model not found");
  });

  it("a key that looks like a flag is refused before lms runs", async () => {
    const r = recorder();
    await expect(lmsLoad("--help", { bin: "lms", run: r.run })).rejects.toBeInstanceOf(LmStudioError);
    expect(r.calls).toEqual([]);
  });

  it("lms ls --json: relative paths become absolute under the models folder", () => {
    const out = JSON.stringify([
      { modelKey: "qwen/qwen3-8b", path: "lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf", sizeBytes: 5 },
      { modelKey: "abs", path: "/m/abs.gguf" },
      { type: "embedding" },
    ]);
    const rows = parseLmsList(out, "/Users/me/.lmstudio/models");
    expect(rows.map((r) => r.modelKey)).toEqual(["qwen/qwen3-8b", "abs"]);
    expect(rows[0]!.path).toMatch(/\.lmstudio[\\/]models[\\/]lmstudio-community[\\/]Qwen3-8B-GGUF[\\/]Qwen3-8B-Q4_K_M\.gguf$/);
    expect(rows[1]!.path).toBe("/m/abs.gguf");
    expect(parseLmsList("not json", null)).toEqual([]);
  });

  it("progress redraws keep only the last frame, without colour codes", () => {
    expect(plainLine("\u001b[32m10%\r50%\r 90% \u001b[0m")).toBe("90%");
  });
});

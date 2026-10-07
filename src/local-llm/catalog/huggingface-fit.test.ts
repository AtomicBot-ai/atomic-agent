import { describe, expect, it } from "vitest";

import {
  describeRejectedGgufFiles,
  judgeGgufFile,
  ramWarningFor,
  type GgufVerdict,
} from "./huggingface-fit.js";

describe("judgeGgufFile", () => {
  const rows: { path: string; verdict: GgufVerdict }[] = [
    { path: "Qwen3.5-4B-UD-Q4_K_XL.gguf", verdict: "usable" },
    { path: "Q4_K_M/Qwen3.5-4B-Q4_K_M.gguf", verdict: "usable" },
    { path: "gemma-4-E4B-it-IQ3_XXS.gguf", verdict: "usable" },
    // An unfamiliar naming scheme is not evidence of anything; let the
    // operator try it rather than hiding the only file in the repo.
    { path: "model.gguf", verdict: "usable" },
    { path: "mmproj-BF16.gguf", verdict: "projector" },
    { path: "nested/mmproj-F16.gguf", verdict: "projector" },
    { path: "Qwen3.5-35B-Q4_K_M-00001-of-00003.gguf", verdict: "sharded" },
    { path: "Qwen3.5-35B-Q4_K_M-00003-of-00003.gguf", verdict: "sharded" },
    { path: "mtp/Qwen3.5-4B-MTP-Q4_K_M.gguf", verdict: "companion" },
    { path: "Qwen3.5-4B-mtp-Q8_0.gguf", verdict: "companion" },
    { path: "Qwen3.5-4B-F16.gguf", verdict: "unquantised" },
    { path: "Qwen3.5-4B-BF16.gguf", verdict: "unquantised" },
    { path: "gemma-4-E4B.f32.gguf", verdict: "unquantised" },
    { path: "README.md", verdict: "unquantised" },
  ];

  for (const row of rows) {
    it(`calls ${row.path} ${row.verdict}`, () => {
      expect(judgeGgufFile(row.path).verdict).toBe(row.verdict);
    });
  }

  it("gives every refusal a reason and every acceptance none", () => {
    for (const row of rows) {
      const { verdict, reason } = judgeGgufFile(row.path);
      if (verdict === "usable") expect(reason).toBeNull();
      else expect(reason).toMatch(/\S/);
    }
  });

  // The projector refusal is the one an operator is most likely to hit by
  // copying a file link, so it has to say what to do instead.
  it("tells the operator to name the repo when they picked the projector", () => {
    expect(judgeGgufFile("mmproj-BF16.gguf").reason).toContain("name the repo");
  });
});

describe("describeRejectedGgufFiles", () => {
  it("says nothing when nothing was filtered out", () => {
    expect(describeRejectedGgufFiles(["usable", "usable"])).toBeNull();
  });

  it("counts each kind of refusal", () => {
    expect(describeRejectedGgufFiles(["sharded", "sharded", "projector"])).toBe(
      "3 more files hidden: 2 multi-part, 1 vision projector",
    );
  });

  it("keeps the singular for one file", () => {
    expect(describeRejectedGgufFiles(["unquantised"])).toBe(
      "1 more file hidden: 1 full-precision",
    );
  });
});

describe("ramWarningFor", () => {
  const rows: { fileSizeGb: number; hostRamGb: number; warns: boolean }[] = [
    { fileSizeGb: 4.2, hostRamGb: 16, warns: false },
    { fileSizeGb: 16, hostRamGb: 16, warns: false },
    { fileSizeGb: 17.3, hostRamGb: 16, warns: true },
    { fileSizeGb: 40, hostRamGb: 8, warns: true },
    // Sizes are estimates from the API; a missing one is not a warning.
    { fileSizeGb: 0, hostRamGb: 8, warns: false },
  ];

  for (const row of rows) {
    it(`${row.fileSizeGb} GB on ${row.hostRamGb} GB ${row.warns ? "warns" : "is quiet"}`, () => {
      const warning = ramWarningFor(row.fileSizeGb, row.hostRamGb);
      if (row.warns) expect(warning).toMatch(/slow/);
      else expect(warning).toBeNull();
    });
  }

  // It is drawn on one row of a step with a fixed budget, and Ink 7
  // overlaps rather than clips, so a wrap here would paint over the list.
  it("stays inside the narrowest supported terminal", () => {
    expect((ramWarningFor(999.9, 4) ?? "").length).toBeLessThanOrEqual(67);
  });
});

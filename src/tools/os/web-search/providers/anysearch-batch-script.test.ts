import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(
  process.cwd(),
  "starter-skills",
  "anysearch",
  "scripts",
  "batch-search.js",
);

describe("anysearch batch-search.js", () => {
  it("parses as valid Node and prints usage without queries", () => {
    const result = spawnSync(process.execPath, ["--check", script], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const usage = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/usage:/i);
  });

  it("rejects a queries payload that is not a 1–5 array", () => {
    const result = spawnSync(
      process.execPath,
      [script, "--queries", '{"query":"solo-object"}'],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/1–5|1-5|array/i);
  });
});

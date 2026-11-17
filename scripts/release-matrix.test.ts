import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { CLI_RELEASE_TARGETS } from "./bundle-targets.js";

// The release workflow's build matrix is hand-written YAML; CLI_RELEASE_TARGETS is the list the
// installer and the bundling scripts know, minus the desktop-only win32-arm64 (ATO-252). A slug
// in one and not the other is either a build nobody can install or an installer path that 404s
// (darwin-x64 was the second, ATO-682).
const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as {
  jobs: { build: { strategy: { matrix: { include: { slug: string; os: string }[] } } } };
};
const rows = workflow.jobs.build.strategy.matrix.include;

describe("release.yml build matrix", () => {
  it("builds every bundle target and nothing else", () => {
    expect(rows.map((r) => r.slug).sort()).toEqual(CLI_RELEASE_TARGETS.map((t) => t.slug).sort());
  });

  it("builds darwin-x64 on an Intel runner (the SEA is built for the runner's own arch)", () => {
    expect(rows.find((r) => r.slug === "darwin-x64")?.os).toMatch(/intel/);
  });
});

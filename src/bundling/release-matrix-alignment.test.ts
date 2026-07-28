import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLE_TARGETS } from "../../scripts/bundle-targets.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE_YML = resolve(REPO_ROOT, ".github/workflows/release.yml");

/**
 * Pin the release workflow's build matrix against first-class install targets.
 *
 * linux-arm64 has lived in BUNDLE_TARGETS / install.sh / fetch-assets forces
 * for a long time, but release.yml had the runner entry commented out for cost.
 * That combination silently 404s the one-line installer on ARM Linux (#43).
 */
function uncommentedSlugLines(yml: string): string[] {
  return yml
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("#") && /slug:\s*[\w-]+/.test(trimmed);
    });
}

function parseSlug(line: string): string | null {
  const m = line.match(/slug:\s*([A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

describe("release matrix alignment", () => {
  it("lists linux-arm64 in BUNDLE_TARGETS (source of truth)", () => {
    expect(BUNDLE_TARGETS.some((t) => t.slug === "linux-arm64")).toBe(true);
  });

  it("enables linux-arm64 on ubuntu-24.04-arm in release.yml (#43)", () => {
    const yml = readFileSync(RELEASE_YML, "utf8");
    const activeSlugs = uncommentedSlugLines(yml)
      .map(parseSlug)
      .filter((s): s is string => Boolean(s));

    expect(activeSlugs, "release.yml active matrix slugs").toContain("linux-arm64");

    // Prefer the GitHub-hosted ARM runner callout, not a self-hosted label.
    const armLines = uncommentedSlugLines(yml).filter((l) => l.includes("linux-arm64"));
    expect(armLines.length).toBeGreaterThan(0);
    expect(armLines.some((l) => l.includes("ubuntu-24.04-arm"))).toBe(true);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INSTALL_SOURCE_TAGS } from "../src/analytics/resolve-analytics-dimensions.js";

/**
 * The install scripts write `<stateDir>/install-source` (ATO-419). The site
 * fills in the tag by rewriting one exact line of each script, and the
 * runtime only accepts words from INSTALL_SOURCE_TAGS, so the scripts' own
 * lists and that line are pinned here.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installSh = readFileSync(join(repoRoot, "scripts/install.sh"), "utf8");
const installPs1 = readFileSync(join(repoRoot, "scripts/install.ps1"), "utf8");
const tagsWithoutUnknown = INSTALL_SOURCE_TAGS.filter((t) => t !== "unknown");

function occurrences(haystack: string, line: RegExp): number {
  return haystack.match(line)?.length ?? 0;
}

describe("install source marker in the install scripts", () => {
  it("keeps the line the site rewrites, exactly once per script", () => {
    // A Windows checkout may turn LF into CRLF, so allow a trailing \r.
    expect(occurrences(installSh, /^INSTALL_FROM_TAG=""\r?$/gm)).toBe(1);
    expect(occurrences(installPs1, /^\$InstallFromTag = ""\r?$/gm)).toBe(1);
  });

  it("uses the runtime's allowlist in install.sh", () => {
    const cases = installSh.match(
      /^\s+(x\|reddit[^)]*)\)/gm,
    );
    expect(cases).not.toBeNull();
    for (const line of cases ?? []) {
      expect(line.trim().replace(/\)$/, "").split("|")).toEqual(
        tagsWithoutUnknown,
      );
    }
  });

  it("uses the runtime's allowlist in install.ps1", () => {
    const match = installPs1.match(/\$sources = @\(([^)]*)\)/);
    expect(match).not.toBeNull();
    const words = (match?.[1] ?? "")
      .split(",")
      .map((w) => w.trim().replace(/^"|"$/g, ""));
    expect(words).toEqual(tagsWithoutUnknown);
  });
});

describe.skipIf(process.platform === "win32")(
  "install.sh record_install_source",
  () => {
    let stateDir: string;
    const fn = installSh.match(/^record_install_source\(\) \{[\s\S]*?^\}/m)?.[0];

    beforeEach(() => {
      stateDir = mkdtempSync(join(tmpdir(), "atomic-install-source-"));
    });

    afterEach(() => {
      rmSync(stateDir, { recursive: true, force: true });
    });

    function run(from: string): string | undefined {
      execFileSync("sh", ["-c", `set -eu\n${fn}\nrecord_install_source`], {
        env: {
          PATH: process.env.PATH,
          HOME: stateDir,
          INSTALL_FROM: from,
          ATOMIC_AGENT_STATE_DIR: stateDir,
        },
      });
      try {
        return readFileSync(join(stateDir, "install-source"), "utf8");
      } catch {
        return undefined;
      }
    }

    it("writes a tag from the allowlist, lowercased", () => {
      expect(fn).toBeDefined();
      expect(run("Reddit")).toBe("reddit\n");
    });

    it("writes nothing for an untagged install or a value outside the allowlist", () => {
      expect(run("")).toBeUndefined();
      expect(run("https://x.com/post")).toBeUndefined();
      expect(run("x;rm -rf /")).toBeUndefined();
    });

    it("keeps the first recorded source", () => {
      run("x");
      expect(run("github")).toBe("x\n");
    });

    it("replaces a marker that holds no known word", () => {
      writeFileSync(join(stateDir, "install-source"), "junk\n");
      expect(run("site")).toBe("site\n");
    });
  },
);

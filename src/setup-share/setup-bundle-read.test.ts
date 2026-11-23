import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAllowedBundlePath } from "./setup-bundle-format.js";
import { readSetupBundle, SetupBundleError } from "./setup-bundle-read.js";
import { manifestFor, writeTar } from "./setup-share-test-helpers.js";

describe("isAllowedBundlePath", () => {
  it("allows only the setup folders", () => {
    for (const ok of ["config.json", "manifest.json", "memory.sqlite", "agents/reviewer.md", "skills/triage/SKILL.md", "skills/triage/scripts/run.sh"]) {
      expect(isAllowedBundlePath(ok), ok).toBe(true);
    }
    for (const bad of [
      "/etc/passwd", "../outside", "skills/../../x", "skills/a/../../b", "C:/Windows/x", "skills\\a\\b",
      ".env", "sessions.sqlite", "mcp-oauth/token.json", "agents/../config.json", "agents/sub/x.md",
      "skills/triage", "skills/triage/.env", "skills/triage/node_modules/x.js", "skills/./SKILL.md", "",
    ]) {
      expect(isAllowedBundlePath(bad), bad).toBe(false);
    }
  });
});

describe("readSetupBundle", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "setup-read-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function refused(entries: Parameters<typeof writeTar>[1]): Promise<string> {
    const file = join(root, "b.tar.gz");
    await writeTar(file, entries);
    const into = join(root, "stage");
    const err = await readSetupBundle(file, into).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SetupBundleError);
    // Nothing escaped the staging folder.
    expect(existsSync(join(root, "evil"))).toBe(false);
    rmSync(into, { recursive: true, force: true });
    return (err as Error).message;
  }

  const manifest = (paths: string[]) => ({ header: { name: "atomic-agent-setup/manifest.json" }, content: manifestFor(paths) });

  it("refuses path traversal and absolute paths", async () => {
    expect(await refused([manifest(["config.json"]), { header: { name: "atomic-agent-setup/../evil" }, content: "x" }])).toMatch(/path a setup may not write/);
    expect(await refused([manifest(["config.json"]), { header: { name: "/evil" }, content: "x" }])).toMatch(/outside atomic-agent-setup/);
    expect(await refused([manifest(["config.json"]), { header: { name: "atomic-agent-setup/skills/a/../../../evil" }, content: "x" }])).toMatch(/may not write/);
  });

  it("refuses a manifest that lists a traversal path", async () => {
    expect(await refused([manifest(["../evil"])])).toMatch(/outside the allowed folders/);
  });

  it("refuses links, unlisted entries and a missing or misplaced manifest", async () => {
    expect(await refused([manifest(["config.json"]), { header: { name: "atomic-agent-setup/agents/x.md", type: "symlink", linkname: "/etc/passwd" } }])).toMatch(/symlink/);
    expect(await refused([manifest(["config.json"]), { header: { name: "atomic-agent-setup/agents/x.md" }, content: "x" }])).toMatch(/not listed/);
    expect(await refused([{ header: { name: "atomic-agent-setup/config.json" }, content: "{}" }])).toMatch(/first entry/);
    expect(await refused([{ header: { name: "atomic-agent-setup/manifest.json" }, content: JSON.stringify({ format: "other" }) }])).toMatch(/not an Atomic Agent setup/);
  });

  it("unpacks a well-formed bundle", async () => {
    const file = join(root, "ok.tar.gz");
    await writeTar(file, [manifest(["config.json", "agents/x.md"]), { header: { name: "atomic-agent-setup/config.json" }, content: "{}" }, { header: { name: "atomic-agent-setup/agents/x.md" }, content: "hi" }]);
    const m = await readSetupBundle(file, join(root, "stage"));
    expect(m.files).toHaveLength(2);
    expect(readFileSync(join(root, "stage", "agents", "x.md"), "utf8")).toBe("hi");
  });
});

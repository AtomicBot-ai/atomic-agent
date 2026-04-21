import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

function stageSkill(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "atomic-skill-src-"));
  mkdirSync(join(dir, name), { recursive: true });
  const manifest = [
    "---",
    `name: ${name}`,
    `description: test skill ${name}`,
    "version: 0.0.1",
    "dangerous: false",
    "---",
    `# ${name}`,
    "",
    "Body.",
    "",
  ].join("\n");
  writeFileSync(join(dir, name, "SKILL.md"), manifest, "utf8");
  return join(dir, name);
}

describe("/api/skills", () => {
  let harness: Harness;
  const stagedDirs: string[] = [];

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const dir of stagedDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    stagedDirs.length = 0;
  });

  it("install → list → get → uninstall round-trip works end-to-end", async () => {
    const sourcePath = stageSkill("api-test-skill");
    stagedDirs.push(sourcePath);

    const installResponse = await fetch(`${harness.baseUrl}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePath, source: "global" }),
    });
    expect(installResponse.status).toBe(200);
    const installBody = (await installResponse.json()) as {
      installed: boolean;
      manifest: { name: string };
    };
    expect(installBody.installed).toBe(true);
    expect(installBody.manifest.name).toBe("api-test-skill");

    const listResponse = await fetch(`${harness.baseUrl}/api/skills`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      skills: Array<{ name: string; source: string }>;
    };
    const names = listBody.skills.map((s) => s.name);
    expect(names).toContain("api-test-skill");

    const getResponse = await fetch(
      `${harness.baseUrl}/api/skills/api-test-skill`,
    );
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as {
      manifest: { name: string };
      body: string;
    };
    expect(getBody.manifest.name).toBe("api-test-skill");
    expect(getBody.body).toContain("Body.");

    const uninstallResponse = await fetch(
      `${harness.baseUrl}/api/skills/uninstall`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "api-test-skill", source: "global" }),
      },
    );
    expect(uninstallResponse.status).toBe(200);
    const uninstallBody = (await uninstallResponse.json()) as {
      removed: boolean;
    };
    expect(uninstallBody.removed).toBe(true);

    const listAfter = await fetch(`${harness.baseUrl}/api/skills`);
    const listAfterBody = (await listAfter.json()) as {
      skills: Array<{ name: string }>;
    };
    expect(listAfterBody.skills.map((s) => s.name)).not.toContain(
      "api-test-skill",
    );
  });

  it("rejects install when sourcePath is missing", async () => {
    const response = await fetch(`${harness.baseUrl}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/sourcePath/);
  });

  it("returns 404 for unknown skills", async () => {
    const response = await fetch(`${harness.baseUrl}/api/skills/missing-skill`);
    expect(response.status).toBe(404);
  });
});

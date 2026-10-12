import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";
import { getConfig } from "../config/index.js";

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

    const installResponse = await fetch(
      `${harness.baseUrl}/api/skills/install`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourcePath, source: "global" }),
      },
    );
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

  it("selects a cloud session's workspace for list, detail and capabilities without changing legacy calls", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "http-session-workspace-"))); stagedDirs.push(root);
    const skillDir = join(root, ".agents/skills/session-guide"); mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: session-guide\ndescription: Session guide\n---\nSELECTED BODY");
    const config = getConfig();
    config.llm = { activeTextProvider: "local-llama", activeEmbeddingProvider: "local-llama", toolTransport: "auto",
      providers: [{ id: "local-llama", kind: "llama-server", url: config.localModels.url, modelMode: "cloud" }] };
    const session = { ...harness.runtime.createSession({ persist: false }), workingDir: root }; harness.runtime.sessionStore.save(session);
    const query = `?sessionId=${session.id}`;
    const list = await (await fetch(`${harness.baseUrl}/api/skills${query}`)).json() as { workingDir: string; skills: Array<{ name: string }> };
    expect(list.workingDir).toBe(root); expect(list.skills.some((s: { name: string }) => s.name === "session-guide")).toBe(true);
    const detail = await (await fetch(`${harness.baseUrl}/api/skills/session-guide${query}`)).json() as { body: string }; expect(detail.body).toBe("SELECTED BODY");
    const caps = await (await fetch(`${harness.baseUrl}/api/capabilities${query}`)).json() as { capabilities: { workingDir: string } }; expect(caps.capabilities.workingDir).toBe(root);
    const legacy = await (await fetch(`${harness.baseUrl}/api/skills`)).json() as { skills: Array<{ name: string }> }; expect(legacy.skills.some((s: { name: string }) => s.name === "session-guide")).toBe(false);
    expect((await fetch(`${harness.baseUrl}/api/skills?sessionId=missing`)).status).toBe(404);
    expect(harness.runtime.capabilities.workingDir).toBe(harness.workingDir);
  });
  it("previews a new cloud chat without saving it, and rechecks live files and policy", async () => {
    const config = getConfig();
    const dir = join(harness.workingDir, ".agents/skills/before-chat");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, "---\nname: before-chat\ndescription: New chat skill\n---\nFIRST BODY");
    const count = harness.runtime.sessionStore.listRecent(100).length;
    const url = `${harness.baseUrl}/api/skills?workspace=true`;
    const read = async () => await (await fetch(url)).json() as {
      workingDir?: string; skills: Array<{ name: string; disabled: boolean; disabledReasons: string[]; fingerprint: string }>;
    };
    // Local and context-free reads retain the old registry.
    expect((await read()).skills.some(row => row.name === "before-chat")).toBe(false);
    config.llm = { activeTextProvider: "local-llama", activeEmbeddingProvider: "local-llama", toolTransport: "auto",
      providers: [{ id: "local-llama", kind: "llama-server", url: config.localModels.url, modelMode: "cloud" }] };
    const first = await read();
    expect(first.workingDir).toBe(realpathSync(harness.workingDir));
    const selected = first.skills.find(row => row.name === "before-chat")!;
    expect(selected.disabled).toBe(false);
    writeFileSync(file, "---\nname: before-chat\ndescription: Updated\n---\nSECOND BODY");
    const changed = (await read()).skills.find(row => row.name === "before-chat")!;
    expect(changed.fingerprint).not.toBe(selected.fingerprint);
    const detail = await (await fetch(`${harness.baseUrl}/api/skills/before-chat?workspace=true`)).json() as { body: string };
    expect(detail.body).toBe("SECOND BODY");
    writeFileSync(config.paths.userConfigFile, JSON.stringify({ skills: { ...config.skills, disabled: ["before-chat"] } }));
    expect((await read()).skills.find(row => row.name === "before-chat")?.disabledReasons).toContain("disabled globally");
    const caps = await (await fetch(`${harness.baseUrl}/api/capabilities?workspace=true`)).json() as { skills: Array<{name: string}> };
    expect(caps.skills.some(row => row.name === "before-chat")).toBe(false);
    expect(harness.runtime.sessionStore.listRecent(100).length).toBe(count);
    expect((await fetch(`${harness.baseUrl}/api/skills/before-chat?sessionId=missing`)).status).toBe(404);
  });

});

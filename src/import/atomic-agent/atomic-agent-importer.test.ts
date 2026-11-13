import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, ProfileStore } from "../../memory/index.js";
import { SessionStore, createEmptySessionState } from "../../session/index.js";
import { assistantReplyTurn, userTurn } from "../../session/conversation-turn.js";
import { TaskStore } from "../../tasks/index.js";
import { AtomicAgentImporter, resolveAtomicAgentOptions } from "./atomic-agent-importer.js";

function openStores(dir: string) {
  const sessionStore = new SessionStore({ dbFile: join(dir, "sessions.sqlite") });
  const taskStore = new TaskStore({ dbFile: join(dir, "tasks.sqlite") });
  const memoryStore = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 1_000 });
  const profileStore = new ProfileStore({ dbFile: join(dir, "memory.sqlite") });
  return {
    sessionStore,
    taskStore,
    memoryStore,
    profileStore,
    close() {
      profileStore.close();
      memoryStore.close();
      taskStore.close();
      sessionStore.close();
    },
  };
}

describe("AtomicAgentImporter", () => {
  let root: string;
  let sourceDir: string;
  let targetDir: string;
  let target: ReturnType<typeof openStores>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-agent-import-"));
    sourceDir = join(root, "other-profile");
    targetDir = join(root, "this-app");
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    const source = openStores(sourceDir);
    for (const id of ["s-shop", "s-idea"]) {
      source.sessionStore.save({
        ...createEmptySessionState({ id, workingDir: "/src/shop" }),
        turns: [userTurn(`hi ${id}`, 1), assistantReplyTurn("hello", { at: 2 })],
        turnCount: 1,
      });
    }
    source.close();
    writeFileSync(
      join(sourceDir, "projects.json"),
      JSON.stringify({
        version: 1,
        projects: [{ id: "pshop0001", name: "Shop", folder: "/src/shop", instructions: "use pnpm", createdAt: 3 }],
        chats: { "s-shop": "pshop0001" },
      }),
    );
    writeFileSync(
      join(sourceDir, "chat-folders.json"),
      JSON.stringify({ version: 1, folders: [{ id: "fideas", name: "Ideas", collapsed: false }], chats: { "s-idea": "fideas" } }),
    );
    writeFileSync(
      join(sourceDir, "config.json"),
      JSON.stringify({
        mcp: { servers: [{ name: "files", transport: { kind: "stdio", command: "mcp-files" } }] },
        llm: { providers: [{ id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKey: "inline-secret", headers: { Authorization: "Bearer inline-secret", "X-Title": "atomic" } }] },
      }),
    );
    writeFileSync(join(sourceDir, ".env"), "GROQ_API_KEY=abc\n");
    mkdirSync(join(sourceDir, "skills", "triage"), { recursive: true });
    writeFileSync(
      join(sourceDir, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Sort the inbox\n---\n\n# triage\n",
    );
    target = openStores(targetDir);
  });

  afterEach(() => {
    target.close();
    rmSync(root, { recursive: true, force: true });
  });

  function importer(from = sourceDir) {
    return new AtomicAgentImporter({
      sourceDir: from,
      stateDir: targetDir,
      userConfigFile: join(targetDir, "config.json"),
      globalSkillsDir: join(targetDir, "skills"),
      targets: target,
    });
  }

  it("refuses this app's own data folder", async () => {
    const report = await importer(targetDir).run({ options: resolveAtomicAgentOptions(), execute: true, overwrite: false });
    expect(report.items).toEqual([
      expect.objectContaining({ status: "error", reason: expect.stringContaining("target state dir") }),
    ]);
  });

  it("previews without writing, then brings chats with their project and folder, once", async () => {
    const options = resolveAtomicAgentOptions();
    expect(options).toEqual(["sessions", "memory", "skills", "mcp", "providers"]);

    const preview = await importer().run({ options, execute: false, overwrite: false });
    expect(preview.items.filter((i) => i.kind === "sessions").map((i) => i.status)).toEqual(["migrated", "migrated"]);
    expect(target.sessionStore.load("s-shop")).toBeNull();

    const report = await importer().run({ options, execute: true, overwrite: false });
    expect(report.summary.error).toBe(0);
    expect(target.sessionStore.load("s-shop")).not.toBeNull();
    const projects = JSON.parse(readFileSync(join(targetDir, "projects.json"), "utf8"));
    expect(projects.projects).toEqual([
      { id: "pshop0001", name: "Shop", folder: "/src/shop", instructions: "use pnpm", createdAt: 3 },
    ]);
    expect(projects.chats).toEqual({ "s-shop": "pshop0001" });
    const folders = JSON.parse(readFileSync(join(targetDir, "chat-folders.json"), "utf8"));
    expect(folders.chats).toEqual({ "s-idea": "fideas" });
    // A provider comes without the key saved inline in the source's config while secrets are off.
    const config = JSON.parse(readFileSync(join(targetDir, "config.json"), "utf8"));
    const groq = config.llm.providers.find((p: { id: string }) => p.id === "groq");
    expect(groq).toBeDefined();
    expect(groq.apiKey).toBeUndefined();
    expect(groq.headers).toEqual({ "X-Title": "atomic" });
    expect(config.mcp.servers.map((s: { name: string }) => s.name)).toContain("files");
    expect(readFileSync(join(targetDir, "skills", "triage", "SKILL.md"), "utf8")).toContain("triage");
    // No secrets and no scheduled jobs unless asked.
    expect(report.items.some((i) => i.kind === "secrets" || i.kind === "cron")).toBe(false);

    const again = await importer().run({ options, execute: true, overwrite: false });
    expect(again.summary.migrated).toBe(0);
    expect(JSON.parse(readFileSync(join(targetDir, "projects.json"), "utf8"))).toEqual(projects);
  });

  it("copies API keys only with the secrets option", async () => {
    const report = await importer().run({
      options: resolveAtomicAgentOptions({ exclude: ["sessions", "memory", "skills", "mcp", "providers"], migrateSecrets: true }),
      execute: true,
      overwrite: false,
    });
    expect(report.items).toEqual([
      { kind: "secrets", source: "GROQ_API_KEY", destination: "GROQ_API_KEY", status: "migrated" },
    ]);
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain("GROQ_API_KEY=abc");
  });
});

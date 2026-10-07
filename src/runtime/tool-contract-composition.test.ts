import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime } from "./bootstrap.js";
import { resetConfigCache, USER_CONFIG_DEFAULTS, writeUserConfigFileSync } from "../config/index.js";
import { GATED_TOOL_NAMES } from "./filter-disabled-tools.js";
import { ToolRegistry, type ToolDefinition } from "../tools/tool-registry.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import { READ_TOOL_TARGETS } from "../tools/read-scope/read-scope-targets.js";
import * as readProtection from "../tools/read-scope/confine-reads.js";

const externalOperation = (): never => { throw new Error("Composition test must not perform external work"); };
const backend: BrowserBackend = {
  ensureReady: async () => externalOperation(), shutdown: async () => {},
  snapshot: async () => externalOperation(), hasRef: async () => externalOperation(),
  navigate: async () => externalOperation(), click: async () => externalOperation(),
  type: async () => externalOperation(), search: async () => externalOperation(),
  tabs: async () => externalOperation(), scroll: async () => externalOperation(),
};

// Observe bootstrap itself: registry builders alone cannot prove that callers wire their gates.
describe("runtime tool contract composition", () => {
  it.each([
    { enabled: false, tasksEnabled: false },
    { enabled: true, tasksEnabled: true },
    { enabled: true, tasksEnabled: false },
  ])("preserves native registrations and read-scope phases with gates=%j", async ({ enabled, tasksEnabled }) => {
    const directory = mkdtempSync(join(tmpdir(), "atomic-tool-composition-"));
    const stateDir = join(directory, "state");
    const workingDir = join(directory, "work");
    mkdirSync(join(workingDir, ".atomic-agent/skills"), { recursive: true });
    const config = structuredClone(USER_CONFIG_DEFAULTS);
    config.memory.profile.enabled = enabled;
    config.memory.notes.enabled = enabled;
    config.memory.lessons.enabled = enabled;
    config.memory.procedures.enabled = enabled;
    config.vision.enabled = false; // Provider availability is independently pinned in the registrar gate.
    config.web.search.persistCache = false;
    config.web.search.provider = "duckduckgo";
    config.telegram.enabled = false;
    config.discord.enabled = false;
    config.analytics.enabled = false;
    config.mcp.servers = [{ name: "disabled", enabled: false, transport: { kind: "stdio", command: "must-not-start" } }];
    writeUserConfigFileSync(join(stateDir, "config.json"), config);
    const previous = new Map<string, string | undefined>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ATOMIC_AGENT_") || key === "GITHUB_TOKEN") {
        previous.set(key, process.env[key]); delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries({ ATOMIC_AGENT_STATE_DIR: stateDir, ATOMIC_AGENT_GRAMMARS_DIR: join(process.cwd(), "grammars"), ATOMIC_AGENT_BROWSER_ENABLED: String(enabled), ATOMIC_AGENT_TASKS_ENABLED: String(tasksEnabled), ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED: "false", ATOMIC_AGENT_TASKS_RUN_ON_CREATE: "false", ATOMIC_AGENT_TASKS_AGENT_TOOLS_ENABLED: String(enabled) })) {
      if (!previous.has(key)) previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    resetConfigCache();
    const registrations: ToolDefinition[] = [];
    let protectionStart: number | undefined;
    const originalRegister = ToolRegistry.prototype.register;
    const originalProtection = readProtection.confineReads;
    const registerSpy = vi.spyOn(ToolRegistry.prototype, "register").mockImplementation(function(this: ToolRegistry, definition) {
      registrations.push(definition); originalRegister.call(this, definition);
    });
    const protectionSpy = vi.spyOn(readProtection, "confineReads").mockImplementation((...args) => {
      protectionStart = registrations.length;
      return originalProtection(...args);
    });
    let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
    try {
      runtime = await createAgentRuntime({ workingDir, approvalLevel: 5, overrides: { browserBackend: backend, skipLlamaHealthCheck: true, llamaComplete: async () => externalOperation() } });
      expect(protectionSpy).toHaveBeenCalledTimes(1);
      if (protectionStart === undefined) throw new Error("Bootstrap did not install read protection");
      const native = registrations.slice(0, protectionStart);
      const replacements = registrations.slice(protectionStart);
      expect(new Set(native.map((definition) => definition.name)).size).toBe(native.length);
      const expectedReplacements = [...READ_TOOL_TARGETS.keys(), "os.shell.run"].filter((name) => runtime?.toolRegistry.has(name));
      expect(replacements.map((definition) => definition.name)).toEqual(expectedReplacements);
      for (const definition of replacements) {
        const original = native.find((candidate) => candidate.name === definition.name);
        if (!original) throw new Error(`Protection replaced an unregistered tool: ${definition.name}`);
        expect(definition.run).not.toBe(original.run);
        expect({ ...definition, run: original.run }).toEqual(original);
        expect(runtime.toolRegistry.get(definition.name)).toBe(definition);
      }
      for (const group of [GATED_TOOL_NAMES.browser, GATED_TOOL_NAMES.memoryProfile, GATED_TOOL_NAMES.memoryNotes, GATED_TOOL_NAMES.memoryLessons, GATED_TOOL_NAMES.memoryProcedures]) {
        for (const name of group) {
          expect(runtime.toolRegistry.has(name), name).toBe(enabled);
          expect(runtime.toolDescriptors.some((descriptor) => descriptor.name === name), name).toBe(enabled);
        }
      }
      for (const name of GATED_TOOL_NAMES.tasks) {
        expect(runtime.toolRegistry.has(name), name).toBe(enabled && tasksEnabled);
        expect(runtime.toolDescriptors.some((descriptor) => descriptor.name === name), name).toBe(enabled && tasksEnabled);
      }
      for (const name of GATED_TOOL_NAMES.vision) expect(runtime.toolRegistry.has(name)).toBe(false);
      // These gates hide availability, while calls keep their live credential/mode checks.
      for (const name of [...GATED_TOOL_NAMES.email, ...GATED_TOOL_NAMES.github, ...GATED_TOOL_NAMES.fusion]) {
        expect(runtime.toolRegistry.has(name), name).toBe(true);
        expect(runtime.toolDescriptors.some((descriptor) => descriptor.name === name), name).toBe(false);
      }
      // A configured disabled server installs the aggregate tools exactly once, without starting a client.
      for (const name of GATED_TOOL_NAMES.mcp) expect(native.filter((definition) => definition.name === name)).toHaveLength(1);
      expect(runtime.toolRegistry.has("reply")).toBe(true);
      expect(runtime.toolRegistry.has("finish")).toBe(true);
    } finally {
      try { await runtime?.shutdown(); } finally {
        registerSpy.mockRestore(); protectionSpy.mockRestore();
        for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        resetConfigCache(); rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});

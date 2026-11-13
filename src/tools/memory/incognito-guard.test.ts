import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProfileStore } from "../../memory/profile-store.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "../tool-registry.js";
import {
  INCOGNITO_MEMORY_READ_REFUSAL,
  INCOGNITO_MEMORY_WRITE_REFUSAL,
  INCOGNITO_TASK_REFUSAL,
  refuseInIncognito,
} from "./incognito-guard.js";
import { registerMemoryTools } from "./index.js";

/**
 * ATO-586: memory write tools refuse in an incognito chat, and (decision
 * 8) so do the memory recall tools: it does not read saved memory either.
 */

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
    userGroundingTexts: ["I like tea"],
    ...extra,
  };
}

function fakeTool(): { tool: ToolDefinition; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({ tool: "fake.write", status: "ok", summary: "written", details: {} }));
  return {
    run,
    tool: { name: "fake.write", description: "writes", readonly: false, run } as unknown as ToolDefinition,
  };
}

describe("refuseInIncognito", () => {
  it("refuses when the call says the chat is incognito, without running the tool", async () => {
    const { tool, run } = fakeTool();
    const result = await refuseInIncognito(tool).run({}, ctx({ incognito: true }));
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.summary).toContain(INCOGNITO_MEMORY_WRITE_REFUSAL);
    expect(result.details.reason).toBe("incognito_session");
  });

  it("refuses when the store says the session is incognito", async () => {
    const { tool, run } = fakeTool();
    const isIncognito = vi.fn(() => true);
    const result = await refuseInIncognito(tool, isIncognito).run({}, ctx());
    expect(isIncognito).toHaveBeenCalledWith("s1");
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
  });

  it("refuses when the store cannot answer", async () => {
    const { tool, run } = fakeTool();
    const result = await refuseInIncognito(tool, () => { throw new TypeError("database connection is not open"); }).run({}, ctx());
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
  });

  it("runs the tool unchanged in an ordinary chat", async () => {
    const { tool, run } = fakeTool();
    const guarded = refuseInIncognito(tool, () => false);
    expect(guarded.name).toBe(tool.name);
    expect(guarded.readonly).toBe(false);
    const result = await guarded.run({ a: 1 }, ctx());
    expect(run).toHaveBeenCalledWith({ a: 1 }, expect.objectContaining({ sessionId: "s1" }));
    expect(result.status).toBe("ok");
  });
});

describe("refuseInIncognito with its own refusal", () => {
  it("answers with the refusal it was given", async () => {
    const { tool, run } = fakeTool();
    const result = await refuseInIncognito(tool, undefined, INCOGNITO_TASK_REFUSAL).run({}, ctx({ incognito: true }));
    expect(run).not.toHaveBeenCalled();
    expect(result.summary).toContain(INCOGNITO_TASK_REFUSAL);
    expect(result.summary).not.toContain(INCOGNITO_MEMORY_WRITE_REFUSAL);
  });
});

describe("registerMemoryTools in an incognito chat", () => {
  let dir: string;
  let profileStore: ProfileStore;
  let registry: ToolRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-incognito-"));
    profileStore = new ProfileStore({ dbFile: join(dir, "memory.sqlite") });
    registry = new ToolRegistry();
    registerMemoryTools(registry, {
      profileStore,
      profileEnabled: true,
      // Never reached: the guard refuses before the tool touches it.
      notesStore: {} as MemoryStore,
      notesEnabled: true,
      notesRecallDefaultK: 3,
      notesMaxContentChars: 2_000,
    });
  });

  afterEach(() => {
    profileStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("memory.profile.set writes nothing", async () => {
    const result = await registry.get("memory.profile.set").run(
      { key: "drink", value: "tea" },
      ctx({ incognito: true }),
    );
    expect(result.status).toBe("error");
    expect(profileStore.list()).toEqual([]);
  });

  it("memory.notes.store writes nothing", async () => {
    const result = await registry.get("memory.notes.store").run(
      { content: "the user likes tea" },
      ctx({ incognito: true }),
    );
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("incognito_session");
  });

  it("memory.profile.set still writes in an ordinary chat", async () => {
    const result = await registry.get("memory.profile.set").run(
      { key: "drink", value: "tea" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(profileStore.list().map((fact) => fact.key)).toEqual(["drink"]);
  });

  it("removing a fact is not refused: it writes nothing from the chat", async () => {
    profileStore.set("drink", "tea");
    const result = await registry.get("memory.profile.remove").run(
      { key: "drink" },
      ctx({ incognito: true }),
    );
    expect(result.details.reason).not.toBe("incognito_session");
    expect(profileStore.list()).toEqual([]);
  });

  it("memory.profile.list shows no stored facts in an incognito chat (decision 8)", async () => {
    profileStore.set("drink", "tea");
    const result = await registry.get("memory.profile.list").run({}, ctx({ incognito: true }));
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("incognito_session");
    expect(result.summary).toContain(INCOGNITO_MEMORY_READ_REFUSAL);
    expect(result.summary).not.toContain("tea");
  });

  it("memory.profile.history and memory.notes.recall refuse in an incognito chat", async () => {
    profileStore.set("drink", "tea");
    const history = await registry.get("memory.profile.history").run({ key: "drink" }, ctx({ incognito: true }));
    expect(history.details.reason).toBe("incognito_session");
    expect(history.summary).not.toContain("tea");
    // notesStore is a bare stub: reaching it would throw, so a refusal
    // also proves the store was never read.
    const recall = await registry.get("memory.notes.recall").run({ query: "tea" }, ctx({ incognito: true }));
    expect(recall.details.reason).toBe("incognito_session");
  });

  it("memory.profile.list still lists facts in an ordinary chat", async () => {
    profileStore.set("drink", "tea");
    const result = await registry.get("memory.profile.list").run({}, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.reason).not.toBe("incognito_session");
  });
});

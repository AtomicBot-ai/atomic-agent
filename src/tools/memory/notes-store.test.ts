import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { ProfileStore } from "../../memory/profile-store.js";
import type { GroundingConversation } from "../../memory/name-grounding.js";
import { buildNotesStoreTool, UNCONFIRMED_NAME_TAG } from "./notes-store.js";
import { buildProfileSetTool } from "./profile-set.js";

function makeCtx(userGroundingTexts?: readonly string[]): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
    ...(userGroundingTexts !== undefined ? { userGroundingTexts } : {}),
  };
}

function storedSessions(...sessions: string[][]) {
  return async function* walk(): AsyncGenerator<GroundingConversation> {
    let updatedAt = 10_000;
    for (const texts of sessions) {
      updatedAt -= 1;
      yield { updatedAt, texts };
    }
  };
}

describe("memory.notes.store", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-notes-store-tool-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists a note and tags it with the runtime context", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 4_000 });
    const result = await tool.run(
      { content: "remember this", tags: ["example"] },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.stored).toBe(true);
    const saved = store.get(result.details.id as number);
    expect(saved?.content).toBe("remember this");
    expect(saved?.workingDir).toBe("/work");
    expect(saved?.sessionId).toBe("s1");
    expect(saved?.source).toBe("agent");
    expect(saved?.tags).toEqual(["example"]);
  });

  it("returns an error tool-result for empty content", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 4_000 });
    const result = await tool.run({ content: "" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("content");
  });

  it("rejects content over the per-call cap without persisting", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 10 });
    const result = await tool.run({ content: "x".repeat(50) }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("content");
    expect(store.count()).toBe(0);
  });

  it("surfaces tag validation errors as tool-result errors", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 4_000 });
    const result = await tool.run({ content: "ok", tags: [""] }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("tags");
  });

  // ATO-200: the agent stored "Пользователь Анна…" for a user who never
  // wrote that name. The note is kept, but tagged and flagged.
  describe("a note that names the user", () => {
    it("keeps a note with an invented name, tagged, and tells the model", async () => {
      const tool = buildNotesStoreTool({
        store,
        maxContentChars: 4_000,
        groundingSource: storedSessions(["сделай макет"]),
      });
      const result = await tool.run(
        { content: "Пользователь Анна просит отвечать кратко", tags: ["style"] },
        makeCtx(["Отвечай кратко, пожалуйста"]),
      );
      expect(result.status).toBe("ok");
      const saved = store.get(result.details.id as number);
      expect(saved?.content).toBe("Пользователь Анна просит отвечать кратко");
      expect(saved?.tags).toEqual(["style", UNCONFIRMED_NAME_TAG]);
      expect(result.details.unconfirmedNames).toEqual(["Анна"]);
      expect(result.summary).toMatch(/has not written the name "Анна"/);
    });

    it("does not flag a name the user gave, in this or an earlier session", async () => {
      const tool = buildNotesStoreTool({
        store,
        maxContentChars: 4_000,
        groundingSource: storedSessions(["Меня зовут Надя"]),
      });
      const here = await tool.run(
        { content: "The user is Nadia and prefers short answers." },
        makeCtx(["I'm Nadia, keep it short"]),
      );
      expect(here.details.unconfirmedNames).toBeUndefined();
      const earlier = await tool.run(
        { content: "Пользователь Надя просит отвечать кратко" },
        makeCtx(["Отвечай кратко"]),
      );
      expect(earlier.details.unconfirmedNames).toBeUndefined();
      expect(store.get(earlier.details.id as number)?.tags).toEqual([]);
    });

    it("does not let the note vouch for the name in memory.profile.set", async () => {
      const profile = new ProfileStore({ dbFile: join(tmp, "profile.sqlite") });
      try {
        const source = storedSessions(["сделай макет"]);
        const notes = buildNotesStoreTool({ store, maxContentChars: 4_000, groundingSource: source });
        await notes.run({ content: "Пользователь Анна любит краткость" }, makeCtx([]));
        const set = buildProfileSetTool({ store: profile, groundingSource: source });
        const result = await set.run({ key: "name", value: "Анна" }, makeCtx([]));
        expect(result.status).toBe("error");
        expect(profile.get("name")).toBeNull();
      } finally {
        profile.close();
      }
    });
  });
});

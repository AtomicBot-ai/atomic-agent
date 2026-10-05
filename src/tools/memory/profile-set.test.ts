import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { ProfileStore } from "../../memory/profile-store.js";
import type {
  GroundingConversation,
  GroundingConversationSource,
} from "../../memory/name-grounding.js";
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

/** Stored sessions, newest first; counts the walks it serves. */
function storedSessions(...sessions: string[][]): GroundingConversationSource & {
  walks: number;
} {
  const source = Object.assign(
    async function* walk(): AsyncGenerator<GroundingConversation> {
      source.walks += 1;
      let updatedAt = 10_000;
      for (const texts of sessions) {
        updatedAt -= 1;
        yield { updatedAt, texts };
      }
    },
    { walks: 0 },
  );
  return source;
}

describe("memory.profile.set", () => {
  let tmp: string;
  let store: ProfileStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-tool-profile-"));
    store = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upserts a fact and persists it in the store", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run({ key: "language", value: "ru" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.key).toBe("language");
    expect(result.details.value).toBe("ru");
    expect(result.details.updated).toBe(true);
    expect(store.get("language")?.value).toBe("ru");
  });

  it("returns an error tool-result for invalid keys", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run({ key: "has space", value: "x" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("key");
  });

  it("returns an error tool-result for empty values", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run({ key: "ok", value: "" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("value");
  });

  it("defaults pinned=true when the flag is omitted", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run({ key: "language", value: "ru" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.pinned).toBe(true);
    expect(result.details.keywords).toEqual([]);
    expect(store.get("language")?.pinned).toBe(true);
  });

  it("persists pinned=false contextual facts with keywords", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run(
      {
        key: "deploy_cmd",
        value: "pnpm run deploy",
        pinned: false,
        keywords: ["deploy", "release"],
      },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.pinned).toBe(false);
    expect(result.details.keywords).toEqual(["deploy", "release"]);
    const saved = store.get("deploy_cmd");
    expect(saved?.pinned).toBe(false);
    expect(saved?.keywords).toEqual(["deploy", "release"]);
  });

  it("rejects non-boolean pinned", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run(
      { key: "x", value: "y", pinned: "true" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
  });

  it("rejects non-array keywords", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run(
      { key: "x", value: "y", pinned: false, keywords: "deploy" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
  });

  // ATO-200: the agent saw an invented "Анна" in its profile and stored
  // it again. A name is written only when the user wrote it.
  describe("name keys", () => {
    it("refuses a name the user never wrote, with an error that says to ask", async () => {
      const tool = buildProfileSetTool({
        store,
        groundingSource: storedSessions(["сделай макет"], ["Отвечай на русском"]),
      });
      const result = await tool.run(
        { key: "name", value: "Анна" },
        makeCtx(["Привет! Сделай отчёт"]),
      );
      expect(result.status).toBe("error");
      expect(result.details.reason).toBe("name_not_written_by_user");
      expect(result.summary).toMatch(/has not written the name "Анна"/);
      expect(result.summary).toMatch(/ask the user/);
      expect(store.get("name")).toBeNull();
    });

    it("writes a name from the current session and marks it grounded", async () => {
      const source = storedSessions();
      const tool = buildProfileSetTool({ store, groundingSource: source });
      const result = await tool.run(
        { key: "name", value: "Nadya" },
        makeCtx(["Меня зовут Надя"]),
      );
      expect(result.status).toBe("ok");
      expect(store.get("name")?.nameGrounding).toBe("grounded");
      // Found in this session: no walk over the stored ones.
      expect(source.walks).toBe(0);
    });

    // The retry trap: a name the user gave in an earlier session must not
    // be refused because this session never repeats it.
    it("accepts a name the user gave in an earlier session", async () => {
      const tool = buildProfileSetTool({
        store,
        groundingSource: storedSessions(["сделай макет"], ["Зови меня Надей"]),
      });
      const result = await tool.run(
        { key: "first_name", value: "Надя" },
        makeCtx(["Как меня зовут?"]),
      );
      expect(result.status).toBe("ok");
      expect(store.get("first_name")?.nameGrounding).toBe("grounded");
    });

    it("fails open on a script it cannot compare, and says so on the row", async () => {
      const tool = buildProfileSetTool({ store, groundingSource: storedSessions() });
      const result = await tool.run(
        { key: "name", value: "Xiaoming" },
        makeCtx(["我叫小明，请记住"]),
      );
      expect(result.status).toBe("ok");
      expect(store.get("name")?.nameGrounding).toBe("unverifiable");
    });

    it("leaves non-name keys alone", async () => {
      const source = storedSessions();
      const tool = buildProfileSetTool({ store, groundingSource: source });
      const result = await tool.run(
        { key: "project_name_style", value: "Kebab" },
        makeCtx([]),
      );
      expect(result.status).toBe("ok");
      expect(source.walks).toBe(0);
    });

    it("writes the name unchecked when no source is wired", async () => {
      const tool = buildProfileSetTool({ store });
      const result = await tool.run({ key: "name", value: "Анна" }, makeCtx());
      expect(result.status).toBe("ok");
      expect(store.get("name")?.nameGrounding).toBeNull();
      expect(store.listForPrompt()).toEqual([]);
    });
  });
});

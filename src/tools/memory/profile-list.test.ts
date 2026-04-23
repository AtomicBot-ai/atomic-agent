import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { ProfileStore } from "../../memory/profile-store.js";
import { buildProfileListTool } from "./profile-list.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.profile.list", () => {
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

  it("returns an empty-profile marker when the store is empty", async () => {
    const tool = buildProfileListTool({ store });
    const result = await tool.run({}, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
    expect(result.details.facts).toEqual([]);
    expect(result.summary).toContain("(empty profile)");
  });

  it("returns every fact ordered by key", async () => {
    store.set("timezone", "UTC", 1_000);
    store.set("language", "ru", 2_000);
    const tool = buildProfileListTool({ store });
    const result = await tool.run({}, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(2);
    const facts = result.details.facts as Array<{ key: string; value: string }>;
    expect(facts.map((f) => f.key)).toEqual(["language", "timezone"]);
    expect(result.summary).toContain("- language: ru");
  });
});

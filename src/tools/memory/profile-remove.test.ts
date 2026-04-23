import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { ProfileStore } from "../../memory/profile-store.js";
import { buildProfileRemoveTool } from "./profile-remove.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.profile.remove", () => {
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

  it("removes an existing key", async () => {
    store.set("language", "ru");
    const tool = buildProfileRemoveTool({ store });
    const result = await tool.run({ key: "language" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.removed).toBe(true);
    expect(store.get("language")).toBeNull();
  });

  it("reports removed=false for missing keys without erroring", async () => {
    const tool = buildProfileRemoveTool({ store });
    const result = await tool.run({ key: "missing" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.removed).toBe(false);
  });

  it("surfaces validation errors for malformed keys", async () => {
    const tool = buildProfileRemoveTool({ store });
    const result = await tool.run({ key: "" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("key");
  });
});

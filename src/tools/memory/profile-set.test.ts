import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { ProfileStore } from "../../memory/profile-store.js";
import { buildProfileSetTool } from "./profile-set.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
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
    const result = await tool.run(
      { key: "language", value: "ru" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.key).toBe("language");
    expect(result.details.value).toBe("ru");
    expect(result.details.updated).toBe(true);
    expect(store.get("language")?.value).toBe("ru");
  });

  it("returns an error tool-result for invalid keys", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run(
      { key: "has space", value: "x" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("key");
  });

  it("returns an error tool-result for empty values", async () => {
    const tool = buildProfileSetTool({ store });
    const result = await tool.run(
      { key: "ok", value: "" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("value");
  });
});

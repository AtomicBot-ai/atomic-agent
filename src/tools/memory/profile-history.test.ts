import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { ProfileStore } from "../../memory/profile-store.js";
import { buildProfileHistoryTool } from "./profile-history.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.profile.history", () => {
  let tmp: string;
  let store: ProfileStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-tool-history-"));
    store = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty marker when no history exists", async () => {
    const tool = buildProfileHistoryTool({ store });
    const result = await tool.run({ key: "language" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
    expect(result.details.history).toEqual([]);
    expect(result.summary).toContain("no history");
  });

  it("returns the full chain in temporal order with the active row last", async () => {
    store.set("language", "ru", 1_000);
    store.set("language", "en", 2_000);
    const tool = buildProfileHistoryTool({ store });
    const result = await tool.run({ key: "language" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(2);
    const rows = result.details.history as Array<{
      value: string;
      active: boolean;
    }>;
    expect(rows.map((r) => r.value)).toEqual(["ru", "en"]);
    expect(rows[0]?.active).toBe(false);
    expect(rows[1]?.active).toBe(true);
    expect(result.summary).toContain("(active)");
  });

  it("returns an error result for a malformed key", async () => {
    const tool = buildProfileHistoryTool({ store });
    const result = await tool.run({ key: "has space" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("validation");
  });

  it("handles missing args gracefully", async () => {
    const tool = buildProfileHistoryTool({ store });
    const result = await tool.run({}, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("validation");
  });
});

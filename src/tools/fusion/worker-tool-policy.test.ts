import { describe, it, expect } from "vitest";
import {
  FUSION_WORKER_APPROVAL_REFUSED,
  WORKER_EXCLUDED_TOOLS,
  isWorkerVisibleTool,
} from "./worker-tool-policy.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";

describe("worker tool policy", () => {
  it("every excluded name is a real default descriptor, except the not-yet-registered fusion.delegate", () => {
    const known = new Set(DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name));
    for (const name of WORKER_EXCLUDED_TOOLS) {
      if (name === "fusion.delegate") continue;
      expect(known.has(name), `${name} is not a default tool descriptor`).toBe(true);
    }
    // Pinned even though PR 5 has not registered it: the day it lands,
    // a worker must already be unable to fan out again.
    expect(WORKER_EXCLUDED_TOOLS.has("fusion.delegate")).toBe(true);
    expect(isWorkerVisibleTool("fusion.delegate")).toBe(false);
  });

  it("hides exactly the delegation, session-ending, scheduling and memory-writing tools", () => {
    expect([...WORKER_EXCLUDED_TOOLS].sort()).toEqual(
      [
        "finish",
        "fusion.delegate",
        "memory.notes.forget",
        "memory.notes.store",
        "memory.profile.remove",
        "memory.profile.set",
        "tasks.cancel",
        "tasks.cron",
        "tasks.schedule",
      ].sort(),
    );
  });

  it("keeps every read, browser, os, skill and listing tool visible", () => {
    for (const name of [
      "reply",
      "os.fs.read",
      "os.fs.write",
      "os.shell.run",
      "browser.navigate",
      "skill.load",
      "tasks.list",
      "tasks.show",
      "memory.notes.recall",
      "memory.profile.list",
      "memory.profile.history",
      "memory.lessons.recall",
      "mcp.resource.read",
    ]) {
      expect(isWorkerVisibleTool(name), name).toBe(true);
    }
  });

  it("the refusal reason tells the model to hand the action back up", () => {
    expect(FUSION_WORKER_APPROVAL_REFUSED).toMatch(/operator approval/);
    expect(FUSION_WORKER_APPROVAL_REFUSED).toMatch(/orchestrator/);
  });
});

import { describe, it, expect } from "vitest";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import {
  isBatchable,
  isParallelWithinGroup,
  listKnownToolResourceClasses,
  resourceClassFor,
  type ResourceClass,
} from "./tool-resource-class.js";

describe("tool-resource-class", () => {
  it("every default tool descriptor has an explicit resource class", () => {
    const missing: string[] = [];
    for (const d of DEFAULT_TOOL_DESCRIPTORS) {
      const cls = resourceClassFor(d.name);
      if (cls === "unknown") missing.push(d.name);
    }
    expect(missing, `tools missing a class: ${missing.join(", ")}`).toEqual([]);
  });

  it("returns 'unknown' for an unregistered tool name (fail-closed)", () => {
    expect(resourceClassFor("never.heard.of.this")).toBe("unknown");
  });

  it("classifies terminal verbs as 'terminal'", () => {
    expect(resourceClassFor("reply")).toBe("terminal");
    expect(resourceClassFor("finish")).toBe("terminal");
  });

  it("classifies approval-gated tools as 'approval_gated'", () => {
    const expected = [
      "os.shell.run",
      "os.fs.write",
      "os.fs.edit",
      "os.fs.trash",
      "os.fs.patch",
      "os.fs.archive.extract",
      "os.proc.kill",
      "os.http.request",
      "skill.run_script",
    ] as const;
    for (const name of expected) {
      expect(resourceClassFor(name)).toBe("approval_gated");
    }
  });

  it("classifies all browser.* tools under 'browser'", () => {
    const browserTools = Object.keys(listKnownToolResourceClasses()).filter(
      (n) => n.startsWith("browser."),
    );
    expect(browserTools.length).toBeGreaterThan(0);
    for (const name of browserTools) {
      expect(resourceClassFor(name)).toBe("browser");
    }
  });

  it("isBatchable rejects approval_gated, terminal and unknown", () => {
    const cases: Array<[ResourceClass, boolean]> = [
      ["pure_read", true],
      ["fs_write", true],
      ["browser", true],
      ["memory_write", true],
      ["tasks_write", true],
      ["vision", true],
      ["approval_gated", false],
      ["terminal", false],
      ["unknown", false],
    ];
    for (const [cls, expected] of cases) {
      expect(isBatchable(cls), `isBatchable(${cls})`).toBe(expected);
    }
  });

  it("isParallelWithinGroup is true only for pure_read", () => {
    expect(isParallelWithinGroup("pure_read")).toBe(true);
    expect(isParallelWithinGroup("browser")).toBe(false);
    expect(isParallelWithinGroup("memory_write")).toBe(false);
    expect(isParallelWithinGroup("vision")).toBe(false);
  });
});

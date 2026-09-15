import { describe, it, expect } from "vitest";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import {
  approvalCategoriesFor,
  gatedCallRunsUnattended,
  isBatchable,
  isParallelWithinGroup,
  isSoloRegardlessOfApproval,
  listApprovalCategoriesByTool,
  listKnownToolResourceClasses,
  resourceClassFor,
  setDynamicResourceClassResolver,
  type ResourceClass,
} from "./tool-resource-class.js";

describe("gated-call approval categories", () => {
  it("every static approval_gated tool has categories or is solo for another reason", () => {
    const undecided = Object.entries(listKnownToolResourceClasses())
      .filter(([, cls]) => cls === "approval_gated")
      .map(([name]) => name)
      .filter(
        (name) =>
          approvalCategoriesFor(name) === null &&
          !isSoloRegardlessOfApproval(name),
      );
    expect(undecided).toEqual([]);
  });

  it("lists categories only for tools that are actually approval_gated", () => {
    for (const name of Object.keys(listApprovalCategoriesByTool())) {
      expect(resourceClassFor(name), name).toBe("approval_gated");
    }
  });

  it("level 5 runs every categorised gated tool unattended", () => {
    for (const name of Object.keys(listApprovalCategoriesByTool())) {
      expect(gatedCallRunsUnattended(name, { level: 5 }), name).toBe(true);
    }
  });

  it("keeps fs writes gated below level 5 — the target may be the trust config", () => {
    for (const level of [1, 2, 3, 4] as const) {
      expect(gatedCallRunsUnattended("os.fs.write", { level })).toBe(false);
      expect(gatedCallRunsUnattended("os.git.commit", { level })).toBe(false);
    }
    // A workspace-write grant cannot silence `trust_config`.
    expect(
      gatedCallRunsUnattended("os.fs.write", {
        level: 4,
        grantedCategories: ["fs_write_workspace", "fs_write_home", "other"],
      }),
    ).toBe(false);
  });

  it("follows the ladder for single-category tools", () => {
    expect(gatedCallRunsUnattended("os.shell.run", { level: 3 })).toBe(false);
    expect(gatedCallRunsUnattended("os.shell.run", { level: 4 })).toBe(true);
    expect(gatedCallRunsUnattended("os.http.request", { level: 3 })).toBe(true);
    expect(gatedCallRunsUnattended("os.email.send", { level: 4 })).toBe(false);
  });

  it("honours a session category grant, but never for a non-grantable category", () => {
    expect(
      gatedCallRunsUnattended("os.shell.run", {
        level: 1,
        grantedCategories: ["shell"],
      }),
    ).toBe(true);
    expect(
      gatedCallRunsUnattended("os.email.send", {
        level: 1,
        grantedCategories: ["email"],
      }),
    ).toBe(false);
  });

  it("never runs fusion.delegate or an uncategorised tool unattended", () => {
    expect(gatedCallRunsUnattended("fusion.delegate", { level: 5 })).toBe(
      false,
    );
    expect(gatedCallRunsUnattended("never.heard.of.this", { level: 5 })).toBe(
      false,
    );
  });

  it("treats a gated MCP tool as category `other`", () => {
    setDynamicResourceClassResolver((name) =>
      name.startsWith("mcp.demo.") ? "approval_gated" : null,
    );
    try {
      expect(approvalCategoriesFor("mcp.demo.write")).toEqual(["other"]);
      expect(gatedCallRunsUnattended("mcp.demo.write", { level: 5 })).toBe(
        true,
      );
      expect(gatedCallRunsUnattended("mcp.demo.write", { level: 4 })).toBe(
        false,
      );
    } finally {
      setDynamicResourceClassResolver(null);
    }
  });
});

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
      "os.git.init",
      "os.git.add",
      "os.git.commit",
      "os.git.checkout",
      "os.proc.kill",
      "os.http.request",
      "skill.run_script",
      "os.git.remote",
      "os.git.fetch",
      "os.git.pull",
      "os.git.push",
      "os.git.clone",
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

import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { resourceClassFor } from "../agent/tool-resource-class.js";
import { WORKER_EXCLUDED_TOOLS } from "./fusion/worker-tool-policy.js";
import {
  TOOL_ROLES,
  descriptorsForRole,
  partitionByRole,
  roleAdmits,
} from "./tool-roles.js";

describe("tool roles", () => {
  it("builder: files in and out, a shell, the checks, the discovery tools, MCP, reply", () => {
    for (const name of [
      "os.fs.read",
      "os.fs.read_document",
      "os.fs.write",
      "os.fs.edit",
      "os.fs.patch",
      "os.fs.restore",
      "os.fs.list",
      "os.fs.glob",
      "os.fs.grep",
      "os.fs.hash",
      "os.fs.diff",
      "os.fs.watch",
      "os.shell.run",
      // From another package; a role tolerates a name this build lacks.
      "verify.syntax",
      "verify.run",
      "tool.view",
      "skill.view",
      "reply",
      "mcp.resource.read",
      "mcp.notion.search",
    ]) {
      expect(roleAdmits("builder", name), name).toBe(true);
    }
    for (const name of [
      "finish",
      "fusion.delegate",
      "tasks.schedule",
      "tasks.list",
      "memory.notes.store",
      "memory.notes.recall",
      "browser.navigate",
      "os.fs.trash",
      "os.git.commit",
      "os.web.search",
      "vision.describe",
    ]) {
      expect(roleAdmits("builder", name), name).toBe(false);
    }
  });

  it("orchestrator: read-only files, the checks, the fan-out, memory reads, both terminals — never a build tool", () => {
    for (const name of [
      "os.fs.read",
      "os.fs.read_document",
      "os.fs.list",
      "os.fs.glob",
      "os.fs.grep",
      "os.fs.hash",
      "os.fs.diff",
      "os.fs.locate_project",
      "os.fs.archive.list",
      "verify.syntax",
      "verify.run",
      "fusion.delegate",
      "tool.view",
      "memory.profile.list",
      "memory.profile.history",
      "memory.notes.recall",
      "memory.lessons.recall",
      "memory.procedures.recall",
      "reply",
      "finish",
    ]) {
      expect(roleAdmits("orchestrator", name), name).toBe(true);
    }
    for (const name of [
      "os.fs.write",
      "os.fs.edit",
      "os.fs.patch",
      "os.fs.restore",
      "os.shell.run",
      "skill.view",
      "mcp.resource.read",
      "mcp.notion.search",
      "memory.notes.store",
      "browser.navigate",
      "tasks.schedule",
    ]) {
      expect(roleAdmits("orchestrator", name), name).toBe(false);
    }
  });

  it("orchestrator: every registered tool it admits is a pure read or a terminal, bar the fan-out itself", () => {
    // The fusion gate refuses every mutation on an orchestrator turn; a
    // role that listed one would only advertise a refusal. Checked
    // against the resource-class map rather than a hand list so a new
    // descriptor cannot slip in unclassified.
    for (const d of DEFAULT_TOOL_DESCRIPTORS) {
      if (!roleAdmits("orchestrator", d.name)) continue;
      if (d.name === "fusion.delegate") continue;
      // `verify.run` executes a command, so it is approval-gated below
      // level 4 — but it runs against a throwaway copy of the workspace,
      // which is why the fusion gate admits it as a read (`readonly`).
      if (d.name === "verify.run") continue;
      expect(resourceClassFor(d.name), d.name).toMatch(/^(pure_read|terminal)$/);
    }
  });

  it("full admits everything, and the role list is closed", () => {
    for (const d of DEFAULT_TOOL_DESCRIPTORS) {
      expect(roleAdmits("full", d.name), d.name).toBe(true);
    }
    expect(roleAdmits("full", "anything.at.all")).toBe(true);
    expect([...TOOL_ROLES].sort()).toEqual(["builder", "full", "orchestrator"]);
  });

  it("the worker exclusions are all outside builder — the filter is the harder line under the role", () => {
    for (const name of WORKER_EXCLUDED_TOOLS) {
      expect(roleAdmits("builder", name), name).toBe(false);
    }
  });

  it("partitionByRole puts everything inside for full and for no role", () => {
    for (const role of ["full", undefined] as const) {
      const { inRole, outside } = partitionByRole(role, DEFAULT_TOOL_DESCRIPTORS);
      expect(inRole).toEqual([...DEFAULT_TOOL_DESCRIPTORS]);
      expect(outside).toEqual([]);
    }
    const { inRole, outside } = partitionByRole("builder", DEFAULT_TOOL_DESCRIPTORS);
    expect(inRole.length + outside.length).toBe(DEFAULT_TOOL_DESCRIPTORS.length);
    expect(inRole.map((d) => d.name)).toContain("os.fs.write");
    expect(outside.map((d) => d.name)).toContain("tasks.schedule");
    // Order within each half is the catalog's order.
    const names = DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name);
    expect(inRole.map((d) => names.indexOf(d.name))).toEqual(
      inRole.map((d) => names.indexOf(d.name)).sort((a, b) => a - b),
    );
  });

  it("descriptorsForRole keeps a loaded tool from outside the role", () => {
    const loaded = new Set(["tasks.schedule"]);
    const names = descriptorsForRole("builder", DEFAULT_TOOL_DESCRIPTORS, loaded).map(
      (d) => d.name,
    );
    expect(names).toContain("tasks.schedule");
    expect(names).toContain("os.fs.write");
    expect(names).not.toContain("tasks.cron");
    // `full` is the same array, not a copy — the adapter memo keys on identity.
    expect(descriptorsForRole("full", DEFAULT_TOOL_DESCRIPTORS, loaded)).toBe(
      DEFAULT_TOOL_DESCRIPTORS,
    );
  });
});

import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import {
  GATED_TOOL_NAMES,
  filterToolDescriptorsByConfig,
  type ToolGateConfig,
} from "./filter-disabled-tools.js";

const ALL_OPEN: ToolGateConfig = {
  browser: { enabled: true },
  web: { search: { enabled: true } },
  vision: { enabled: true, providerAvailable: true },
  memory: {
    profile: { enabled: true },
    notes: { enabled: true },
    lessons: { enabled: true },
    procedures: { enabled: true },
  },
  tasks: { agentToolsEnabled: true },
  mcp: { enabled: true },
};

function nameSet(
  result: readonly { name: string }[] | ReturnType<typeof filterToolDescriptorsByConfig>,
): Set<string> {
  return new Set(Array.from(result, (d) => d.name));
}

describe("filterToolDescriptorsByConfig", () => {
  it("returns the input unchanged when every gate is open", () => {
    const filtered = filterToolDescriptorsByConfig(
      DEFAULT_TOOL_DESCRIPTORS,
      ALL_OPEN,
    );
    expect(filtered).toBe(DEFAULT_TOOL_DESCRIPTORS);
  });

  it("drops every browser.* descriptor when the browser is disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      browser: { enabled: false },
    });
    const names = nameSet(filtered);
    for (const dropped of GATED_TOOL_NAMES.browser) {
      expect(names.has(dropped)).toBe(false);
    }
    // non-browser web tools survive so the model still has os.web.search/fetch
    expect(names.has("os.web.search")).toBe(true);
    expect(names.has("os.web.fetch")).toBe(true);
  });

  it("drops os.web.search when native web search is disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      web: { search: { enabled: false } },
    });
    expect(nameSet(filtered).has("os.web.search")).toBe(false);
    expect(nameSet(filtered).has("os.web.fetch")).toBe(true);
  });

  it("drops vision.describe when vision is disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      vision: { enabled: false, providerAvailable: true },
    });
    expect(nameSet(filtered).has("vision.describe")).toBe(false);
  });

  it("drops vision.describe when no provider is available even if enabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      vision: { enabled: true, providerAvailable: false },
    });
    expect(nameSet(filtered).has("vision.describe")).toBe(false);
  });

  it("drops every memory.profile.* descriptor when profile is disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      memory: { ...ALL_OPEN.memory, profile: { enabled: false } },
    });
    const names = nameSet(filtered);
    for (const dropped of GATED_TOOL_NAMES.memoryProfile) {
      expect(names.has(dropped)).toBe(false);
    }
    expect(names.has("memory.notes.store")).toBe(true);
  });

  it("drops every memory.notes.* descriptor when notes are disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      memory: { ...ALL_OPEN.memory, notes: { enabled: false } },
    });
    const names = nameSet(filtered);
    for (const dropped of GATED_TOOL_NAMES.memoryNotes) {
      expect(names.has(dropped)).toBe(false);
    }
  });

  it("drops memory.lessons.recall when lessons are disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      memory: { ...ALL_OPEN.memory, lessons: { enabled: false } },
    });
    expect(nameSet(filtered).has("memory.lessons.recall")).toBe(false);
  });

  it("drops memory.procedures.recall when procedures are disabled (default)", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      memory: { ...ALL_OPEN.memory, procedures: { enabled: false } },
    });
    expect(nameSet(filtered).has("memory.procedures.recall")).toBe(false);
  });

  it("drops every tasks.* descriptor when agent tools are disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      tasks: { agentToolsEnabled: false },
    });
    const names = nameSet(filtered);
    for (const dropped of GATED_TOOL_NAMES.tasks) {
      expect(names.has(dropped)).toBe(false);
    }
  });

  it("drops every mcp.* aggregate descriptor when mcp is disabled", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      ...ALL_OPEN,
      mcp: { enabled: false },
    });
    const names = nameSet(filtered);
    for (const dropped of GATED_TOOL_NAMES.mcp) {
      expect(names.has(dropped)).toBe(false);
    }
  });

  it("drops everything gated when every switch is off", () => {
    const filtered = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      browser: { enabled: false },
      web: { search: { enabled: false } },
      vision: { enabled: false, providerAvailable: false },
      memory: {
        profile: { enabled: false },
        notes: { enabled: false },
        lessons: { enabled: false },
        procedures: { enabled: false },
      },
      tasks: { agentToolsEnabled: false },
      mcp: { enabled: false },
    });
    const names = nameSet(filtered);
    const allGated = [
      ...GATED_TOOL_NAMES.browser,
      ...GATED_TOOL_NAMES.webSearch,
      ...GATED_TOOL_NAMES.vision,
      ...GATED_TOOL_NAMES.memoryProfile,
      ...GATED_TOOL_NAMES.memoryNotes,
      ...GATED_TOOL_NAMES.memoryLessons,
      ...GATED_TOOL_NAMES.memoryProcedures,
      ...GATED_TOOL_NAMES.tasks,
      ...GATED_TOOL_NAMES.mcp,
    ];
    for (const dropped of allGated) {
      expect(names.has(dropped)).toBe(false);
    }
    expect(filtered.length).toBeLessThan(DEFAULT_TOOL_DESCRIPTORS.length);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it("every gated tool name exists in DEFAULT_TOOL_DESCRIPTORS", () => {
    const known = new Set(DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name));
    const allGated = [
      ...GATED_TOOL_NAMES.browser,
      ...GATED_TOOL_NAMES.webSearch,
      ...GATED_TOOL_NAMES.vision,
      ...GATED_TOOL_NAMES.memoryProfile,
      ...GATED_TOOL_NAMES.memoryNotes,
      ...GATED_TOOL_NAMES.memoryLessons,
      ...GATED_TOOL_NAMES.memoryProcedures,
      ...GATED_TOOL_NAMES.tasks,
      ...GATED_TOOL_NAMES.mcp,
    ];
    for (const name of allGated) {
      expect(known.has(name)).toBe(true);
    }
  });
});

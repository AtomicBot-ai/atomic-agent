import { describe, expect, it } from "vitest";

import { buildStablePrefix, type CapabilitiesSummary, type ToolDescriptor } from "./stable-prefix.js";
import {
  describePrefixSection,
  diffStablePrefixSections,
  hashStablePrefixSections,
  PREFIX_HEAD_SECTION,
  splitStablePrefixSections,
} from "./stable-prefix-sections.js";

const CAPS: CapabilitiesSummary = {
  platform: "linux",
  arch: "x64",
  browserChannel: "none",
  workingDir: "/repo",
  hasClipboard: false,
  hasWmctrl: false,
  hasNotifications: false,
};

const READ: ToolDescriptor = { name: "os.fs.read", summary: "Read a file.", argsSchema: "{ path: string }" };

function prefix(over: { tools?: ToolDescriptor[]; skills?: { name: string; description: string }[] } = {}): string {
  return buildStablePrefix({
    toolDescriptors: over.tools ?? [READ],
    capabilities: CAPS,
    skillCatalog: (over.skills ?? []).map((s) => ({ ...s, source: "global" as const })),
  });
}

describe("splitStablePrefixSections (ATO-316)", () => {
  it("names every ### block of a real prefix, in order, with no empty head", () => {
    const names = splitStablePrefixSections(prefix()).map((s) => s.name);
    expect(names).toEqual(["system", "rules", "skills", "tools", "capabilities", "instructions"]);
  });

  it("keeps text before the first header as its own head section", () => {
    const sections = splitStablePrefixSections("<|turn>system\n### system\npersona\n### rules\nr");
    expect(sections.map((s) => s.name)).toEqual([PREFIX_HEAD_SECTION, "system", "rules"]);
    expect(sections[1]!.text).toBe("persona");
  });

  it("does not treat a header-looking line with extra words as a boundary", () => {
    const sections = splitStablePrefixSections("### system\n### not a header\nx");
    expect(sections).toHaveLength(1);
  });
});

describe("diffStablePrefixSections (ATO-316)", () => {
  it("is empty for the same prefix", () => {
    expect(diffStablePrefixSections(hashStablePrefixSections(prefix()), hashStablePrefixSections(prefix()))).toEqual([]);
  });

  it("names only the tool catalog when a tool description changes", () => {
    const before = hashStablePrefixSections(prefix());
    const after = hashStablePrefixSections(
      prefix({ tools: [{ ...READ, summary: "Read a file. Now 12:00:01." }] }),
    );
    expect(diffStablePrefixSections(before, after)).toEqual(["tools"]);
  });

  it("names only skills when the skill list is reordered", () => {
    const a = { name: "a", description: "first" };
    const b = { name: "b", description: "second" };
    const before = hashStablePrefixSections(prefix({ skills: [a, b] }));
    const after = hashStablePrefixSections(prefix({ skills: [b, a] }));
    expect(diffStablePrefixSections(before, after)).toEqual(["skills"]);
  });

  it("counts an added and a removed section as changed", () => {
    expect(diffStablePrefixSections({ system: "1" }, { system: "1", fusion: "2" })).toEqual(["fusion"]);
    expect(diffStablePrefixSections({ system: "1", fusion: "2" }, { system: "1" })).toEqual(["fusion"]);
  });

  it("keeps a repeated header from hiding the first copy", () => {
    const hashes = hashStablePrefixSections("### tools\na\n### tools\nb");
    expect(Object.keys(hashes)).toEqual(["tools", "tools#2"]);
  });
});

describe("describePrefixSection", () => {
  it("uses the words from the issue for the main sections", () => {
    expect(describePrefixSection("system")).toBe("persona");
    expect(describePrefixSection("tools")).toBe("tool catalog");
    expect(describePrefixSection("tools#2")).toBe("tool catalog");
    expect(describePrefixSection("skills")).toBe("skills");
    expect(describePrefixSection("instructions")).toBe("instructions");
    expect(describePrefixSection("something-new")).toBe("something-new");
  });
});

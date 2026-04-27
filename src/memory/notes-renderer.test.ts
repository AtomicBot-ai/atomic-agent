import { describe, expect, it } from "vitest";

import type { MemoryEntry, MemoryIndexEntry } from "./memory-store.js";
import {
  renderMemoryIndexSection,
  renderRecalledLine,
  renderRecalledSection,
} from "./notes-renderer.js";

function mkEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 1,
    content: "body",
    createdAt: 0,
    updatedAt: 0,
    source: "agent",
    sessionId: null,
    workingDir: null,
    tags: [],
    ...overrides,
  };
}

function mkIndexEntry(overrides: Partial<MemoryIndexEntry>): MemoryIndexEntry {
  return {
    id: 1,
    preview: "preview",
    tags: [],
    updatedAt: 0,
    workingDir: null,
    sessionId: null,
    ...overrides,
  };
}

describe("renderRecalledSection", () => {
  it("emits a sentinel when there is nothing to recall", () => {
    expect(renderRecalledSection([], { previewChars: 80 })).toBe(
      "(no notes recalled)",
    );
  });

  it("renders id, tags, and content preview per entry", () => {
    const out = renderRecalledSection(
      [
        mkEntry({ id: 42, content: "project uses pnpm", tags: ["tooling"] }),
        mkEntry({ id: 17, content: "prefer terse replies" }),
      ],
      { previewChars: 80 },
    );
    expect(out).toBe(
      "- #42 [tooling] project uses pnpm\n- #17 prefer terse replies",
    );
  });

  it("collapses whitespace and clips long previews with an ellipsis", () => {
    const longText = "line1\n\nline2 with " + "x".repeat(200);
    const out = renderRecalledSection(
      [mkEntry({ id: 1, content: longText })],
      { previewChars: 20 },
    );
    expect(out.startsWith("- #1 ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("renders a single line through renderRecalledLine", () => {
    expect(
      renderRecalledLine(
        mkEntry({ id: 7, tags: ["a", "b"], content: "hello" }),
        80,
      ),
    ).toBe("- #7 [a, b] hello");
  });
});

describe("renderMemoryIndexSection", () => {
  it("emits a sentinel for an empty index", () => {
    expect(renderMemoryIndexSection([])).toBe("(no memory index)");
  });

  it("emits one line per index entry with id, tags, preview", () => {
    const out = renderMemoryIndexSection([
      mkIndexEntry({ id: 100, preview: "project uses pnpm", tags: ["tooling"] }),
      mkIndexEntry({ id: 101, preview: "prefer terse replies" }),
    ]);
    expect(out).toBe(
      "- #100 [tooling] project uses pnpm\n- #101 prefer terse replies",
    );
  });

  it("sorts by id ascending so order is deterministic regardless of input order", () => {
    const a = renderMemoryIndexSection([
      mkIndexEntry({ id: 101, preview: "second" }),
      mkIndexEntry({ id: 100, preview: "first" }),
    ]);
    const b = renderMemoryIndexSection([
      mkIndexEntry({ id: 100, preview: "first" }),
      mkIndexEntry({ id: 101, preview: "second" }),
    ]);
    expect(a).toBe(b);
    expect(a).toBe("- #100 first\n- #101 second");
  });
});

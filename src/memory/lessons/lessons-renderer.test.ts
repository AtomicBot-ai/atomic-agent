import { describe, expect, it } from "vitest";

import { renderLessonsSection } from "./lessons-renderer.js";

describe("renderLessonsSection", () => {
  it("returns null for an empty list", () => {
    expect(renderLessonsSection([])).toBeNull();
  });

  it("emits one line per lesson with `*id [tags] activation`", () => {
    const out = renderLessonsSection([
      {
        id: 7,
        activation: "When debugging slot allocation in llama-server",
        tags: ["llama", "debug"],
        workingDir: "/proj",
        updatedAt: 1,
      },
      {
        id: 8,
        activation: "When asked about pnpm",
        tags: [],
        workingDir: null,
        updatedAt: 2,
      },
    ]);
    expect(out).toBe(
      [
        `*7 [llama,debug] When debugging slot allocation in llama-server`,
        `*8 When asked about pnpm`,
      ].join("\n"),
    );
  });

  it("collapses newlines inside activation onto a single line", () => {
    const out = renderLessonsSection([
      {
        id: 1,
        activation: "line one\nline two",
        tags: [],
        workingDir: null,
        updatedAt: 1,
      },
    ]);
    expect(out).toBe(`*1 line one line two`);
  });

  it("never leaks the principle (LessonIndexEntry has no principle field)", () => {
    const out = renderLessonsSection([
      {
        id: 1,
        activation: "use pnpm",
        tags: ["tool"],
        workingDir: null,
        updatedAt: 1,
      },
    ]);
    expect(out).not.toContain("principle");
  });
});

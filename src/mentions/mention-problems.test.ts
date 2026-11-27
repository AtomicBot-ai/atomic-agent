import { describe, expect, it } from "vitest";
import { LSP_OFF_TEXT, NO_PROBLEMS_TEXT, NO_SERVER_TEXT, formatProblems } from "./mention-problems.js";

const at = (line: number) => ({ start: { line, character: 0 } });

describe("formatProblems", () => {
  it("says plainly when servers are off or none runs", () => {
    expect(formatProblems({ state: "off" })).toBe(`${LSP_OFF_TEXT}\n`);
    expect(formatProblems({ state: "no_server" })).toBe(`${NO_SERVER_TEXT}\n`);
    expect(LSP_OFF_TEXT.startsWith("No language server is running")).toBe(true);
  });

  it("says no problems found when the servers report none", () => {
    expect(formatProblems({ state: "ok", servers: ["typescript"], files: [] })).toBe(`${NO_PROBLEMS_TEXT} (checked by typescript)\n`);
  });

  it("lists errors before warnings with file, line and code", () => {
    const text = formatProblems({
      state: "ok",
      servers: ["typescript"],
      files: [
        { path: "src/b.ts", diagnostics: [{ range: at(4), severity: 2, message: "unused x" }] },
        { path: "src/a.ts", diagnostics: [{ range: at(9), severity: 1, code: 2322, source: "ts", message: "Type 'string' is not assignable" }] },
      ],
    });
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("1 error, 1 warning in 2 files (from typescript)");
    expect(lines[1]).toBe("src/a.ts:10:1 error [ts 2322] Type 'string' is not assignable");
    expect(lines[2]).toBe("src/b.ts:5:1 warning unused x");
  });

  it("caps the list and counts the rest", () => {
    const diagnostics = Array.from({ length: 5 }, (_, i) => ({ range: at(i), message: `e${i}` }));
    const text = formatProblems({ state: "ok", servers: ["pyright"], files: [{ path: "a.py", diagnostics }] }, 2);
    expect(text).toContain("… and 3 more");
    expect(text.trim().split("\n")).toHaveLength(4);
  });
});

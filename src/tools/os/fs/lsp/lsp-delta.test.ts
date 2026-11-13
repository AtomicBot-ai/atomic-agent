import { describe, expect, it } from "vitest";
import {
  formatNewErrors,
  joinWarnings,
  MAX_REPORTED_DIAGNOSTICS,
  newErrors,
  type LspDiagnostic,
} from "./lsp-delta.js";

function diag(
  line: number,
  message: string,
  extra: Partial<LspDiagnostic> = {},
): LspDiagnostic {
  return {
    range: { start: { line, character: 4 } },
    severity: 1,
    source: "typescript",
    code: 2322,
    message,
    ...extra,
  };
}

describe("newErrors (ATO-503)", () => {
  it("reports only errors the change added", () => {
    const old = diag(3, "Cannot find name 'foo'.", { code: 2304 });
    const added = diag(9, "Type 'string' is not assignable to type 'number'.");
    expect(newErrors([old], [old, added])).toEqual([added]);
  });

  it("treats an old error that moved to another line as old", () => {
    const before = diag(3, "Cannot find name 'foo'.", { code: 2304 });
    const moved = diag(12, "Cannot find name 'foo'.", { code: 2304 });
    expect(newErrors([before], [moved])).toEqual([]);
  });

  it("counts a second copy of an old error as new", () => {
    const one = diag(1, "Cannot find name 'foo'.", { code: 2304 });
    const two = diag(8, "Cannot find name 'foo'.", { code: 2304 });
    expect(newErrors([one], [one, two])).toEqual([two]);
  });

  it("ignores warnings, hints and information; a missing severity is an error", () => {
    const warning = diag(1, "'x' is declared but never read.", { severity: 2 });
    const hint = diag(2, "Unused.", { severity: 4 });
    const bare: LspDiagnostic = { message: "Expected ';'." };
    expect(newErrors([], [warning, hint, bare])).toEqual([bare]);
  });

  it("says nothing when the change fixed errors", () => {
    expect(newErrors([diag(1, "a"), diag(2, "b")], [diag(1, "a")])).toEqual([]);
  });

  it("tells errors with the same text but another code apart", () => {
    const a = diag(1, "Same text.", { code: 1 });
    const b = diag(1, "Same text.", { code: 2 });
    expect(newErrors([a], [b])).toEqual([b]);
  });
});

describe("formatNewErrors (ATO-503)", () => {
  it("is null when nothing is new", () => {
    expect(formatNewErrors("src/a.ts", "edit", "typescript", [])).toBeNull();
  });

  it("lists new errors by position, 1-based, with the code", () => {
    const text = formatNewErrors("src/a.ts", "edit", "typescript", [
      diag(9, "Second."),
      diag(2, "First.\nMore detail on a second line.", { code: "E1" }),
    ]);
    expect(text).toBe(
      [
        "⚠ src/a.ts: 2 new errors from typescript after this edit:",
        "  line 3:5 [E1] First.",
        "  line 10:5 [2322] Second.",
      ].join("\n"),
    );
  });

  it("caps the list and says how many more", () => {
    const many = Array.from({ length: MAX_REPORTED_DIAGNOSTICS + 3 }, (_, i) =>
      diag(i, `Error ${i}.`),
    );
    const text = formatNewErrors("a.py", "write", "pyright", many) ?? "";
    expect(text.split("\n")).toHaveLength(MAX_REPORTED_DIAGNOSTICS + 2);
    expect(text).toContain(`${MAX_REPORTED_DIAGNOSTICS + 3} new errors from pyright after this write`);
    expect(text.endsWith("  … and 3 more")).toBe(true);
  });

  it("uses the singular for one error and leaves out an empty code", () => {
    const text = formatNewErrors("a.py", "patch", "pyright", [
      { message: "\"foo\" is not defined", range: { start: { line: 0, character: 0 } } },
    ]);
    expect(text).toBe(
      "⚠ a.py: 1 new error from pyright after this patch:\n  line 1:1 \"foo\" is not defined",
    );
  });
});

describe("joinWarnings", () => {
  it("keeps the order and drops empty parts", () => {
    expect(joinWarnings("a", "b")).toBe("a\nb");
    expect(joinWarnings(null, "b")).toBe("b");
    expect(joinWarnings("a", null)).toBe("a");
    expect(joinWarnings("", null)).toBeNull();
  });
});

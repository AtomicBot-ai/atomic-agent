import { describe, expect, it } from "vitest";

import { parseNoteReconcileOutput } from "./note-reconcile-parser.js";

const allow = new Set([12, 15, 20]);

describe("parseNoteReconcileOutput (ATO-672)", () => {
  it("reads NONE and empty output as none", () => {
    expect(parseNoteReconcileOutput("NONE\n", { allowlist: allow })).toEqual({ kind: "none" });
    expect(parseNoteReconcileOutput("  ", { allowlist: allow })).toEqual({ kind: "none" });
  });

  it("reads SUPERSEDE lines, drops unknown ids and repeats, caps the count", () => {
    expect(
      parseNoteReconcileOutput("SUPERSEDE 12\nSUPERSEDE 99\nSUPERSEDE 12\nSUPERSEDE 15\nSUPERSEDE 20\n", {
        allowlist: allow,
        maxSupersede: 2,
      }),
    ).toEqual({ kind: "supersede", ids: [12, 15] });
  });

  it("lets DUPLICATE win over SUPERSEDE", () => {
    expect(
      parseNoteReconcileOutput("SUPERSEDE 12\nDUPLICATE 15\n", { allowlist: allow }),
    ).toEqual({ kind: "duplicate", id: 15 });
  });

  it("is none when every id is outside the allowlist", () => {
    expect(parseNoteReconcileOutput("SUPERSEDE 7\n", { allowlist: allow })).toEqual({ kind: "none" });
  });

  it("reads the Structured Outputs JSON shape", () => {
    expect(
      parseNoteReconcileOutput('{"kind":"decisions","decisions":[{"action":"SUPERSEDE","id":20}]}', {
        allowlist: allow,
      }),
    ).toEqual({ kind: "supersede", ids: [20] });
    expect(
      parseNoteReconcileOutput('{"kind":"none","decisions":[]}', { allowlist: allow }),
    ).toEqual({ kind: "none" });
  });
});

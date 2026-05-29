import { describe, expect, it } from "vitest";

import {
  parseDistillWithProcedureOutput,
} from "./distill-parser.js";

describe("parseDistillWithProcedureOutput", () => {
  it("parses a lesson-only output (procedure=null branch)", () => {
    const out = parseDistillWithProcedureOutput(
      `LESSON activation="When debugging flake"; principle="Re-run with headless=false."; tags=playwright,flake,debug\n`,
    );
    expect(out.kind).toBe("lesson");
    if (out.kind !== "lesson") return;
    expect(out.procedure).toBeNull();
    expect(out.activation).toBe("When debugging flake");
  });

  it("parses lesson + procedure together (scenario 7b.A)", () => {
    const out = parseDistillWithProcedureOutput(
      `LESSON activation="extract typescript signatures"; principle="Glob, grep, then summarise."; tags=typescript,export,glob\n` +
        `PROCEDURE activation="extract exported function signatures from a TypeScript file"; steps="glob TS files@os.fs.glob; grep export prefix@os.fs.grep; reply with file:line list@reply"; tags=typescript,export\n`,
    );
    expect(out.kind).toBe("lesson");
    if (out.kind !== "lesson") return;
    expect(out.procedure).not.toBeNull();
    expect(out.procedure!.activation).toContain("TypeScript");
    expect(out.procedure!.steps).toHaveLength(3);
    expect(out.procedure!.steps[0]).toEqual({
      description: "glob TS files",
      toolHint: "os.fs.glob",
    });
    expect(out.procedure!.steps[2]).toEqual({
      description: "reply with file:line list",
      toolHint: "reply",
    });
    expect(out.procedure!.tags).toEqual(["typescript", "export"]);
  });

  it("returns none-sentinel on abstain output", () => {
    const out = parseDistillWithProcedureOutput(
      `LESSON activation="(no consensus)"; principle="(no durable advice)"\n`,
    );
    expect(out.kind).toBe("none");
  });

  it("degrades to procedure=null on malformed PROCEDURE line", () => {
    const out = parseDistillWithProcedureOutput(
      `LESSON activation="a"; principle="b"; tags=a,b,c\n` +
        `PROCEDURE activation="bad"; steps="only one"\n`,
    );
    // Only one step ⇒ below minimum ⇒ procedure dropped, lesson kept.
    expect(out.kind).toBe("lesson");
    if (out.kind !== "lesson") return;
    expect(out.procedure).toBeNull();
  });

  it("rejects malformed @toolhint inside steps gracefully", () => {
    const out = parseDistillWithProcedureOutput(
      `LESSON activation="a"; principle="b"; tags=a,b,c\n` +
        `PROCEDURE activation="trigger"; steps="step one@bad hint with spaces; step two@os.fs.read"\n`,
    );
    expect(out.kind).toBe("lesson");
    if (out.kind !== "lesson") return;
    expect(out.procedure).toBeNull();
  });

  it("respects max step count (drops procedure when >8)", () => {
    const steps = Array.from({ length: 9 }, (_, i) => `step ${i}@os.fs.read`).join("; ");
    const out = parseDistillWithProcedureOutput(
      `LESSON activation="a"; principle="b"; tags=a,b,c\n` +
        `PROCEDURE activation="trigger"; steps="${steps}"\n`,
    );
    expect(out.kind).toBe("lesson");
    if (out.kind !== "lesson") return;
    expect(out.procedure).toBeNull();
  });

  it("parses steps without toolHint", () => {
    const out = parseDistillWithProcedureOutput(
      `LESSON activation="a"; principle="b"; tags=a,b,c\n` +
        `PROCEDURE activation="trigger"; steps="think about plan; do the plan"\n`,
    );
    expect(out.kind).toBe("lesson");
    if (out.kind !== "lesson") return;
    expect(out.procedure).not.toBeNull();
    expect(out.procedure!.steps).toEqual([
      { description: "think about plan", toolHint: null },
      { description: "do the plan", toolHint: null },
    ]);
  });

  describe("JSON shape (cloud Structured Outputs)", () => {
    it("parses kind=none on the JSON path", () => {
      const out = parseDistillWithProcedureOutput(
        JSON.stringify({ kind: "none" }),
      );
      expect(out).toEqual({ kind: "none" });
    });

    it("parses lesson with procedure=null on the JSON path", () => {
      const out = parseDistillWithProcedureOutput(
        JSON.stringify({
          kind: "lesson",
          activation: "a",
          principle: "p",
          tags: ["foo"],
          procedure: null,
        }),
      );
      expect(out.kind).toBe("lesson");
      if (out.kind !== "lesson") return;
      expect(out.procedure).toBeNull();
      expect(out.activation).toBe("a");
      expect(out.principle).toBe("p");
      expect(out.tags).toEqual(["foo"]);
    });

    it("parses lesson + procedure on the JSON path", () => {
      const out = parseDistillWithProcedureOutput(
        JSON.stringify({
          kind: "lesson",
          activation: "extract signatures",
          principle: "glob then grep",
          tags: ["typescript", "glob"],
          procedure: {
            activation: "want exported signatures",
            steps: [
              { description: "glob *.ts", tool_hint: "os.fs.glob" },
              { description: "grep export", tool_hint: "os.fs.grep" },
              { description: "summarise", tool_hint: null },
            ],
            tags: ["typescript"],
          },
        }),
      );
      expect(out.kind).toBe("lesson");
      if (out.kind !== "lesson") return;
      expect(out.activation).toBe("extract signatures");
      expect(out.procedure).not.toBeNull();
      expect(out.procedure!.activation).toBe("want exported signatures");
      expect(out.procedure!.steps).toEqual([
        { description: "glob *.ts", toolHint: "os.fs.glob" },
        { description: "grep export", toolHint: "os.fs.grep" },
        { description: "summarise", toolHint: null },
      ]);
      expect(out.procedure!.tags).toEqual(["typescript"]);
    });

    it("isolates a malformed procedure on the JSON path (lesson survives)", () => {
      const out = parseDistillWithProcedureOutput(
        JSON.stringify({
          kind: "lesson",
          activation: "a",
          principle: "p",
          tags: [],
          procedure: {
            activation: "act",
            // Only one step — below PROCEDURE_MIN_STEPS = 2.
            steps: [
              { description: "single step", tool_hint: null },
            ],
            tags: [],
          },
        }),
      );
      expect(out.kind).toBe("lesson");
      if (out.kind !== "lesson") return;
      expect(out.activation).toBe("a");
      expect(out.procedure).toBeNull();
    });

    it("rejects malformed tool_hint values into procedure=null", () => {
      const out = parseDistillWithProcedureOutput(
        JSON.stringify({
          kind: "lesson",
          activation: "a",
          principle: "p",
          tags: [],
          procedure: {
            activation: "act",
            steps: [
              { description: "ok step", tool_hint: "has spaces" },
              { description: "another", tool_hint: null },
            ],
            tags: [],
          },
        }),
      );
      expect(out.kind).toBe("lesson");
      if (out.kind !== "lesson") return;
      expect(out.procedure).toBeNull();
    });
  });
});

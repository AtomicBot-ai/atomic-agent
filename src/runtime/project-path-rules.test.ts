import { describe, expect, it } from "vitest";
import { ruleBody, rulePathPatterns } from "./project-path-rules.js";

describe("path-scoped rule frontmatter (ATO-2247)", () => {
  it("reads paths and globs in inline, comma-separated and block-list forms", () => {
    expect(rulePathPatterns("---\npaths: [\"*.sql\", 'db/**']\n---\nbody")).toEqual(["*.sql", "db/**"]);
    expect(rulePathPatterns("---\nglobs: *.ts, src/**/*.{ts,tsx}\nalwaysApply: false\n---\nbody")).toEqual(["*.ts", "src/**/*.{ts,tsx}"]);
    expect(rulePathPatterns("﻿---\r\npaths:\r\n  - \"*.sql\"\r\n  - migrations/** # comment\r\ndescription: db\r\n---\r\nbody")).toEqual(["*.sql", "migrations/**"]);
    expect(rulePathPatterns("---\nglobs: \"*.md\"\n---\nbody")).toEqual(["*.md"]);
  });

  it("finds no patterns without frontmatter, with empty keys or with only other keys", () => {
    expect(rulePathPatterns("paths: [\"*.sql\"]\nnot frontmatter")).toEqual([]);
    expect(rulePathPatterns("---\nglobs:\nalwaysApply: true\n---\nbody")).toEqual([]);
    expect(rulePathPatterns("---\ndescription: when editing docs\n---\nbody")).toEqual([]);
  });

  it("drops the frontmatter from the body", () => {
    expect(ruleBody("---\npaths: [\"*.sql\"]\n---\n\nUse snake_case.\n")).toBe("Use snake_case.");
    expect(ruleBody("﻿plain rule")).toBe("plain rule");
  });
});

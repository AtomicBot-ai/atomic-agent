import { describe, expect, it } from "vitest";
import {
  findTarget,
  normalizeScenarioName,
  paramNameFrom,
  parseScenario,
  targetOfRef,
} from "./scenario-format.js";

/** The scenario file format and the role + name lookup (ATO-960). */

const PAGE = [
  "url: https://shop.example/",
  "title: Shop",
  "",
  '- searchbox "Search products" [ref=e3]',
  '- button "Search" [ref=e4]',
  '- link "Learn more" [ref=e5]',
  "- 'button \"Pay: $5\" [ref=e6]'",
  '- button "Add" [ref=e7]',
  '- button "Add" [ref=e8]',
  "- text: plain text, no ref",
].join("\n");

describe("targetOfRef", () => {
  it("reads the role and name of a ref, including a quoted YAML key", () => {
    expect(targetOfRef(PAGE, "e4")).toEqual({ role: "button", name: "Search" });
    expect(targetOfRef(PAGE, "e6")).toEqual({ role: "button", name: "Pay: $5" });
    expect(targetOfRef(PAGE, "e99")).toBeNull();
  });
});

describe("findTarget", () => {
  it("finds an exact role and name", () => {
    expect(findTarget(PAGE, { role: "button", name: "Search" })).toEqual({ kind: "found", ref: "e4", how: "exact" });
  });

  it("falls back to a name that differs only in case and spaces", () => {
    expect(findTarget(PAGE, { role: "searchbox", name: "  search   PRODUCTS " })).toEqual({
      kind: "found",
      ref: "e3",
      how: "normalized",
    });
  });

  it("does not match the right name with the wrong role", () => {
    expect(findTarget(PAGE, { role: "link", name: "Search" })).toEqual({ kind: "missing" });
  });

  it("reports several matches instead of guessing", () => {
    expect(findTarget(PAGE, { role: "button", name: "Add" })).toEqual({ kind: "ambiguous", count: 2 });
  });
});

describe("names", () => {
  it("normalizes scenario names and refuses path-like ones", () => {
    expect(normalizeScenarioName("Check prices")).toBe("check-prices");
    expect(normalizeScenarioName("daily_report")).toBe("daily_report");
    expect(normalizeScenarioName("../etc/passwd")).toBeNull();
    expect(normalizeScenarioName("a/b")).toBeNull();
    expect(normalizeScenarioName("")).toBeNull();
    expect(normalizeScenarioName(42)).toBeNull();
  });

  it("makes a parameter name from a field label, unique", () => {
    expect(paramNameFrom("Password", new Set())).toBe("password");
    expect(paramNameFrom("Password", new Set(["password"]))).toBe("password_2");
    expect(paramNameFrom("2FA code!", new Set())).toBe("fa_code");
    expect(paramNameFrom("", new Set())).toBe("value");
  });
});

describe("parseScenario", () => {
  const valid = {
    version: 1,
    name: "find-shoes",
    createdAt: "2026-11-18T00:00:00.000Z",
    params: [{ name: "password", secret: true }],
    steps: [
      { kind: "navigate", url: "https://shop.example/" },
      { kind: "type", target: { role: "textbox", name: "Password" }, param: "password" },
      { kind: "act", action: { action: "key", key: "Enter" }, target: { role: "textbox", name: "Password" } },
    ],
  };

  it("reads a valid file and derives the params from the steps", () => {
    const scenario = parseScenario(valid);
    expect(scenario.steps).toHaveLength(3);
    expect(scenario.params).toEqual([{ name: "password", secret: true }]);
  });

  it.each([
    ["an unknown version", { ...valid, version: 2 }],
    ["no steps", { ...valid, steps: [] }],
    ["an unknown step kind", { ...valid, steps: [{ kind: "eval", code: "1" }] }],
    ["a type step with both text and param", { ...valid, steps: [{ kind: "type", target: { role: "textbox", name: "x" }, text: "a", param: "b" }] }],
    ["a type step with neither", { ...valid, steps: [{ kind: "type", target: { role: "textbox", name: "x" } }] }],
    ["an upload step", { ...valid, steps: [{ kind: "act", action: { action: "upload", paths: ["/etc/hosts"] } }] }],
    ["an act step with a stray ref", { ...valid, steps: [{ kind: "act", action: { action: "hover", ref: "e1" } }] }],
    ["a click without a target", { ...valid, steps: [{ kind: "click" }] }],
    ["a bad name", { ...valid, name: "../x" }],
  ])("refuses %s", (_label, file) => {
    expect(() => parseScenario(file)).toThrow(/browser scenario file/);
  });
});

import { describe, expect, it } from "vitest";

import {
  deleteConfigPath,
  isSafeConfigPath,
  readConfigPath,
  writeConfigPath,
} from "./config-paths.js";

describe("config path helpers reject prototype-reaching keys", () => {
  it("writeConfigPath throws rather than polluting Object.prototype", () => {
    const tree: Record<string, unknown> = {};
    expect(() => writeConfigPath(tree, "__proto__.polluted", "yes")).toThrow(
      /unsafe path/,
    );
    expect(() =>
      writeConfigPath(tree, "constructor.prototype.polluted", "yes"),
    ).toThrow(/unsafe path/);

    // The real assertion: nothing leaked onto every object in the process.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("writeConfigPath still writes ordinary nested keys", () => {
    const tree: Record<string, unknown> = {};
    writeConfigPath(tree, "localModels.managed.autoUpdate", false);
    expect(tree).toEqual({
      localModels: { managed: { autoUpdate: false } },
    });
  });

  it("readConfigPath returns undefined for inherited properties", () => {
    // A bare `node[segment]` would hand back Object.prototype.constructor
    // here, reporting a value the config file does not contain.
    expect(readConfigPath({}, "constructor")).toBeUndefined();
    expect(readConfigPath({}, "toString")).toBeUndefined();
    expect(readConfigPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(readConfigPath({ a: { b: 0 } }, "a.b")).toBe(0);
    expect(readConfigPath({ a: { b: false } }, "a.b")).toBe(false);
  });

  it("deleteConfigPath refuses unsafe paths and inherited keys", () => {
    expect(deleteConfigPath({}, "__proto__.x")).toBe(false);
    expect(deleteConfigPath({}, "constructor")).toBe(false);
    expect(Object.prototype).not.toHaveProperty("x");
  });

  it("deleteConfigPath still prunes a real emptied branch", () => {
    const tree: Record<string, unknown> = { a: { b: { c: 1 } }, keep: 2 };
    expect(deleteConfigPath(tree, "a.b.c")).toBe(true);
    expect(tree).toEqual({ keep: 2 });
  });

  it("isSafeConfigPath names the three dangerous segments", () => {
    expect(isSafeConfigPath("agent.maxSteps")).toBe(true);
    expect(isSafeConfigPath("__proto__")).toBe(false);
    expect(isSafeConfigPath("a.constructor.b")).toBe(false);
    expect(isSafeConfigPath("a.prototype")).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { applyProductionNodeEnvDefault } from "./node-env-bootstrap.js";

describe("applyProductionNodeEnvDefault", () => {
  it("fills in an unset NODE_ENV", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyProductionNodeEnvDefault(env)).toBe(true);
    expect(env.NODE_ENV).toBe("production");
  });

  it("fills in an empty NODE_ENV", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "" };
    expect(applyProductionNodeEnvDefault(env)).toBe(true);
    expect(env.NODE_ENV).toBe("production");
  });

  it("leaves an explicit NODE_ENV alone", () => {
    for (const value of ["development", "test", "staging"]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: value };
      expect(applyProductionNodeEnvDefault(env)).toBe(false);
      expect(env.NODE_ENV).toBe(value);
    }
  });
});

describe("cli entry import order", () => {
  /**
   * The whole fix is the *position* of this import. ES modules evaluate
   * their dependency graph before the importing module's own body, so
   * anything that lands after `ink` in the import list runs too late to
   * decide which react-reconciler build was loaded. An import sorter or a
   * casual reorder would silently reintroduce the heap-OOM leak, and the
   * symptom takes eleven hours to appear — hence a test on the source.
   */
  it("imports the NODE_ENV bootstrap before every other module", () => {
    const entry = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    const firstImport = entry
      .split("\n")
      .find((line) => line.startsWith("import "));

    expect(firstImport).toBe('import "./node-env-bootstrap.js";');
  });
});

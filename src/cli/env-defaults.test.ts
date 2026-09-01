import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `env-defaults.ts` keeps `dist` runs on the production React build
 * (issue #307: the development reconciler floods the global performance
 * buffer until V8 aborts). Two things have to stay true, and only the
 * second is visible to a unit test:
 *
 *  1. an unset `NODE_ENV` becomes `"production"`, an explicit one wins;
 *  2. the module is evaluated before `react-reconciler` — which means
 *     it must be the first import of the CLI entrypoint, checked here
 *     against the source because import order leaves no runtime trace.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("env-defaults", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("defaults an unset NODE_ENV to production", async () => {
    delete process.env.NODE_ENV;
    await import("./env-defaults.js");
    expect(process.env.NODE_ENV).toBe("production");
  });

  it("leaves an explicit NODE_ENV alone", async () => {
    process.env.NODE_ENV = "development";
    await import("./env-defaults.js");
    expect(process.env.NODE_ENV).toBe("development");
  });

  it("is the first import of the CLI entrypoint", () => {
    const source = readFileSync(
      resolve(repoRoot, "src", "cli", "index.ts"),
      "utf8",
    );
    const firstImport = source.match(/^import .*$/m)?.[0];
    expect(firstImport).toBe('import "./env-defaults.js";');
  });
});

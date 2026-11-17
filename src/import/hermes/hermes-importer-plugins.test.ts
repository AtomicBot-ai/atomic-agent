import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureUserConfigFileSync } from "../../config/index.js";
import { SessionStore } from "../../session/index.js";
import { TaskStore } from "../../tasks/index.js";
import { HermesImporter } from "./hermes-importer.js";
import { hermesShimInstallPath } from "./hermes-plugins.js";
import { writeFakeHermesPlugin } from "./hermes-plugins-test-helpers.js";
import { HermesSource } from "./hermes-source.js";

/** ATO-953: trusted Hermes Python plugins -> config.mcp.servers. */
describe("HermesImporter plugins option", () => {
  let sourceDir: string;
  let stateDir: string;
  let configFile: string;
  let sessionStore: SessionStore;
  let taskStore: TaskStore;
  let source: HermesSource;
  let shimInstalls: number;

  function buildImporter(trustedPlugins: string[]): HermesImporter {
    return new HermesImporter({
      source,
      sessionStore,
      taskStore,
      stateDir,
      maxAttempts: 3,
      workingDirFallback: "/fallback",
      sourceDir,
      userConfigFile: configFile,
      trustedPlugins,
      pythonCommand: "python3",
      installShim: (dir) => {
        shimInstalls += 1;
        return hermesShimInstallPath(dir);
      },
    });
  }

  function servers() {
    return ensureUserConfigFileSync(configFile).mcp.servers;
  }

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "hermes-plugins-src-"));
    stateDir = mkdtempSync(join(tmpdir(), "hermes-plugins-dst-"));
    configFile = join(stateDir, "config.json");
    sessionStore = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
    taskStore = new TaskStore({ dbFile: join(stateDir, "tasks.sqlite") });
    source = new HermesSource(sourceDir);
    shimInstalls = 0;
    writeFakeHermesPlugin(join(sourceDir, "plugins"), "calculator");
    writeFakeHermesPlugin(join(sourceDir, "plugins"), "untrusted");
  });

  afterEach(() => {
    sessionStore.close();
    taskStore.close();
    source.close();
    for (const dir of [sourceDir, stateDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("bridges only the trusted plugin and reports the rest as skipped", () => {
    const report = buildImporter(["calculator"]).run({
      options: ["plugins"],
      execute: true,
      overwrite: false,
    });
    const items = report.items.filter((i) => i.kind === "plugins");
    expect(items).toEqual([
      expect.objectContaining({
        source: "calculator",
        destination: "hermes-calculator",
        status: "migrated",
      }),
      expect.objectContaining({
        source: "untrusted",
        status: "skipped",
        reason: expect.stringContaining("--trust-plugin untrusted"),
      }),
    ]);
    expect(shimInstalls).toBe(1);
    const written = servers();
    expect(written.map((s) => s.name)).toEqual(["hermes-calculator"]);
    expect(written[0]).toMatchObject({
      enabled: true,
      transport: {
        kind: "stdio",
        command: "python3",
        args: [
          hermesShimInstallPath(stateDir),
          join(sourceDir, "plugins", "calculator"),
        ],
      },
      env: { HERMES_HOME: sourceDir },
    });
  });

  it("writes nothing on a dry run", () => {
    const report = buildImporter(["calculator"]).run({
      options: ["plugins"],
      execute: false,
      overwrite: false,
    });
    expect(
      report.items.find((i) => i.source === "calculator")?.status,
    ).toBe("migrated");
    expect(shimInstalls).toBe(0);
    expect(existsSync(configFile) ? servers() : []).toEqual([]);
  });

  it("never overwrites an existing server with the same name", () => {
    buildImporter(["calculator"]).run({
      options: ["plugins"],
      execute: true,
      overwrite: false,
    });
    const before = readFileSync(configFile, "utf8");
    const report = buildImporter(["calculator"]).run({
      options: ["plugins"],
      execute: true,
      overwrite: true,
    });
    expect(report.items.find((i) => i.source === "calculator")).toMatchObject({
      status: "skipped",
      reason: "server with this name already configured",
    });
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  it("reports a trusted name that matches no plugin", () => {
    const report = buildImporter(["missing"]).run({
      options: ["plugins"],
      execute: true,
      overwrite: false,
    });
    expect(report.items.find((i) => i.source === "missing")).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("no Python plugin named"),
    });
    expect(existsSync(configFile) ? servers() : []).toEqual([]);
  });

  it("downgrades items to errors when the shim cannot be installed", () => {
    const importer = new HermesImporter({
      source,
      sessionStore,
      taskStore,
      stateDir,
      maxAttempts: 3,
      workingDirFallback: "/fallback",
      sourceDir,
      userConfigFile: configFile,
      trustedPlugins: ["calculator"],
      installShim: () => {
        throw new Error("bundled hermes_mcp_shim.py not found");
      },
    });
    const report = importer.run({
      options: ["plugins"],
      execute: true,
      overwrite: false,
    });
    expect(report.items.find((i) => i.source === "calculator")).toMatchObject({
      status: "error",
      reason: expect.stringContaining("not found"),
    });
    expect(servers()).toEqual([]);
  });
});

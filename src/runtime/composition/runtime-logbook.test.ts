import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_LOGBOOK_SETTINGS, writeLogbookSettings } from "../../logbook/logbook-settings.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeLogbook } from "./runtime-logbook.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const registry = { activeTextProviderId: "local-llama", getProvider: () => undefined };

describe("createRuntimeLogbook", () => {
  it("is a scheduler sidecar on macOS in the TUI, which shows the recording chip", () => {
    const sidecar = createRuntimeLogbook({ config: { paths: { stateDir: "/nowhere" } } as never, providerRegistry: registry, logger, indicatorVisible: true, platform: "darwin" });
    expect(sidecar).not.toBeNull();
    expect(typeof sidecar?.tick).toBe("function");
  });

  it("is not built off macOS, where protected windows cannot be told apart yet", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(createRuntimeLogbook({ config: { paths: { stateDir: "/nowhere" } } as never, providerRegistry: registry, logger, indicatorVisible: true, platform })).toBeNull();
    }
  });

  it("never captures in a process with no visible mark (serve, desktop sidecar, CLI), even when the settings say on", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-logbook-"));
    writeLogbookSettings(stateDir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true });
    const sidecar = createRuntimeLogbook({ config: { paths: { stateDir } } as never, providerRegistry: registry, logger, indicatorVisible: false, platform: "darwin" });
    expect(sidecar).toBeNull();
  });
});

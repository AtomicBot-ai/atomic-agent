import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeLogbookIndicator } from "../../logbook/logbook-indicator.js";
import { DEFAULT_LOGBOOK_SETTINGS, writeLogbookSettings } from "../../logbook/logbook-settings.js";
import { readLogbookStatus } from "../../logbook/logbook-status.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeLogbook } from "./runtime-logbook.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const registry = { activeTextProviderId: "local-llama", getProvider: () => undefined };

describe("createRuntimeLogbook", () => {
  it("is a scheduler sidecar on macOS in the TUI, which shows the recording chip", () => {
    const sidecar = createRuntimeLogbook({ config: { paths: { stateDir: "/nowhere" } } as never, providerRegistry: registry, logger, indicator: "tui", platform: "darwin" });
    expect(sidecar).not.toBeNull();
    expect(typeof sidecar?.tick).toBe("function");
  });

  it("is not built off macOS, where protected windows cannot be told apart yet", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(createRuntimeLogbook({ config: { paths: { stateDir: "/nowhere" } } as never, providerRegistry: registry, logger, indicator: "tui", platform })).toBeNull();
    }
  });

  it("builds no sidecar when told there is no mark at all", () => {
    expect(createRuntimeLogbook({ config: { paths: { stateDir: "/nowhere" } } as never, providerRegistry: registry, logger, indicator: "none", platform: "darwin" })).toBeNull();
  });

  it("in a process another app drives, captures nothing until that app reports its mark for this pid (ATO-2534)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-logbook-"));
    writeLogbookSettings(stateDir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true });
    // A report for another process: this one must not take it as its own.
    writeLogbookIndicator(stateDir, { visible: true }, 1111);
    const sidecar = createRuntimeLogbook({ config: { paths: { stateDir } } as never, providerRegistry: registry, logger, indicator: "frontend", platform: "darwin", pid: 2222 });
    expect(sidecar).not.toBeNull();
    await sidecar!.tick(Date.now(), new AbortController().signal);
    // Hidden: no provider lookup, no capture; the status says why.
    expect(readLogbookStatus(stateDir).lastReason).toMatch(/not on screen/);
  });
});

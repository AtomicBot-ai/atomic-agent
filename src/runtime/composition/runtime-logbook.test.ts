import { describe, expect, it } from "vitest";

import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeLogbook } from "./runtime-logbook.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const registry = { activeTextProviderId: "local-llama", getProvider: () => undefined };

describe("createRuntimeLogbook", () => {
  it("is a scheduler sidecar on macOS", () => {
    const sidecar = createRuntimeLogbook({ config: { paths: { stateDir: "/nowhere" } } as never, providerRegistry: registry, logger, platform: "darwin" });
    expect(sidecar).not.toBeNull();
    expect(typeof sidecar?.tick).toBe("function");
  });

  it("is not built off macOS, where protected windows cannot be told apart yet", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(createRuntimeLogbook({ config: { paths: { stateDir: "/nowhere" } } as never, providerRegistry: registry, logger, platform })).toBeNull();
    }
  });
});

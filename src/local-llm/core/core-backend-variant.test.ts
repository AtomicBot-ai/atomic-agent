import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCoreBackend } from "./core-backend.js";
import { readCoreBackend } from "./core-state.js";
import { setConfiguredBackendVariant, setConfiguredCoreBackendVariant } from "../backend/windows-backend-variant.js";
import { parseUserConfigFile } from "../../config/config-schema.js";

const fake = vi.hoisted(() => ({ call: vi.fn(), downloadEvents: vi.fn(), snapshot: vi.fn() }));
vi.mock("./core-client.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./core-client.js")>()),
  connectCore: vi.fn(async () => null),
  withCoreClient: async (_d: string, _v: string, fn: (client: typeof fake) => Promise<unknown>) => fn(fake),
}));
vi.mock("./core-install.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./core-install.js")>()),
  installCore: vi.fn(async () => {}),
}));

/**
 * ATO-373: `coreBackendVariant = "cpu"` survives every Core install path
 * (first install, Core update, the desktop's "Download again"), which all
 * end in `installCoreBackend`; `"auto"` installs Core's recommendation,
 * whatever the llama-server engine's `backendVariant` says.
 */
let dir: string;
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  dir = mkdtempSync(join(tmpdir(), "core-backend-variant-"));
  const backendPath = join(dir, "installed-backend");
  mkdirSync(backendPath, { recursive: true });
  writeFileSync(join(backendPath, "llama-server.exe"), "fixture");
  fake.downloadEvents.mockResolvedValue(async () => {});
  fake.call.mockImplementation(async (path: string) => {
    if (path === "/backends/llamacpp/catalog") {
      return {
        recommended: "b2/windows-x64-cuda-13.3",
        recommended_installed: null,
        releases: [{ tag: "b2", variants: [
          { id: "windows-x64-cuda-13.3", asset: "llama-turboquant-windows-x64-cuda-13.3.zip" },
          { id: "windows-x64-cpu", asset: "llama-turboquant-windows-x64-cpu.zip" },
        ] }],
      };
    }
    if (path === "/backends/llamacpp/install") return { path: backendPath };
    return {};
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fake.call.mockReset();
  setConfiguredBackendVariant("auto");
  setConfiguredCoreBackendVariant("auto");
  rmSync(dir, { recursive: true, force: true });
});

const installBody = () => fake.call.mock.calls.find(([path]) => path === "/backends/llamacpp/install")?.[1];

it("cpu installs the CPU build despite a GPU recommendation", async () => {
  setConfiguredCoreBackendVariant("cpu");
  await expect(installCoreBackend(dir)).resolves.toMatchObject({ ok: true, tag: expect.stringContaining("b2") });
  expect(installBody()).toMatchObject({ version: "b2", backend: "windows-x64-cpu", asset_name: "llama-turboquant-windows-x64-cpu.zip" });
  expect(readCoreBackend(dir)?.backend).toBe("windows-x64-cpu");
});

it("auto installs Core's recommendation", async () => {
  setConfiguredCoreBackendVariant("auto");
  await installCoreBackend(dir);
  expect(installBody()).toMatchObject({ version: "b2", backend: "windows-x64-cuda-13.3" });
  expect(readCoreBackend(dir)?.backend).toBe("windows-x64-cuda-13.3");
});

it("a migrated file with the llama-server rescue's backendVariant cpu still installs the recommended GPU build", async () => {
  // What loadConfig pushes in for such a file.
  const managed = parseUserConfigFile({ version: 76, localModels: { managed: { backendVariant: "cpu" } } }).localModels.managed;
  setConfiguredBackendVariant(managed.backendVariant);
  setConfiguredCoreBackendVariant(managed.coreBackendVariant);
  await installCoreBackend(dir);
  expect(installBody()).toMatchObject({ version: "b2", backend: "windows-x64-cuda-13.3" });
});

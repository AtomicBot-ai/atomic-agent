import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireCoreLease, connectCore, ensureCore, type CoreControlClient } from "./core-client.js";
import { shutdownIdleCoreClient } from "./core-idle.js";
import { installCore, isCoreInstalled } from "./core-install.js";
import { withImageCore } from "./core-image.js";
import { activeCoreVersion, CORE_VERSION } from "./core-state.js";

vi.mock("./core-client.js", async (orig) => ({
  ...(await orig<typeof import("./core-client.js")>()),
  connectCore: vi.fn(), ensureCore: vi.fn(), acquireCoreLease: vi.fn(),
}));
vi.mock("./core-install.js", () => ({ installCore: vi.fn(async () => {}), isCoreInstalled: vi.fn(() => true) }));
vi.mock("./core-operation.js", () => ({ withCoreOperation: async (_d: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("./core-idle.js", () => ({ shutdownIdleCoreClient: vi.fn(async () => true) }));
vi.mock("./core-state.js", async (orig) => ({ ...(await orig<typeof import("./core-state.js")>()), activeCoreVersion: vi.fn() }));

const client = { call: vi.fn() } as unknown as CoreControlClient;
const release = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ensureCore).mockResolvedValue(client);
  vi.mocked(acquireCoreLease).mockResolvedValue({ id: "c1", release });
  vi.mocked(activeCoreVersion).mockReturnValue(CORE_VERSION);
  vi.mocked(isCoreInstalled).mockReturnValue(true);
});

describe("withImageCore", () => {
  it("shuts down a Core it started once the picture is done", async () => {
    vi.mocked(connectCore).mockResolvedValue(null);
    await expect(withImageCore("/d", async () => "ok")).resolves.toBe("ok");
    expect(release).toHaveBeenCalled();
    expect(shutdownIdleCoreClient).toHaveBeenCalledWith(client);
  });

  it("leaves a Core that was already running for a model", async () => {
    vi.mocked(connectCore).mockResolvedValue(client);
    await withImageCore("/d", async () => "ok");
    expect(shutdownIdleCoreClient).not.toHaveBeenCalled();
  });

  it("retires this pin beside an older active Core even when it was running", async () => {
    vi.mocked(connectCore).mockResolvedValue(client);
    vi.mocked(activeCoreVersion).mockReturnValue("0.13.6");
    await withImageCore("/d", async () => "ok");
    expect(shutdownIdleCoreClient).toHaveBeenCalledWith(client);
  });

  it("installs the Core binary first when it is missing, and still cleans up after a failure", async () => {
    vi.mocked(connectCore).mockResolvedValue(null);
    vi.mocked(isCoreInstalled).mockReturnValue(false);
    const onCoreInstall = vi.fn();
    await expect(withImageCore("/d", async () => { throw new Error("boom"); }, { onCoreInstall })).rejects.toThrow("boom");
    expect(onCoreInstall).toHaveBeenCalled();
    expect(installCore).toHaveBeenCalledWith("/d", CORE_VERSION, {});
    expect(release).toHaveBeenCalled();
    expect(shutdownIdleCoreClient).toHaveBeenCalled();
  });
});

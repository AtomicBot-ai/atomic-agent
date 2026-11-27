import { describe, expect, it, vi } from "vitest";
import type { CoreControlClient } from "./core-client.js";
import { diffusionModelLoaded, shutdownIdleCoreClient } from "./core-idle.js";

/** An idle Core (no session, embedding off) whose diffusion module answers `diffusion`; a thrown 404 when undefined. */
function idleCore(diffusion?: unknown) {
  const call = vi.fn(async (path: string) => {
    if (path === "/clients") return { client: { id: "me" } };
    if (path === "/embedding/status") return { enabled: false };
    if (path === "/diffusion/status") {
      if (diffusion !== undefined) return diffusion;
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    if (path === "/shutdown") return { ok: true };
    if (path === "/clients/me") return {};
    throw new Error("unexpected route");
  });
  const client = { call, snapshot: vi.fn(async () => ({ sessions: [] })) } as unknown as CoreControlClient;
  return { client, call, shutdownAsked: () => call.mock.calls.some(([path]) => path === "/shutdown") };
}

describe("shutdownIdleCoreClient and Studio's diffusion model (ATO-812)", () => {
  it("leaves Core running while a diffusion model is loaded, and lets its own lease go", async () => {
    // Studio keeps the model warm after a generation and drops its lease a minute later:
    // without this check `models stop` or a TUI exit took the model down with Core.
    const core = idleCore({ model: { state: "loaded", loaded: { modelId: "flux-2-klein-q4" } } });
    await expect(shutdownIdleCoreClient(core.client)).resolves.toBe(false);
    expect(core.shutdownAsked()).toBe(false);
    expect(core.call).toHaveBeenCalledWith("/clients/me", undefined, { method: "DELETE" });
  });

  it("shuts down when the diffusion module has no model loaded", async () => {
    const core = idleCore({ model: { state: "idle", loaded: null } });
    await expect(shutdownIdleCoreClient(core.client)).resolves.toBe(true);
    expect(core.call).toHaveBeenCalledWith("/shutdown", { client_id: "me" });
  });

  it("shuts down a Core without the diffusion module (404)", async () => {
    const core = idleCore();
    await expect(shutdownIdleCoreClient(core.client)).resolves.toBe(true);
    expect(core.call).toHaveBeenCalledWith("/shutdown", { client_id: "me" });
  });
});

describe("diffusionModelLoaded", () => {
  it("reads only a named loaded model", () => {
    expect(diffusionModelLoaded({ model: { loaded: { modelId: "m" } } })).toBe(true);
    expect(diffusionModelLoaded({ model: { loaded: { modelId: "" } } })).toBe(false);
    expect(diffusionModelLoaded({ model: { loaded: null } })).toBe(false);
    expect(diffusionModelLoaded({})).toBe(false);
    expect(diffusionModelLoaded(null)).toBe(false);
  });
});

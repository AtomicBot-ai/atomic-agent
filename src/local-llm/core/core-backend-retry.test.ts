import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCoreBackend } from "./core-backend.js";
import { CoreRequestError } from "./core-client.js";
import { CoreUnavailableError } from "./core-errors.js";
import { CORE_VERSION, readCoreBackend } from "./core-state.js";

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

let dir: string;
let backendPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-backend-retry-"));
  backendPath = join(dir, "installed-backend");
  mkdirSync(backendPath, { recursive: true });
  writeFileSync(join(backendPath, process.platform === "win32" ? "llama-server.exe" : "llama-server"), "fixture");
  fake.downloadEvents.mockResolvedValue(async () => {});
});
afterEach(() => { vi.clearAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function route(install: () => unknown) {
  fake.call.mockImplementation(async (path: string) => {
    if (path === "/backends/llamacpp/catalog") return { recommended: "b1/cpu", recommended_installed: null };
    if (path === "/backends/llamacpp/install") return install();
    return {};
  });
}

it("retries the backend install after a 5xx with a fresh task, then activates it", async () => {
  let calls = 0;
  route(() => { calls++; if (calls === 1) throw new CoreRequestError(502, "Bad gateway"); return { path: backendPath }; });
  await expect(installCoreBackend(dir)).resolves.toMatchObject({ ok: true });
  const installs = fake.call.mock.calls.filter(([path]) => path === "/backends/llamacpp/install");
  expect(installs).toHaveLength(2);
  expect(installs[0]?.[1].task_id).not.toBe(installs[1]?.[1].task_id);
  expect(readCoreBackend(dir)?.coreVersion).toBe(CORE_VERSION);
});

it("gives up after three attempts with a structured backend failure", async () => {
  route(() => { throw new TypeError("fetch failed"); });
  const err = await installCoreBackend(dir).catch((e: unknown) => e);
  expect(fake.call.mock.calls.filter(([path]) => path === "/backends/llamacpp/install")).toHaveLength(3);
  expect(err).toBeInstanceOf(CoreUnavailableError);
  expect(err).toMatchObject({ stage: "backend", reasonCode: "network", retryable: true });
}, 15_000);

it("does not retry a refusal from Core", async () => {
  route(() => { throw new CoreRequestError(400, "unknown backend"); });
  await expect(installCoreBackend(dir)).rejects.toMatchObject({ stage: "backend" });
  expect(fake.call.mock.calls.filter(([path]) => path === "/backends/llamacpp/install")).toHaveLength(1);
});

it("never retries a cancelled install and does not dress it as a failure", async () => {
  const abort = new AbortController();
  route(() => { abort.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  const err = await installCoreBackend(dir, { signal: abort.signal }).catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(CoreUnavailableError);
  expect(fake.call.mock.calls.filter(([path]) => path === "/backends/llamacpp/install")).toHaveLength(1);
});

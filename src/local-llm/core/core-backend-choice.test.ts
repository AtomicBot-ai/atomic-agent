import { describe, expect, it } from "vitest";
import { chooseCoreBackend, isCoreWindowsCpuBackend, type CoreBackendCatalog } from "./core-backend-choice.js";

const catalog: CoreBackendCatalog = {
  recommended: "b2/windows-x64-vulkan",
  recommended_installed: null,
  releases: [
    { tag: "b1", variants: [{ id: "windows-x64-cpu", asset: "old-cpu.zip" }] },
    { tag: "b2", variants: [
      { id: "windows-x64-cuda-13.3", asset: "llama-turboquant-windows-x64-cuda-13.3.zip" },
      { id: "windows-x64-vulkan", asset: "llama-turboquant-windows-x64-vulkan.zip" },
      { id: "windows-x64-cpu", asset: "llama-turboquant-windows-x64-cpu.zip" },
    ] },
  ],
};

describe("isCoreWindowsCpuBackend", () => {
  it("knows the Windows x64 CPU build under either naming", () => {
    expect(isCoreWindowsCpuBackend("windows-x64-cpu")).toBe(true);
    expect(isCoreWindowsCpuBackend("win-cpu-x64")).toBe(true);
    expect(isCoreWindowsCpuBackend("x64", "llama-turboquant-windows-x64-cpu.zip")).toBe(true);
  });

  it("is false for GPU builds, other systems and nothing at all", () => {
    expect(isCoreWindowsCpuBackend("windows-x64-vulkan")).toBe(false);
    expect(isCoreWindowsCpuBackend("win-cuda-13.1-x64")).toBe(false);
    expect(isCoreWindowsCpuBackend("windows-arm64-cpu")).toBe(false);
    expect(isCoreWindowsCpuBackend("macos-arm64")).toBe(false);
    expect(isCoreWindowsCpuBackend(undefined)).toBe(false);
  });
});

describe("chooseCoreBackend", () => {
  it("auto installs Core's recommendation", () => {
    expect(chooseCoreBackend(catalog, "auto", "win32", "x64")).toBe("b2/windows-x64-vulkan");
  });

  it("cpu installs the CPU build of the recommended release despite a GPU recommendation", () => {
    expect(chooseCoreBackend(catalog, "cpu", "win32", "x64")).toBe("b2/windows-x64-cpu");
  });

  it("cpu keeps a recommendation that already is the CPU build", () => {
    expect(chooseCoreBackend({ ...catalog, recommended: "b2/windows-x64-cpu" }, "cpu", "win32", "x64")).toBe("b2/windows-x64-cpu");
  });

  it("cpu takes another release's CPU build when the recommended one has none", () => {
    const noCpuInB2 = { ...catalog, releases: [catalog.releases![0]!, { tag: "b2", variants: [{ id: "windows-x64-vulkan" }] }] };
    expect(chooseCoreBackend(noCpuInB2, "cpu", "win32", "x64")).toBe("b1/windows-x64-cpu");
  });

  it("other pins keep the recommendation: only cpu applies to Core", () => {
    expect(chooseCoreBackend(catalog, "vulkan", "win32", "x64")).toBe("b2/windows-x64-vulkan");
    expect(chooseCoreBackend(catalog, "cuda-13.3", "win32", "x64")).toBe("b2/windows-x64-vulkan");
  });

  it("ignores cpu off Windows x64", () => {
    const mac: CoreBackendCatalog = { recommended: "b2/macos-arm64", recommended_installed: null };
    expect(chooseCoreBackend(mac, "cpu", "darwin", "arm64")).toBe("b2/macos-arm64");
    expect(chooseCoreBackend(catalog, "cpu", "win32", "arm64")).toBe("b2/windows-x64-vulkan");
  });

  it("refuses rather than install a GPU build when cpu is asked for and none is listed", () => {
    const gpuOnly: CoreBackendCatalog = { recommended: "b2/windows-x64-vulkan", recommended_installed: null, releases: [{ tag: "b2", variants: [{ id: "windows-x64-vulkan" }] }] };
    expect(() => chooseCoreBackend(gpuOnly, "cpu", "win32", "x64")).toThrow(/backendVariant/);
  });

  it("falls back to the installed recommendation when Core recommends nothing new", () => {
    expect(chooseCoreBackend({ recommended: null, recommended_installed: "b1/windows-x64-vulkan" }, "auto", "win32", "x64")).toBe("b1/windows-x64-vulkan");
  });
});

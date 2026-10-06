import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  deviceTableOnce,
  parseListDevices,
  pickBestDevice,
  resolveManagedDevice,
  sharesSystemMemory,
  type GpuDevice,
} from "./gpu-devices.js";

describe("parseListDevices", () => {
  it("parses Vulkan device lines with VRAM", () => {
    const out = [
      "Available devices:",
      "  Vulkan0: NVIDIA GeForce RTX 4070 (8188 MiB, 8188 MiB free)",
      "  Vulkan1: Intel(R) Graphics (RPL-S) (12000 MiB, 11000 MiB free)",
    ].join("\n");
    expect(parseListDevices(out)).toEqual<GpuDevice[]>([
      {
        id: "Vulkan0",
        description: "NVIDIA GeForce RTX 4070",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
      {
        id: "Vulkan1",
        description: "Intel(R) Graphics (RPL-S)",
        totalMemMiB: 12000,
        freeMemMiB: 11000,
      },
    ]);
  });

  it("ignores header / noise lines", () => {
    const out = [
      "ggml_vulkan: Found 1 Vulkan devices:",
      "load_backend: loaded Vulkan backend",
      "  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24560 MiB free)",
    ].join("\n");
    const devices = parseListDevices(out);
    if (devices[0] === undefined) throw new Error("Expected a parsed GPU device");
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("Vulkan0");
  });

  it("handles lines without a MiB figure (totalMemMiB = 0)", () => {
    const devices = parseListDevices("  CUDA0: NVIDIA H100");
    expect(devices).toEqual<GpuDevice[]>([
      {
        id: "CUDA0",
        description: "NVIDIA H100",
        totalMemMiB: 0,
        freeMemMiB: 0,
      },
    ]);
  });

  it("parses the free VRAM figure when present", () => {
    const devices = parseListDevices(
      "  CUDA0: NVIDIA GeForce RTX 4070 Laptop GPU (8187 MiB, 7054 MiB free)",
    );
    if (devices[0] === undefined) throw new Error("Expected a parsed GPU device");
    expect(devices[0].totalMemMiB).toBe(8187);
    expect(devices[0].freeMemMiB).toBe(7054);
  });

  it("returns [] for empty / unrelated output", () => {
    expect(parseListDevices("")).toEqual([]);
    expect(parseListDevices("no devices here")).toEqual([]);
  });

  it("parses the real Apple Silicon Metal row verbatim (MTL0, from an M1 Max)", () => {
    // Verbatim from `llama-server --list-devices` on an Apple M1 Max.
    // The addressable --device id is MTL0, not Metal0 — read it out of
    // the table rather than constructing it.
    const out = [
      "Available devices:",
      "  BLAS: Accelerate (0 MiB, 0 MiB free)",
      "  MTL0: Apple M1 Max (25559 MiB, 25558 MiB free)",
    ].join("\n");
    // BLAS has no trailing digit, so it is not a --device id form and is
    // correctly skipped; only the real MTL0 GPU row is returned.
    expect(parseListDevices(out)).toEqual<GpuDevice[]>([
      {
        id: "MTL0",
        description: "Apple M1 Max",
        totalMemMiB: 25559,
        freeMemMiB: 25558,
      },
    ]);
  });

  it("merges a later memory-bearing row into an earlier figure-less duplicate", () => {
    // Some builds emit the table on both stdout and stderr; an init line
    // seen first must not shadow the row carrying the real memory figures.
    const out = [
      "MTL0: Apple M1 Max",
      "MTL0: Apple M1 Max (25559 MiB, 25558 MiB free)",
    ].join("\n");
    const devices = parseListDevices(out);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toEqual<GpuDevice>({
      id: "MTL0",
      description: "Apple M1 Max",
      totalMemMiB: 25559,
      freeMemMiB: 25558,
    });
  });
});

describe("pickBestDevice", () => {
  it("prefers a discrete GPU over an integrated one regardless of reported VRAM", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "NVIDIA GeForce RTX 4070",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
      {
        id: "Vulkan1",
        description: "Intel(R) Graphics",
        totalMemMiB: 16000,
        freeMemMiB: 16000,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan0");
  });

  it("breaks ties between discrete GPUs by larger VRAM", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "NVIDIA RTX 4070",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
      {
        id: "Vulkan1",
        description: "AMD Radeon RX 7900 XTX",
        totalMemMiB: 24560,
        freeMemMiB: 24560,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan1");
  });

  it("excludes software rasterizers", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "llvmpipe (LLVM 17)",
        totalMemMiB: 32000,
        freeMemMiB: 32000,
      },
    ];
    expect(pickBestDevice(devices)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickBestDevice([])).toBeNull();
  });

  // AMD APU iGPUs carry no "Intel"/"integrated" marker and Vulkan
  // reports their shared-RAM heap as larger than the dGPU's VRAM, so the
  // VRAM tiebreak used to hand the model to the iGPU.
  it.each([
    "AMD Radeon(TM) Graphics",
    "AMD Radeon 780M Graphics",
    "AMD Radeon(TM) Vega 8 Graphics",
    "Intel(R) Graphics (RPL-S)",
  ])("prefers the dGPU over integrated %s reporting more memory", (igpu) => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: igpu,
        totalMemMiB: 16384,
        freeMemMiB: 16384,
      },
      {
        id: "Vulkan1",
        description: "NVIDIA GeForce RTX 4060 Laptop GPU",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan1");
  });

  it("does not demote a discrete Intel Arc to integrated", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "Intel(R) Arc(TM) A770 Graphics",
        totalMemMiB: 16384,
        freeMemMiB: 16384,
      },
      {
        id: "Vulkan1",
        description: "Intel(R) UHD Graphics 770",
        totalMemMiB: 32000,
        freeMemMiB: 32000,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan0");
  });

  it("falls back to an integrated GPU when no discrete is present", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "Intel(R) Iris Xe Graphics",
        totalMemMiB: 4096,
        freeMemMiB: 4096,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan0");
  });

  it("treats Apple Silicon Metal devices as auto-pickable (not discarded)", () => {
    const devices: GpuDevice[] = [
      {
        id: "MTL0",
        description: "Apple M1 Max",
        totalMemMiB: 25559,
        freeMemMiB: 25558,
      },
    ];
    expect(pickBestDevice(devices)).toBe("MTL0");
  });
});

describe("resolveManagedDevice", () => {
  it("returns 'cpu' for the cpu sentinel without spawning", async () => {
    // A bogus bin path proves enumeration is not attempted.
    expect(await resolveManagedDevice("/nonexistent/llama-server", "cpu")).toBe(
      "cpu",
    );
  });

  it("passes a concrete device id through without spawning", async () => {
    expect(
      await resolveManagedDevice("/nonexistent/llama-server", "Vulkan1"),
    ).toBe("Vulkan1");
  });

  it("returns undefined for 'auto' when enumeration fails (bin missing)", async () => {
    expect(
      await resolveManagedDevice("/nonexistent/llama-server", "auto"),
    ).toBeUndefined();
  });

  it("returns undefined for unset config when enumeration fails", async () => {
    expect(
      await resolveManagedDevice("/nonexistent/llama-server", undefined),
    ).toBeUndefined();
  });

  // Multi-GPU (`localModels.managed.tensorSplit` configured): `auto`
  // must stop pinning the one best device — a pinned `--device` would
  // defeat `--tensor-split` — while `cpu` and explicit ids keep their
  // exact single-device semantics.
  describe("multiGpu (tensor split configured)", () => {
    it("still returns 'cpu' for the cpu sentinel", async () => {
      expect(
        await resolveManagedDevice("/nonexistent/llama-server", "cpu", {
          multiGpu: true,
        }),
      ).toBe("cpu");
    });

    it("still passes an explicit device list through", async () => {
      expect(
        await resolveManagedDevice(
          "/nonexistent/llama-server",
          "Vulkan0,Vulkan1",
          { multiGpu: true },
        ),
      ).toBe("Vulkan0,Vulkan1");
    });

    it.skipIf(process.platform === "win32")(
      "does NOT pin a device for 'auto' even when enumeration would find GPUs",
      async () => {
        // A real fake binary that reports two GPUs: without multiGpu the
        // auto pick pins the larger card; with multiGpu it must resolve
        // to undefined so llama.cpp keeps both devices visible.
        const dir = mkdtempSync(join(tmpdir(), "gpu-devices-test-"));
        const bin = join(dir, "llama-server");
        writeFileSync(
          bin,
          [
            "#!/bin/sh",
            'echo "Available devices:"',
            'echo "  Vulkan0: NVIDIA GeForce RTX 4070 (8188 MiB, 8188 MiB free)"',
            'echo "  Vulkan1: NVIDIA GeForce RTX 3090 (24576 MiB, 24000 MiB free)"',
          ].join("\n"),
          { mode: 0o755 },
        );
        try {
          expect(await resolveManagedDevice(bin, "auto")).toBe("Vulkan1");
          expect(
            await resolveManagedDevice(bin, "auto", { multiGpu: true }),
          ).toBeUndefined();
          expect(
            await resolveManagedDevice(bin, undefined, { multiGpu: true }),
          ).toBeUndefined();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
});

describe("sharesSystemMemory", () => {
  const device = (id: string, description: string): GpuDevice => ({
    id,
    description,
    totalMemMiB: 10_922,
    freeMemMiB: 10_922,
  });

  it("is true for Apple silicon's Metal device and for an integrated GPU", () => {
    expect(sharesSystemMemory(device("MTL0", "Apple M4"))).toBe(true);
    expect(sharesSystemMemory(device("Metal0", "Apple M1 Max"))).toBe(true);
    expect(sharesSystemMemory(device("Vulkan1", "Intel(R) Graphics (RPL-S)"))).toBe(true);
    expect(sharesSystemMemory(device("Vulkan0", "AMD Radeon(TM) Graphics"))).toBe(true);
  });

  it("is true for unified-memory parts named like cards", () => {
    // Intel Meteor Lake and Lunar Lake: their iGPUs are called Arc.
    expect(sharesSystemMemory(device("Vulkan0", "Intel(R) Arc(TM) Graphics"))).toBe(true);
    expect(sharesSystemMemory(device("Vulkan0", "Intel(R) Arc(TM) 140V GPU (16GB)"))).toBe(true);
    expect(sharesSystemMemory(device("Vulkan0", "Intel(R) Arc(TM) 130V GPU"))).toBe(true);
    // AMD Strix Halo.
    expect(sharesSystemMemory(device("Vulkan0", "AMD Radeon(TM) 8060S Graphics"))).toBe(true);
    expect(sharesSystemMemory(device("Vulkan0", "AMD Radeon(TM) 8050S Graphics"))).toBe(true);
    // NVIDIA GB10 (DGX Spark) and the Jetson modules.
    expect(sharesSystemMemory(device("CUDA0", "NVIDIA GB10"))).toBe(true);
    expect(sharesSystemMemory(device("CUDA0", "Orin"))).toBe(true);
    expect(sharesSystemMemory(device("CUDA0", "NVIDIA Jetson AGX Orin"))).toBe(true);
    expect(sharesSystemMemory(device("CUDA0", "NVIDIA Thor"))).toBe(true);
  });

  it("is false for a card with memory of its own", () => {
    expect(sharesSystemMemory(device("CUDA0", "NVIDIA GeForce RTX 4090"))).toBe(false);
    expect(sharesSystemMemory(device("Vulkan0", "AMD Radeon RX 7900 XTX"))).toBe(false);
    expect(sharesSystemMemory(device("Vulkan0", "AMD Radeon PRO W7900"))).toBe(false);
    expect(sharesSystemMemory(device("Vulkan0", "Intel(R) Arc(TM) A770 Graphics"))).toBe(false);
    expect(sharesSystemMemory(device("Vulkan0", "Intel(R) Arc(TM) B580 Graphics"))).toBe(false);
  });
});

describe("deviceTableOnce (backlog 39)", () => {
  it.skipIf(process.platform === "win32")(
    "runs --list-devices once for a launch: the device pick and the context fit share the answer",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gpu-devices-once-"));
      const bin = join(dir, "llama-server");
      const runs = join(dir, "runs");
      writeFileSync(runs, "");
      writeFileSync(
        bin,
        [
          "#!/bin/sh",
          `echo run >> '${runs}'`,
          'echo "Available devices:"',
          'echo "  MTL0: Apple M4 (10922 MiB, 10922 MiB free)"',
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        const table = deviceTableOnce(bin);
        expect(await resolveManagedDevice(bin, "auto", { listDevices: table })).toBe("MTL0");
        const again = await table();
        expect(again[0]).toMatchObject({ id: "MTL0", freeMemMiB: 10_922 });
        expect(readFileSync(runs, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
        // A table nobody asks never runs the binary.
        deviceTableOnce(bin);
        expect(readFileSync(runs, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "asks once more when the first answer is empty (a cold start that ran out its deadline), and keeps that answer",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gpu-devices-cold-"));
      const bin = join(dir, "llama-server");
      const runs = join(dir, "runs");
      const warm = join(dir, "warm");
      writeFileSync(runs, "");
      // The first run says nothing, as one killed at its 5 s deadline does.
      writeFileSync(
        bin,
        [
          "#!/bin/sh",
          `echo run >> '${runs}'`,
          `[ -f '${warm}' ] || { : > '${warm}'; exit 0; }`,
          'echo "Available devices:"',
          'echo "  MTL0: Apple M4 (10922 MiB, 10922 MiB free)"',
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        const table = deviceTableOnce(bin);
        expect(await resolveManagedDevice(bin, "auto", { listDevices: table })).toBe("MTL0");
        expect((await table())[0]?.id).toBe("MTL0");
        expect(readFileSync(runs, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "asks at most twice when there is no GPU to report",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gpu-devices-none-"));
      const bin = join(dir, "llama-server");
      const runs = join(dir, "runs");
      writeFileSync(runs, "");
      writeFileSync(bin, ["#!/bin/sh", `echo run >> '${runs}'`, 'echo "Available devices:"'].join("\n"), {
        mode: 0o755,
      });
      try {
        const table = deviceTableOnce(bin);
        expect(await resolveManagedDevice(bin, "auto", { listDevices: table })).toBeUndefined();
        expect(await table()).toEqual([]);
        expect(readFileSync(runs, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

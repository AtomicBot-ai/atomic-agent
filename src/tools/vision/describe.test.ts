import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  LlmProvider,
  ProviderCapabilities,
  VisionRequest,
  VisionResult,
} from "../../llm/index.js";
import { buildVisionDescribeTool } from "./describe.js";

interface FakeProviderOptions {
  capabilities?: ProviderCapabilities;
  onCall?: (request: VisionRequest) => Promise<VisionResult>;
}

function fakeProvider(options: FakeProviderOptions = {}): LlmProvider {
  return {
    name: "fake",
    capabilities:
      options.capabilities ?? { vision: true, visionSource: "has_multimodal" },
    describeImage: vi.fn(
      options.onCall ??
        (async () => ({
          text: "a small red square",
          durationMs: 12,
        })),
    ),
  };
}

const ctx = (workingDir: string) => ({
  workingDir,
  sessionId: "s-test",
  stepIndex: 1,
  signal: new AbortController().signal,
});

describe("buildVisionDescribeTool", () => {
  it("returns an error when prompt is missing", async () => {
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 2,
      maxImageBytes: 1024,
    });
    const result = await tool.run(
      { path: "x.png" },
      ctx(process.cwd()),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/prompt/i);
  });

  it("returns an error when no image path is provided", async () => {
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 2,
      maxImageBytes: 1024,
    });
    const result = await tool.run(
      { prompt: "describe" },
      ctx(process.cwd()),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/path|paths/i);
  });

  it("returns an error when provider lacks vision capability", async () => {
    const tool = buildVisionDescribeTool({
      provider: fakeProvider({
        capabilities: { vision: false, visionSource: "config-disabled" },
      }),
      maxImagesPerCall: 2,
      maxImageBytes: 1024,
    });
    const result = await tool.run(
      { prompt: "x", path: "x.png" },
      ctx(process.cwd()),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/vision is not available/i);
  });

  it("rejects unsupported file extensions", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vision-tool-"));
    const path = join(tmp, "note.txt");
    await writeFile(path, "not an image");
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 2,
      maxImageBytes: 1024,
    });
    const result = await tool.run(
      { prompt: "describe", path },
      ctx(tmp),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/unsupported image extension/i);
  });

  it("forwards loaded image bytes to the provider and returns its text", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vision-tool-"));
    const path = join(tmp, "image.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const provider = fakeProvider();
    const tool = buildVisionDescribeTool({
      provider,
      maxImagesPerCall: 2,
      maxImageBytes: 1024,
    });
    const result = await tool.run(
      { prompt: "describe", path },
      ctx(tmp),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("a small red square");
    const calls = (provider.describeImage as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls).toHaveLength(1);
    const call = calls[0]![0] as VisionRequest;
    expect(call.prompt).toBe("describe");
    expect(call.images).toHaveLength(1);
    expect(call.images[0]!.id).toBe(1);
    expect(call.images[0]!.mimeType).toBe("image/png");
  });

  // Issue #185: the per-call image cap was enforced but documented
  // nowhere the model could read, so it discovered the limit only by
  // burning a step on a failed 8/12/20-image call. The cap now appears
  // in the tool description, and the error names the remedy.
  it("documents the image cap in the tool description", () => {
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 4,
      maxImageBytes: 1024,
    });
    expect(tool.description).toContain("At most 4 images per call");
    expect(tool.description).toMatch(/split/i);
  });

  it("reflects a reconfigured cap in the tool description", () => {
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 7,
      maxImageBytes: 1024,
    });
    expect(tool.description).toContain("At most 7 images per call");
  });

  it("rejects more images than the cap and names the split remedy", async () => {
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 4,
      maxImageBytes: 1024,
    });
    const result = await tool.run(
      {
        prompt: "describe",
        paths: Array.from({ length: 12 }, (_, i) => `img-${i}.png`),
      },
      ctx(process.cwd()),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("at most 4 images per call (got 12)");
    // 12 / 4 = 3 calls. The remedy is the point: the model should not
    // have to guess how to recover from the cap.
    expect(result.summary).toContain("split into 3 calls of at most 4");
  });

  it("rounds the suggested call count up for a partial final batch", async () => {
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 4,
      maxImageBytes: 1024,
    });
    const result = await tool.run(
      {
        prompt: "describe",
        paths: Array.from({ length: 13 }, (_, i) => `img-${i}.png`),
      },
      ctx(process.cwd()),
    );
    expect(result.status).toBe("error");
    // Math.ceil(13 / 4) === 4, not 3.
    expect(result.summary).toContain("split into 4 calls of at most 4");
  });

  it("accepts exactly the cap without erroring", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vision-tool-"));
    const paths: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const path = join(tmp, `image-${i}.png`);
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      paths.push(path);
    }
    const provider = fakeProvider();
    const tool = buildVisionDescribeTool({
      provider,
      maxImagesPerCall: 4,
      maxImageBytes: 1024,
    });
    const result = await tool.run({ prompt: "describe", paths }, ctx(tmp));
    expect(result.status).toBe("ok");
    const call = (provider.describeImage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as VisionRequest;
    expect(call.images).toHaveLength(4);
  });

  it("rejects images that exceed maxImageBytes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vision-tool-"));
    const path = join(tmp, "big.png");
    await writeFile(path, Buffer.alloc(32));
    const tool = buildVisionDescribeTool({
      provider: fakeProvider(),
      maxImagesPerCall: 2,
      maxImageBytes: 8,
    });
    const result = await tool.run(
      { prompt: "describe", path },
      ctx(tmp),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/maxImageBytes/);
  });
});

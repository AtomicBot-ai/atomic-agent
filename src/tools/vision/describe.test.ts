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

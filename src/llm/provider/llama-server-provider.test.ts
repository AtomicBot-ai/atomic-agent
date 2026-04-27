import { describe, expect, it, vi } from "vitest";

import type { LlamaServerClient } from "../llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../model-profile.js";
import type { ModelProfile } from "../model-profile.js";
import { LlamaServerProvider } from "./llama-server-provider.js";
import { VisionUnsupportedError } from "./llm-provider.js";

const VISION_PROFILE: ModelProfile = {
  ...PLAIN_INSTRUCT_PROFILE,
  vision: { supported: true, source: "has_multimodal" },
};

const NO_VISION_PROFILE: ModelProfile = {
  ...PLAIN_INSTRUCT_PROFILE,
  vision: { supported: false, source: "absent" },
};

function fakeClient(
  complete: LlamaServerClient["complete"],
): LlamaServerClient {
  return { complete } as unknown as LlamaServerClient;
}

describe("LlamaServerProvider", () => {
  it("reports vision supported when config + profile both allow it", () => {
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
    });
    expect(provider.capabilities).toEqual({
      vision: true,
      visionSource: "has_multimodal",
    });
  });

  it("reports vision disabled when config switch is off", () => {
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: false,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
    });
    expect(provider.capabilities).toEqual({
      vision: false,
      visionSource: "config-disabled",
    });
  });

  it("trusts config when auto-detect is disabled", () => {
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => NO_VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: false,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
    });
    expect(provider.capabilities).toEqual({
      vision: true,
      visionSource: "auto-detect-disabled",
    });
  });

  it("throws VisionUnsupportedError when vision is unavailable", async () => {
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => NO_VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
    });
    await expect(
      provider.describeImage({
        prompt: "what is this?",
        images: [
          { id: 1, bytes: new Uint8Array([1]), mimeType: "image/png" },
        ],
      }),
    ).rejects.toBeInstanceOf(VisionUnsupportedError);
  });

  it("rejects empty image list", async () => {
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
    });
    await expect(
      provider.describeImage({ prompt: "x", images: [] }),
    ).rejects.toThrow(/at least one image/);
  });

  it("rejects when an image exceeds the size cap", async () => {
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 4,
      maxImagesPerCall: 2,
    });
    await expect(
      provider.describeImage({
        prompt: "x",
        images: [
          {
            id: 1,
            bytes: new Uint8Array([1, 2, 3, 4, 5]),
            mimeType: "image/png",
          },
        ],
      }),
    ).rejects.toThrow(/maxImageBytes/);
  });

  it("rejects when too many images are passed", async () => {
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 1,
    });
    await expect(
      provider.describeImage({
        prompt: "x",
        images: [
          { id: 1, bytes: new Uint8Array([1]), mimeType: "image/png" },
          { id: 2, bytes: new Uint8Array([2]), mimeType: "image/png" },
        ],
      }),
    ).rejects.toThrow(/at most 1/);
  });

  it("posts /v1/chat/completions with image_url + enable_thinking=false", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "  a square \n" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
      fetchImpl,
      baseUrlOverride: "http://test-llama:9999",
    });

    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = await provider.describeImage({
      prompt: "describe",
      images: [{ id: 1, bytes: pngBytes, mimeType: "image/png" }],
    });

    expect(result.text).toBe("a square");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(url)).toBe("http://test-llama:9999/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{
        role: string;
        content: Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string } }
        >;
      }>;
      max_tokens: number;
      temperature: number;
      stream: boolean;
      chat_template_kwargs: { enable_thinking: boolean };
      reasoning_format: string;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toHaveLength(2);
    const imgPart = body.messages[0].content[0] as {
      type: "image_url";
      image_url: { url: string };
    };
    expect(imgPart.type).toBe("image_url");
    expect(imgPart.image_url.url.startsWith("data:image/png;base64,")).toBe(
      true,
    );
    const textPart = body.messages[0].content[1] as {
      type: "text";
      text: string;
    };
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("describe");
    expect(body.stream).toBe(false);
    expect(body.chat_template_kwargs.enable_thinking).toBe(false);
    expect(body.reasoning_format).toBe("none");
  });

  it("detects JPEG magic bytes for the data URI mime", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
      fetchImpl,
      baseUrlOverride: "http://test-llama:9999",
    });
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await provider.describeImage({
      prompt: "x",
      images: [{ id: 1, bytes: jpegBytes, mimeType: "image/jpeg" }],
    });
    const init = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{
        content: Array<{ type: string; image_url?: { url: string } }>;
      }>;
    };
    const url = body.messages[0].content[0].image_url?.url ?? "";
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("throws when llama-server returns a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const provider = new LlamaServerProvider(fakeClient(vi.fn()), {
      getProfile: () => VISION_PROFILE,
      visionEnabledByConfig: true,
      visionAutoDetect: true,
      maxImageBytes: 1024,
      maxImagesPerCall: 2,
      fetchImpl,
      baseUrlOverride: "http://test-llama:9999",
    });
    await expect(
      provider.describeImage({
        prompt: "x",
        images: [
          { id: 1, bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" },
        ],
      }),
    ).rejects.toThrow(/http 500/);
  });
});

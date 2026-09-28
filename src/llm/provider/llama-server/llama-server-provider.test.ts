import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { LlamaServerClient } from "../../llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../model-profile.js";
import type { ModelProfile } from "../../model-profile.js";
import { LlamaServerProvider } from "./llama-server-provider.js";
import { VisionUnsupportedError, type VisionResult } from "../llm-provider.js";

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
  applyTemplate?: LlamaServerClient["applyTemplate"],
): LlamaServerClient {
  return { complete, applyTemplate } as unknown as LlamaServerClient;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff]);

function visionProvider(options: {
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): LlamaServerProvider {
  return new LlamaServerProvider(fakeClient(vi.fn()), {
    getProfile: () => VISION_PROFILE,
    visionEnabledByConfig: true,
    visionAutoDetect: true,
    maxImageBytes: 1024,
    maxImagesPerCall: 2,
    baseUrlOverride: "http://test-llama:9999",
    ...options,
  });
}

function describeJpeg(
  provider: LlamaServerProvider,
  signal?: AbortSignal,
): Promise<VisionResult> {
  return provider.describeImage({
    prompt: "x",
    images: [{ id: 1, bytes: JPEG_BYTES, mimeType: "image/jpeg" }],
    ...(signal ? { signal } : {}),
  });
}

function bodyFetch(body: string, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function jsonFetch(content: string): typeof fetch {
  return bodyFetch(JSON.stringify({ choices: [{ message: { content } }] }));
}

/**
 * A server that sends headers and then never finishes the body. The
 * stream errors with the request signal's abort reason, mirroring real
 * undici: measured on Node 25, a fetch aborted while `res.text()` is
 * pending rejects with `signal.reason` itself, or with
 * `AbortError: This operation was aborted` when the abort carried none —
 * and a signal already aborted at call time rejects the fetch outright.
 * Without that, an abort would be invisible to the body read.
 */
function stallingFetch(
  opts: { status?: number; prefix?: string } = {},
): typeof fetch {
  const { status = 200, prefix = '{"choices":' } = opts;
  return vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(prefix));
          init?.signal?.addEventListener("abort", () => {
            stream.error(
              init.signal?.reason ??
                Object.assign(new Error("This operation was aborted"), {
                  name: "AbortError",
                }),
            );
          });
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

/**
 * Bound the assertion itself: an unbounded body read never settles, so a
 * regression fails as "hung" with a real diff instead of stalling the
 * suite until vitest's own timeout.
 */
async function settledWithin(
  ms: number,
  call: Promise<VisionResult>,
): Promise<{ kind: string; detail: string }> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    call.then(
      (result) => ({ kind: "resolved", detail: result.text }),
      (err: unknown) => ({
        kind: "rejected",
        detail: err instanceof Error ? err.message : String(err),
      }),
    ),
    new Promise<{ kind: string; detail: string }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "hung", detail: "" }), ms);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
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
    expect(provider.capabilities).toMatchObject({
      vision: true,
      visionSource: "has_multimodal",
      toolTransport: "grammar",
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
    expect(provider.capabilities).toMatchObject({
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
    expect(provider.capabilities).toMatchObject({
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
        images: [{ id: 1, bytes: new Uint8Array([1]), mimeType: "image/png" }],
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
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
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

  it("throws when llama-server returns a non-2xx response, body preview and all", async () => {
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
          {
            id: 1,
            bytes: new Uint8Array([0xff, 0xd8, 0xff]),
            mimeType: "image/jpeg",
          },
        ],
      }),
    ).rejects.toThrow(/http 500: boom/);
  });

  it("fails the request when the server stalls mid-body", async () => {
    const fetchImpl = stallingFetch();
    const provider = visionProvider({ fetchImpl, requestTimeoutMs: 20 });

    const outcome = await settledWithin(1_000, describeJpeg(provider));

    expect(outcome.kind).toBe("rejected");
    // The abort reason, not just the wrapper: a body read that fails for
    // any other reason (a `JSON.parse("")` on a swallowed read, say)
    // produces the same `vision request failed` prefix.
    expect(outcome.detail).toMatch(/vision request failed/);
    expect(outcome.detail).toMatch(/abort/i);
  });

  it("settles on the caller's abort instead of waiting out the deadline", async () => {
    // What the user's Esc does: `vision.describe` passes `ctx.signal`
    // down as `VisionRequest.signal`, and a wedged server has to let go
    // of it long before `requestTimeoutMs`.
    const fetchImpl = stallingFetch();
    const provider = visionProvider({ fetchImpl, requestTimeoutMs: 10_000 });
    const caller = new AbortController();
    const call = describeJpeg(provider, caller.signal);
    setTimeout(() => caller.abort(new Error("turn cancelled")), 10).unref();

    const outcome = await settledWithin(1_000, call);

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toMatch(/turn cancelled/);
  });

  it("obeys a caller signal that is already aborted", async () => {
    const fetchImpl = stallingFetch();
    const provider = visionProvider({ fetchImpl, requestTimeoutMs: 10_000 });

    const outcome = await settledWithin(
      1_000,
      describeJpeg(provider, AbortSignal.abort(new Error("already gone"))),
    );

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toMatch(/already gone/);
  });

  it("keeps the http status when the error body is the thing that stalls", async () => {
    // The deadline now covers the error body too, so a 500 whose body
    // never completes must still report the status the retry/report path
    // reads, not the abort that ended the read.
    const fetchImpl = stallingFetch({ status: 500, prefix: "partial" });
    const provider = visionProvider({ fetchImpl, requestTimeoutMs: 20 });

    const outcome = await settledWithin(1_000, describeJpeg(provider));

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toMatch(/http 500/);
  });

  it("clears its deadline and unlinks the caller signal when the call settles", async () => {
    // A leaked 120 s timer holds the CLI's event loop open at exit, and a
    // leaked listener accumulates on the turn's signal, one per image the
    // model looks at.
    vi.useFakeTimers();
    const caller = new AbortController();
    try {
      const provider = visionProvider({ fetchImpl: jsonFetch("ok") });
      await describeJpeg(provider, caller.signal);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("fails instead of describing nothing when a 200 body is not json", async () => {
    const provider = visionProvider({
      fetchImpl: bodyFetch("not json at all"),
    });
    await expect(describeJpeg(provider)).rejects.toThrow(
      /vision request failed/,
    );
  });

  it("fails instead of describing nothing when a 200 body is empty", async () => {
    // What undici hands back when the stream closes early: a 200 whose
    // body is the empty string. Parsed leniently it would be an object
    // with no choices, i.e. another silently empty description.
    const provider = visionProvider({ fetchImpl: bodyFetch("") });
    await expect(describeJpeg(provider)).rejects.toThrow(
      /vision request failed/,
    );
  });

  it("rescues a reasoning-only answer the way the openai path does", async () => {
    const provider = visionProvider({
      fetchImpl: bodyFetch(
        JSON.stringify({
          choices: [
            { message: { content: "", reasoning_content: " a red square " } },
          ],
        }),
      ),
    });
    const result = await describeJpeg(provider);
    expect(result.text).toBe("a red square");
  });
});

describe("LlamaServerProvider — server chat template (F31)", () => {
  const request = {
    prompt: "RAW system\nRAW tail",
    grammar: 'root ::= "ok"',
    slotId: 0,
    chat: { system: "SYS", user: "TAIL", prefixHash: "h" },
  };

  it("renders a request carrying chat parts through /apply-template and keeps the grammar", async () => {
    const complete = vi.fn(async (req: { prompt: string }) => ({
      content: req.prompt,
    })) as unknown as LlamaServerClient["complete"];
    const applyTemplate = vi.fn(
      async (messages: ReadonlyArray<{ role: string; content: string }>) =>
        `<s>${messages.map((m) => `[${m.role}]${m.content}`).join("")}[assistant]`,
    ) as unknown as LlamaServerClient["applyTemplate"];
    const provider = new LlamaServerProvider(fakeClient(complete, applyTemplate), {
      getProfile: () => NO_VISION_PROFILE,
      getModelId: () => "llama-3.1-8b",
      visionEnabledByConfig: false,
      visionAutoDetect: false,
      maxImageBytes: 1024,
      maxImagesPerCall: 1,
    });
    await provider.complete(request);
    await provider.complete({ ...request, chat: { ...request.chat, user: "TAIL2" } });
    const sent = vi.mocked(complete).mock.calls.map((c) => c[0]);
    expect(sent[0]).toMatchObject({
      prompt: "<s>[system]SYS[user]TAIL[assistant]",
      grammar: 'root ::= "ok"',
    });
    expect(sent[1]!.prompt).toBe("<s>[system]SYS[user]TAIL2[assistant]");
    // One render per prefix, whatever the tail does.
    expect(applyTemplate).toHaveBeenCalledTimes(1);
  });

  it("sends the raw prompt when there are no chat parts or the render fails", async () => {
    const complete = vi.fn(async () => ({})) as unknown as LlamaServerClient["complete"];
    const applyTemplate = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as LlamaServerClient["applyTemplate"];
    const provider = new LlamaServerProvider(fakeClient(complete, applyTemplate), {
      getProfile: () => NO_VISION_PROFILE,
      visionEnabledByConfig: false,
      visionAutoDetect: false,
      maxImageBytes: 1024,
      maxImagesPerCall: 1,
    });
    const { chat: _chat, ...plain } = request;
    await provider.complete(plain);
    await provider.complete(request);
    const sent = vi.mocked(complete).mock.calls.map((c) => c[0]);
    expect(sent[0]!.prompt).toBe("RAW system\nRAW tail");
    expect(sent[1]!.prompt).toBe("RAW system\nRAW tail");
    expect(applyTemplate).toHaveBeenCalledTimes(1);
  });
});

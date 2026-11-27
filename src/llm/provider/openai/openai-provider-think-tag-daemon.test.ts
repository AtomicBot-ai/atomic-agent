import { describe, expect, it, vi } from "vitest";

import { OpenAiProvider } from "./openai-provider.js";

// ATO-2771: an Ollama cloud model run through the local daemon is
// proxied to Ollama Cloud, so it gets the same tag rewrite as
// `ollama.com` (issue #283) on every path: native chat, flat chat,
// image and audio describe calls. Local models stay byte-identical.

const PROMPT = "keep <think> and </thinking> as written";
const DAEMON = "http://127.0.0.1:11434";

function recordingFetch(content: string): { fetchImpl: typeof fetch; raw: () => string } {
  let sent = "";
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    // The chat request; a side probe (if any) carries no messages.
    const body = String(init?.body ?? "");
    if (sent === "" && body.includes('"messages"')) sent = body;
    return new Response(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, raw: () => sent };
}

function provider(
  id: string,
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch,
  messageShape: "native" | "flat" = "native",
): OpenAiProvider {
  return new OpenAiProvider({
    id,
    baseUrl,
    apiKey: "",
    defaultChatModel: model,
    supportsVision: true,
    supportsAudio: true,
    messageShape,
    fetchImpl,
  });
}

/** The raw request body of each path: native turn, flat turn, image, audio. */
async function sentOnEveryPath(id: string, baseUrl: string, model: string): Promise<string[]> {
  const out: string[] = [];
  for (const shape of ["native", "flat"] as const) {
    const { fetchImpl, raw } = recordingFetch("ok");
    await provider(id, baseUrl, model, fetchImpl, shape).complete({ prompt: PROMPT });
    out.push(raw());
  }
  {
    const { fetchImpl, raw } = recordingFetch("a cat");
    await provider(id, baseUrl, model, fetchImpl).describeImage({
      prompt: PROMPT,
      images: [{ id: 0, bytes: new Uint8Array([1]), mimeType: "image/png" }],
    });
    out.push(raw());
  }
  {
    const { fetchImpl, raw } = recordingFetch("hi");
    await provider(id, baseUrl, model, fetchImpl).describeAudio({
      prompt: PROMPT,
      audio: { bytes: new Uint8Array([1, 2, 3]), format: "mp3" },
    });
    out.push(raw());
  }
  return out;
}

describe("OpenAiProvider thinking tags for Ollama cloud models on the local daemon (ATO-2771)", () => {
  it("sends visible brackets for a :cloud or -cloud model on 127.0.0.1:11434", async () => {
    for (const model of ["deepseek-v4-flash:cloud", "gpt-oss:120b-cloud"]) {
      const bodies = await sentOnEveryPath("ollama", DAEMON, model);
      expect(bodies).toHaveLength(4);
      for (const raw of bodies) {
        expect(raw).toContain("keep [think] and [/thinking] as written");
        expect(raw).not.toMatch(/<\/?think(ing)?>/);
      }
    }
  });

  it("finds the daemon by port alone when the entry has another id", async () => {
    for (const raw of await sentOnEveryPath("my-ollama", DAEMON, "deepseek-v4-flash:cloud")) {
      expect(raw).toContain("keep [think] and [/thinking] as written");
    }
  });

  it("sends a plain local model on local Ollama verbatim", async () => {
    for (const raw of await sentOnEveryPath("ollama", DAEMON, "qwen3:8b")) {
      expect(raw).toContain(PROMPT);
      expect(raw).not.toContain("[think]");
    }
  });

  it("sends a -cloud model on a server that is not Ollama verbatim", async () => {
    for (const [id, baseUrl] of [
      ["llamacpp", "http://127.0.0.1:8080"],
      ["lmstudio", "http://localhost:1234"],
    ] as const) {
      for (const raw of await sentOnEveryPath(id, baseUrl, "my-model-cloud")) {
        expect(raw).toContain(PROMPT);
        expect(raw).not.toContain("[think]");
      }
    }
  });
});

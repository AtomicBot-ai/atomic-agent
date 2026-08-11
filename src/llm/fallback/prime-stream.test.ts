import { describe, it, expect } from "vitest";
import { primeStream, replayPrimedStream } from "./prime-stream.js";
import { runWithFallback } from "./run-with-fallback.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";

async function* threeChunks(prefix: string): AsyncGenerator<string, string, void> {
  yield `${prefix}-1`;
  yield `${prefix}-2`;
  return `${prefix}-done`;
}

async function* emptyStream(): AsyncGenerator<string, string, void> {
  return "only-return";
}

async function* throwsOnOpen(): AsyncGenerator<string, string, void> {
  throw new OpenAiHttpError("boom", 503, "http://x", false, null, "p");
  // eslint-disable-next-line no-unreachable
  yield "never";
}

async function collect(
  gen: AsyncGenerator<string, string, void>,
): Promise<{ chunks: string[]; ret: string }> {
  const chunks: string[] = [];
  let res = await gen.next();
  while (!res.done) {
    chunks.push(res.value);
    res = await gen.next();
  }
  return { chunks, ret: res.value };
}

describe("primeStream / replayPrimedStream", () => {
  it("replays a primed stream without dropping the first chunk", async () => {
    const primed = await primeStream(threeChunks("a"));
    const { chunks, ret } = await collect(replayPrimedStream(primed));
    expect(chunks).toEqual(["a-1", "a-2"]);
    expect(ret).toBe("a-done");
  });

  it("surfaces the return value of an empty stream", async () => {
    const primed = await primeStream(emptyStream());
    const { chunks, ret } = await collect(replayPrimedStream(primed));
    expect(chunks).toEqual([]);
    expect(ret).toBe("only-return");
  });

  it("propagates an open-time failure so the chain can advance", async () => {
    await expect(primeStream(throwsOnOpen())).rejects.toBeInstanceOf(
      OpenAiHttpError,
    );
  });

  it("falls the streaming path over when the primary fails to open", async () => {
    const chain = new ProviderFallbackChain({
      resolve: () => ({ chain: ["primary", "backup"], timing: DEFAULT_FALLBACK_TIMING }),
    });

    const primed = await runWithFallback(chain, (id) =>
      primeStream(
        id === "primary" ? throwsOnOpen() : threeChunks(id),
      ),
    );
    const { chunks, ret } = await collect(replayPrimedStream(primed));
    expect(chunks).toEqual(["backup-1", "backup-2"]);
    expect(ret).toBe("backup-done");
    expect(chain.activeOverride).toBe("backup");
  });
});

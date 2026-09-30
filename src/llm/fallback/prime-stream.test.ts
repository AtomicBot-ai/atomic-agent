import { describe, it, expect } from "vitest";
import { primeStream, replayPrimedStream } from "./prime-stream.js";
import { runWithFallback } from "./run-with-fallback.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";

async function* threeChunks(
  prefix: string,
): AsyncGenerator<string, string, void> {
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

  /**
   * The buffered first chunk is yielded from `replayPrimedStream`'s own
   * frame, not delegated — so a consumer that walks away there closes
   * only the replay wrapper. Before this was handled, the provider
   * generator underneath stayed suspended forever and its `finally`
   * (which is where `LlamaServerClient.completeStream` closes the
   * socket, and therefore where a llama.cpp slot is released) never ran.
   */
  it("closes the underlying stream when abandoned on the replayed first chunk", async () => {
    let released = false;
    async function* tracked(): AsyncGenerator<string, string, void> {
      try {
        yield "x-1";
        yield "x-2";
        return "x-done";
      } finally {
        released = true;
      }
    }
    const primed = await primeStream(tracked());
    const replay = replayPrimedStream(primed);
    expect(await replay.next()).toEqual({ done: false, value: "x-1" });
    expect(released).toBe(false);

    await replay.return(undefined as never);
    expect(released).toBe(true);
    // And the inner generator really is finished, not merely resumed.
    expect(await primed.rest.next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("closes the underlying stream when abandoned on a delegated chunk", async () => {
    let released = false;
    async function* tracked(): AsyncGenerator<string, string, void> {
      try {
        yield "x-1";
        yield "x-2";
        return "x-done";
      } finally {
        released = true;
      }
    }
    const primed = await primeStream(tracked());
    const replay = replayPrimedStream(primed);
    await replay.next();
    expect(await replay.next()).toEqual({ done: false, value: "x-2" });
    expect(released).toBe(false);

    await replay.return(undefined as never);
    expect(released).toBe(true);
  });

  it("does not close twice on a fully drained stream", async () => {
    let closes = 0;
    async function* tracked(): AsyncGenerator<string, string, void> {
      try {
        yield "x-1";
        return "x-done";
      } finally {
        closes += 1;
      }
    }
    const primed = await primeStream(tracked());
    const { chunks, ret } = await collect(replayPrimedStream(primed));
    expect(chunks).toEqual(["x-1"]);
    expect(ret).toBe("x-done");
    expect(closes).toBe(1);
  });

  it("falls the streaming path over when the primary fails to open", async () => {
    const chain = new ProviderFallbackChain({
      resolve: () => ({
        chain: ["primary", "backup"],
        timing: DEFAULT_FALLBACK_TIMING,
      }),
    });

    const primed = await runWithFallback(chain, (id) =>
      primeStream(id === "primary" ? throwsOnOpen() : threeChunks(id)),
    );
    const { chunks, ret } = await collect(replayPrimedStream(primed));
    expect(chunks).toEqual(["backup-1", "backup-2"]);
    expect(ret).toBe("backup-done");
    expect(chain.activeOverride).toBe("backup");
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  describeFailedAttempts,
  readFailedAttempts,
} from "./failed-attempts.js";
import { runWithFallback } from "./run-with-fallback.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import type { ProviderSwitchNotice } from "./provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { GrammarError } from "../reliability/llm-failures.js";
import {
  classifyFailure,
  isNetworkError,
  isRequestSizeRejection,
} from "../reliability/index.js";
import { shouldAdvance } from "./should-advance.js";

function makeChain(
  ids: string[],
  notices: ProviderSwitchNotice[] = [],
): ProviderFallbackChain {
  return new ProviderFallbackChain({
    resolve: () => ({ chain: ids, timing: DEFAULT_FALLBACK_TIMING }),
    noticeSink: (n) => notices.push(n),
  });
}

function http(status: number): OpenAiHttpError {
  return new OpenAiHttpError("boom", status, "http://x", false, null, "p");
}

describe("runWithFallback", () => {
  it("e2e: primary 429 → fallback answers → one switch notice", async () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = makeChain(["primary", "backup"], notices);
    const seen: string[] = [];

    const result = await runWithFallback(chain, async (id) => {
      seen.push(id);
      if (id === "primary") throw http(429);
      return `answer from ${id}`;
    });

    expect(result).toBe("answer from backup");
    expect(seen).toEqual(["primary", "backup"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ direction: "away", to: "backup" });
  });

  it("returns the primary's result without touching the fallback on success", async () => {
    const chain = makeChain(["primary", "backup"]);
    const seen: string[] = [];
    const result = await runWithFallback(chain, async (id) => {
      seen.push(id);
      return `ok ${id}`;
    });
    expect(result).toBe("ok primary");
    expect(seen).toEqual(["primary"]);
  });

  it("stays sticky: after a switch, the next call starts on the working provider", async () => {
    const chain = makeChain(["primary", "backup"]);

    await runWithFallback(chain, async (id) => {
      if (id === "primary") throw http(500);
      return id;
    });
    // Second turn: primary is in cooldown → should not even be attempted.
    const seen: string[] = [];
    const out = await runWithFallback(chain, async (id) => {
      seen.push(id);
      return id;
    });
    expect(out).toBe("backup");
    expect(seen).toEqual(["backup"]);
  });

  it("rethrows when the whole chain is down, having tried every link", async () => {
    const chain = makeChain(["a", "b"]);
    const lastErr = http(500);
    let attempts = 0;
    await expect(
      runWithFallback(chain, async () => {
        attempts += 1;
        throw lastErr;
      }),
    ).rejects.toBe(lastErr);
    expect(attempts).toBe(2); // tried both links this turn
  });

  describe("an exhausted chain [cloud 404, local fetch failed]", () => {
    // The field shape: OpenRouter answers 404 for a retired model, and the
    // auto-appended llama-server is not running.
    const cloud404 = (): OpenAiHttpError =>
      new OpenAiHttpError(
        'openai provider 404: {"error":{"message":"No endpoints found for z-ai/glm-5.3-flash.","code":404}}',
        404,
        "https://openrouter.ai/api/v1/chat/completions",
        false,
        null,
        "openrouter",
      );

    async function exhaust(): Promise<unknown> {
      const chain = makeChain(["openrouter", "local"]);
      const localDown = new TypeError("fetch failed");
      try {
        await runWithFallback(chain, async (id) => {
          throw id === "openrouter" ? cloud404() : localDown;
        });
      } catch (err) {
        expect(err).toBe(localDown);
        return err;
      }
      throw new Error("expected the chain to be exhausted");
    }

    it("throws the last link's error, classified exactly as a bare one", async () => {
      const thrown = await exhaust();
      const bare = new TypeError("fetch failed");
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toBe("fetch failed");
      expect(Object.keys(thrown as object)).toEqual(Object.keys(bare));
      expect(classifyFailure(thrown)).toBe(classifyFailure(bare));
      expect(classifyFailure(thrown)).toBe("transport");
      expect(shouldAdvance(thrown)).toEqual(shouldAdvance(bare));
      expect(isRequestSizeRejection(thrown)).toBe(false);
      expect(isNetworkError(thrown)).toBe(true);
    });

    it("carries the primary's failure beside the error it throws", async () => {
      const thrown = await exhaust();
      expect(readFailedAttempts(thrown).map((a) => a.providerId)).toEqual([
        "openrouter",
      ]);
      expect(describeFailedAttempts(thrown)).toBe(
        ' (after "openrouter" failed: openai provider 404: {"error":{"message":"No endpoints found for z-ai/glm-5.3-flash.","code":404}})',
      );
    });
  });

  it("a single-link failure carries no note", async () => {
    const chain = makeChain(["only"]);
    const err = new TypeError("fetch failed");
    await expect(
      runWithFallback(chain, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(readFailedAttempts(err)).toEqual([]);
    expect(describeFailedAttempts(err)).toBe("");
  });

  describe("a call that starts on the sticky fallback", () => {
    // A clock below the probe throttle: once on the override, later calls
    // stay there instead of probing the primary.
    function stickyChain(): ProviderFallbackChain {
      return new ProviderFallbackChain({
        resolve: () => ({
          chain: ["primary", "backup"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
        now: () => 1_000,
      });
    }

    it("still names the primary's failure when the fallback fails", async () => {
      const chain = stickyChain();
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "primary" ? http(404) : new TypeError("fetch failed");
        }),
      ).rejects.toBeInstanceOf(TypeError);

      // What every retry of a parked turn looks like: the primary is not
      // tried, only the fallback, and it is still down.
      const seen: string[] = [];
      const again = new TypeError("fetch failed");
      await expect(
        runWithFallback(chain, async (id) => {
          seen.push(id);
          throw again;
        }),
      ).rejects.toBe(again);
      expect(seen).toEqual(["backup"]);
      expect(describeFailedAttempts(again)).toBe(
        ' (after "primary" failed: boom)',
      );
    });

    it("forgets the primary's failure once a probe brings it back", async () => {
      let now = 1_000;
      const chain = new ProviderFallbackChain({
        resolve: () => ({
          chain: ["primary", "backup"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
        now: () => now,
      });
      await runWithFallback(chain, async (id) => {
        if (id === "primary") throw http(404);
        return id;
      });
      expect(chain.overrideCause()?.providerId).toBe("primary");

      now += DEFAULT_FALLBACK_TIMING.probeThrottleMs;
      await expect(runWithFallback(chain, async (id) => id)).resolves.toBe(
        "primary",
      );
      expect(chain.overrideCause()).toBeNull();
    });
  });

  describe("logging", () => {
    it("warns on every advance with the failed link's status and message", async () => {
      const warn = vi.fn();
      const chain = new ProviderFallbackChain({
        resolve: () => ({
          chain: ["cloud", "cloud2", "local"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
        logger: { warn },
      });
      const last = new TypeError("fetch failed");

      await expect(
        runWithFallback(
          chain,
          async (id) => {
            if (id === "cloud") throw http(404);
            if (id === "cloud2") throw http(503);
            throw last;
          },
          "s-1",
        ),
      ).rejects.toBe(last);

      // Two advances; the exhausted last link is the turn's own error.
      expect(warn.mock.calls).toEqual([
        [
          "provider failed; falling over to the next link",
          {
            from: "cloud",
            to: "cloud2",
            status: 404,
            reason: "boom",
            sessionId: "s-1",
          },
        ],
        [
          "provider failed; falling over to the next link",
          {
            from: "cloud2",
            to: "local",
            status: 503,
            reason: "boom",
            sessionId: "s-1",
          },
        ],
      ]);
      expect(describeFailedAttempts(last)).toBe(
        ' (after "cloud" failed: boom; "cloud2" failed: boom)',
      );
    });

    it("does not warn about a failure that does not advance", async () => {
      const warn = vi.fn();
      const chain = new ProviderFallbackChain({
        resolve: () => ({
          chain: ["primary", "backup"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
        logger: { warn },
      });
      await expect(
        runWithFallback(chain, async () => {
          throw new GrammarError("bad", "");
        }),
      ).rejects.toBeInstanceOf(GrammarError);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("rethrows immediately without switching on a non-fallover error", async () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = makeChain(["primary", "backup"], notices);
    const grammar = new GrammarError("bad", "");
    let attempts = 0;
    await expect(
      runWithFallback(chain, async () => {
        attempts += 1;
        throw grammar;
      }),
    ).rejects.toBe(grammar);
    expect(attempts).toBe(1); // never advanced
    expect(notices).toHaveLength(0);
    expect(describeFailedAttempts(grammar)).toBe("");
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  describeFailedAttempts,
  readFailedAttempts,
  readFailingLink,
} from "./failed-attempts.js";
import { runWithFallback } from "./run-with-fallback.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import type { ProviderSwitchNotice } from "./provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../provider/openai/parse-provider-error-body.js";
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

  it("rethrows the last error when the whole chain is down", async () => {
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
      // The primary is down (503), which arms its cooldown: what keeps a
      // call on the fallback.
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "primary" ? http(503) : new TypeError("fetch failed");
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

  describe("a call that starts on a stand-in after the primary refused", () => {
    // Same clock as above: inside the probe throttle, so nothing but the
    // stand-in rule sends a call back to the primary.
    function chainAt1000(ids: string[]): ProviderFallbackChain {
      return new ProviderFallbackChain({
        resolve: () => ({ chain: ids, timing: DEFAULT_FALLBACK_TIMING }),
        now: () => 1_000,
      });
    }

    it("asks the primary again: the fallback only stood in and never served", async () => {
      const chain = chainAt1000(["primary", "backup"]);
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "primary" ? http(404) : new TypeError("fetch failed");
        }),
      ).rejects.toBeInstanceOf(TypeError);

      const seen: string[] = [];
      await expect(
        runWithFallback(chain, async (id) => {
          seen.push(id);
          return id;
        }),
      ).resolves.toBe("primary");
      expect(seen).toEqual(["primary"]);
      // The probe brought it back: the override is gone.
      expect(chain.activeOverride).toBeNull();
    });

    it("keeps a fallback that served, as before", async () => {
      const chain = chainAt1000(["primary", "backup"]);
      await runWithFallback(chain, async (id) => {
        if (id === "primary") throw http(404);
        return id;
      });
      const seen: string[] = [];
      await runWithFallback(chain, async (id) => {
        seen.push(id);
        return id;
      });
      expect(seen).toEqual(["backup"]);
    });
  });

  describe("an exhausted chain whose primary refused its key", () => {
    it("throws the primary's refusal, not the last link's outage", async () => {
      const chain = makeChain(["aimlapi", "dashscope", "local"]);
      const refusal = http(401);
      await expect(
        runWithFallback(chain, async (id) => {
          if (id === "aimlapi") throw refusal;
          if (id === "dashscope") throw http(503);
          throw new TypeError("fetch failed");
        }),
      ).rejects.toBe(refusal);
      // Nothing failed before it; the later links are in the advance log.
      expect(readFailedAttempts(refusal)).toEqual([]);
      expect(readFailingLink(refusal)).toBe("aimlapi");
    });

    it("leaves the outage path to a fallback that has been serving", async () => {
      let now = 1_000;
      const chain = new ProviderFallbackChain({
        resolve: () => ({
          chain: ["primary", "backup"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
        now: () => now,
      });
      // The primary goes down and the backup serves: a real override.
      await runWithFallback(chain, async (id) => {
        if (id === "primary") throw http(503);
        return id;
      });
      now += DEFAULT_FALLBACK_TIMING.probeThrottleMs;
      // A probe finds the primary's key refused while the backup is down
      // for a moment: the backup is the route in use, so its outage is
      // the error, and the loop waits for it as before.
      const outage = new TypeError("fetch failed");
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "primary" ? http(401) : outage;
        }),
      ).rejects.toBe(outage);
      expect(readFailedAttempts(outage).map((a) => a.providerId)).toEqual([
        "primary",
      ]);
    });

    it("lets a parked turn wait for a fallback that served, asking the primary on every retry", async () => {
      const chain = new ProviderFallbackChain({
        resolve: () => ({
          chain: ["primary", "cloud2", "local"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
        now: () => 1_000,
      });
      // The primary's key is refused and cloud2 serves.
      await runWithFallback(chain, async (id) => {
        if (id === "primary") throw http(401);
        return id;
      });
      // cloud2 drops for a moment; the local link is stopped.
      const down = new TypeError("fetch failed");
      await expect(
        runWithFallback(chain, async (id) => {
          if (id === "primary") throw http(401);
          throw down;
        }),
      ).rejects.toBe(down);
      // The retry: local only stood in, so the walk starts at the primary
      // again, and still ends on the outage rather than the old refusal.
      const seen: string[] = [];
      await expect(
        runWithFallback(chain, async (id) => {
          seen.push(id);
          if (id === "primary") throw http(401);
          throw down;
        }),
      ).rejects.toBe(down);
      expect(seen).toEqual(["primary", "cloud2", "local"]);
      // cloud2 is back: the next retry is served.
      await expect(
        runWithFallback(chain, async (id) => {
          if (id === "primary") throw http(401);
          return id;
        }),
      ).resolves.toBe("cloud2");
    });

    it("leaves a refusal further down the chain to the last link, as before", async () => {
      const chain = makeChain(["primary", "backup"]);
      const last = http(401);
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "primary" ? http(503) : last;
        }),
      ).rejects.toBe(last);
      expect(readFailedAttempts(last).map((a) => a.providerId)).toEqual([
        "primary",
      ]);
    });

    it("still throws a later link's non-fallover error as is", async () => {
      const chain = makeChain(["primary", "backup"]);
      const grammar = new GrammarError("bad", "");
      await expect(
        runWithFallback(chain, async (id) => {
          if (id === "primary") throw http(401);
          throw grammar;
        }),
      ).rejects.toBe(grammar);
    });

    it("a lone primary throws its own refusal, unchanged", async () => {
      const chain = makeChain(["only"]);
      const refusal = http(401);
      await expect(
        runWithFallback(chain, async () => {
          throw refusal;
        }),
      ).rejects.toBe(refusal);
      expect(readFailedAttempts(refusal)).toEqual([]);
    });
  });

  /* Item 40: AI/ML API answered 403 "You've run out of funds", DashScope
     had no key, and the stopped local server's `fetch failed` parked the
     turn; the window named the local server. An empty account is a
     refusal like a refused key, wherever on the route it comes from. */
  describe("an account that cannot pay", () => {
    const outOfFunds = (label = "aimlapi"): OpenAiHttpError => {
      const body =
        '{"title":"Forbidden","status":403,"message":"You\'ve run out of funds. Please top up your balance or update your payment method to continue"}';
      return new OpenAiHttpError(
        `openai provider 403: ${body}`,
        403,
        "https://api.aimlapi.com/v1/chat/completions",
        false,
        null,
        label,
        undefined,
        { body: parseProviderErrorBody(body) },
      );
    };
    function chainAt(ids: string[], now: () => number): ProviderFallbackChain {
      return new ProviderFallbackChain({
        resolve: () => ({ chain: ids, timing: DEFAULT_FALLBACK_TIMING }),
        now,
      });
    }

    it("on the primary, throws its refusal rather than the last link's outage", async () => {
      const chain = makeChain(["aimlapi", "local"]);
      const refusal = outOfFunds();
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "aimlapi" ? refusal : new TypeError("fetch failed");
        }),
      ).rejects.toBe(refusal);
      expect(readFailingLink(refusal)).toBe("aimlapi");
      expect(readFailedAttempts(refusal)).toEqual([]);
    });

    it("on the primary, still lets a fallback that answers serve the call", async () => {
      const chain = makeChain(["aimlapi", "backup"]);
      await expect(
        runWithFallback(chain, async (id) => {
          if (id === "aimlapi") throw outOfFunds();
          return id;
        }),
      ).resolves.toBe("backup");
    });

    it("on the primary, asks it again next call: the stand-in proved nothing", async () => {
      const chain = chainAt(["aimlapi", "local"], () => 1_000);
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "aimlapi" ? outOfFunds() : new TypeError("fetch failed");
        }),
      ).rejects.toBeInstanceOf(OpenAiHttpError);
      const seen: string[] = [];
      await expect(
        runWithFallback(chain, async (id) => {
          seen.push(id);
          return id;
        }),
      ).resolves.toBe("aimlapi");
      expect(seen).toEqual(["aimlapi"]);
    });

    it("on the fallback that has been serving, throws its refusal with the links before it", async () => {
      let now = 1_000;
      const chain = chainAt(["primary", "cloud2", "local"], () => now);
      // The primary goes down and cloud2 serves: the route in use.
      await runWithFallback(chain, async (id) => {
        if (id === "primary") throw http(503);
        return id;
      });
      now += DEFAULT_FALLBACK_TIMING.probeThrottleMs;
      // A probe finds the primary still down, cloud2's account is now
      // empty, and the local server is stopped.
      const refusal = outOfFunds("cloud2");
      await expect(
        runWithFallback(chain, async (id) => {
          if (id === "primary") throw http(503);
          if (id === "cloud2") throw refusal;
          throw new TypeError("fetch failed");
        }),
      ).rejects.toBe(refusal);
      expect(readFailingLink(refusal)).toBe("cloud2");
      expect(readFailedAttempts(refusal).map((a) => a.providerId)).toEqual([
        "primary",
      ]);
    });

    it("on a fallback that never served, leaves the last link's error, as before", async () => {
      const chain = chainAt(["primary", "cloud2", "local"], () => 1_000);
      const down = new TypeError("fetch failed");
      await expect(
        runWithFallback(chain, async (id) => {
          if (id === "primary") throw http(503);
          if (id === "cloud2") throw outOfFunds("cloud2");
          throw down;
        }),
      ).rejects.toBe(down);
      expect(readFailedAttempts(down).map((a) => a.providerId)).toEqual([
        "primary",
        "cloud2",
      ]);
    });

    it("on the primary, leaves the outage path to a fallback that has been serving", async () => {
      let now = 1_000;
      const chain = chainAt(["primary", "backup"], () => now);
      await runWithFallback(chain, async (id) => {
        if (id === "primary") throw http(503);
        return id;
      });
      now += DEFAULT_FALLBACK_TIMING.probeThrottleMs;
      const outage = new TypeError("fetch failed");
      await expect(
        runWithFallback(chain, async (id) => {
          throw id === "primary" ? outOfFunds("primary") : outage;
        }),
      ).rejects.toBe(outage);
      expect(readFailedAttempts(outage).map((a) => a.providerId)).toEqual([
        "primary",
      ]);
    });
  });

  it("marks the thrown error with the link that threw it", async () => {
    const chain = makeChain(["cloud", "local"]);
    const last = new TypeError("fetch failed");
    await expect(
      runWithFallback(chain, async (id) => {
        if (id === "cloud") throw http(500);
        throw last;
      }),
    ).rejects.toBe(last);
    expect(readFailingLink(last)).toBe("local");
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

    it("names the errno the failed link's transport left behind", async () => {
      const warn = vi.fn();
      const chain = new ProviderFallbackChain({
        resolve: () => ({
          chain: ["cloud", "local"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
        logger: { warn },
      });
      // No response, so no status: without the errno this line reads
      // the same for a host the network cannot resolve and for one that
      // refused the connection.
      const unreachable = new OpenAiHttpError(
        "fetch failed",
        null,
        "http://x",
        false,
        null,
        "p",
        "ENOTFOUND",
      );

      await expect(
        runWithFallback(
          chain,
          async (id) => {
            if (id === "cloud") throw unreachable;
            return id;
          },
          "s-2",
        ),
      ).resolves.toBe("local");

      expect(warn.mock.calls).toEqual([
        [
          "provider failed; falling over to the next link",
          {
            from: "cloud",
            to: "local",
            status: null,
            causeCode: "ENOTFOUND",
            reason: "fetch failed",
            sessionId: "s-2",
          },
        ],
      ]);
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

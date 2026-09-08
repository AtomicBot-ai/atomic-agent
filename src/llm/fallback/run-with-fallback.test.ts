import { describe, it, expect } from "vitest";
import { runWithFallback } from "./run-with-fallback.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import type { ProviderSwitchNotice } from "./provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { GrammarError, TransportError } from "../reliability/llm-failures.js";

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

  /* The chain always ends in the configured llama-server provider, which
     on a cloud-only install is a daemon that has never run. Reporting the
     LAST failure therefore answered "why did my message fail?" with a
     socket error from a backend the operator never picked, and threw away
     the cloud provider's own sentence — the 402 that said, in words, to
     add credits or ask for fewer tokens. The head of the chain is the
     provider named in the composer chip; its failure is the answer. */
  it("reports the provider the operator is on, not the dead tail of the chain", async () => {
    const chain = makeChain(["openrouter", "local-llama"]);
    const refused = http(402);
    const localDown = new TransportError("fetch failed", null, "");
    const seen: string[] = [];
    await expect(
      runWithFallback(chain, async (id) => {
        seen.push(id);
        throw id === "openrouter" ? refused : localDown;
      }),
    ).rejects.toBe(refused);
    expect(seen).toEqual(["openrouter", "local-llama"]);
  });

  it("still reports the only failure when nothing falls over", async () => {
    const chain = makeChain(["solo"]);
    const only = http(402);
    await expect(
      runWithFallback(chain, async () => {
        throw only;
      }),
    ).rejects.toBe(only);
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
  });
});

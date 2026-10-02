import { describe, expect, it } from "vitest";

import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { readFailedAttempts, readFailingLink } from "./failed-attempts.js";
import {
  ProviderFallbackChain,
  type ProviderSwitchNotice,
} from "./provider-fallback-chain.js";
import { runWithFallback } from "./run-with-fallback.js";
import { TransportError } from "../reliability/llm-failures.js";

/**
 * A stop is not an outage. When the user stops a turn as its stream ends,
 * the request can come back as `terminated` or `fetch failed` — the
 * shape of a provider that went away. Falling over on it armed the
 * primary's breaker and set the sticky override, so the next turn ran on
 * the fallback without anyone having asked for it.
 */

function makeChain(notices: ProviderSwitchNotice[]): ProviderFallbackChain {
  return new ProviderFallbackChain({
    resolve: () => ({
      chain: ["primary", "backup"],
      timing: DEFAULT_FALLBACK_TIMING,
    }),
    noticeSink: (notice) => notices.push(notice),
  });
}

describe("runWithFallback when its caller has stopped the call", () => {
  it("rethrows the error without falling over or arming anything", async () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = makeChain(notices);
    const controller = new AbortController();
    const seen: string[] = [];

    const thrown = await runWithFallback(
      chain,
      async (id) => {
        seen.push(id);
        if (id === "primary") {
          controller.abort();
          throw new TransportError("terminated", null, "");
        }
        return `answer from ${id}`;
      },
      "s-stop",
      controller.signal,
    ).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(TransportError);
    expect(seen).toEqual(["primary"]);
    expect(notices).toEqual([]);
    expect(chain.activeOverrideFor("s-stop")).toBeNull();
    // Nothing recorded beside it: a cancelled turn is not the primary's
    // failure. The link is still named, as for every thrown error.
    expect(readFailedAttempts(thrown)).toEqual([]);
    expect(readFailingLink(thrown)).toBe("primary");

    // The next turn starts on the primary, as if nothing had happened.
    const next: string[] = [];
    const out = await runWithFallback(
      chain,
      async (id) => {
        next.push(id);
        return id;
      },
      "s-stop",
      new AbortController().signal,
    );
    expect(out).toBe("primary");
    expect(next).toEqual(["primary"]);
  });

  it("still falls over on the same failure when nobody stopped the call", async () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = makeChain(notices);
    const out = await runWithFallback(
      chain,
      async (id) => {
        if (id === "primary") throw new TransportError("terminated", null, "");
        return `answer from ${id}`;
      },
      "s-outage",
      new AbortController().signal,
    );
    expect(out).toBe("answer from backup");
    expect(notices).toHaveLength(1);
    expect(chain.activeOverrideFor("s-outage")).toBe("backup");
  });
});

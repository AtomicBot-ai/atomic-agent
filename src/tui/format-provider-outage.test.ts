import { describe, expect, it } from "vitest";

import type { ProviderWaitCause } from "../llm/reliability/provider-wait-cause.js";
import {
  formatProviderOutage,
  formatProviderOutageParts,
  formatProviderWaitNotice,
} from "./format-provider-outage.js";
import type { TuiState } from "./tui-state.js";

type Outage = NonNullable<TuiState["providerOutage"]>;

const NOW = 1_700_000_000_000;

function outage(over: Partial<Outage> = {}): Outage {
  return {
    reason: "connection refused by 127.0.0.1:8080",
    waitedMs: 0,
    maxWaitMs: 300_000,
    attempt: 1,
    phase: "parked",
    sinceTs: NOW,
    givenUp: false,
    ...over,
  };
}

describe("formatProviderOutage", () => {
  it("counts the wait against its budget while the turn is parked", () => {
    expect(formatProviderOutage(outage({ waitedMs: 14_000 }), NOW)).toBe(
      "waiting for provider 14s/300s — connection refused by 127.0.0.1:8080",
    );
  });

  it("ticks between events instead of standing still", () => {
    // `waitedMs` only moves when the loop emits another
    // `provider_waiting`, and the backoff reaches 30s between them. The
    // counter is read off the clock, so the row moves every second the
    // caller repaints it.
    const parked = outage({ waitedMs: 14_000 });
    expect(formatProviderOutage(parked, NOW + 6_000)).toBe(
      "waiting for provider 20s/300s — connection refused by 127.0.0.1:8080",
    );
  });

  it("never counts past the budget it promised", () => {
    // The loop clips the last sleep to end exactly at `maxWaitMs`; a
    // counter that ran on through it would advertise a wait that is not
    // coming.
    expect(
      formatProviderOutage(
        outage({ waitedMs: 290_000, maxWaitMs: 300_000 }),
        NOW + 60_000,
      ),
    ).toContain("300s/300s");
  });

  it("says a retry is running, and for how long", () => {
    // The gap this closes: `provider_recovered` only lands once the
    // replayed step has finished, so a step that streams for two minutes
    // used to leave the row reading `waiting for provider 8s/300s` the
    // whole time — a live retry and a hung one looked identical.
    expect(
      formatProviderOutage(
        outage({ phase: "retrying", attempt: 2, waitedMs: 6_000 }),
        NOW + 8_000,
      ),
    ).toBe("retrying provider (attempt 2) — 8s");
  });

  it("switches wording once the wait has run out", () => {
    // Different question for the operator: nothing to wait for any
    // more, so the line says the state of the link, not a countdown.
    expect(
      formatProviderOutage(
        outage({
          reason: "fetch failed",
          waitedMs: 300_000,
          attempt: 9,
          givenUp: true,
        }),
        NOW,
      ),
    ).toBe("provider unreachable — no connection");
  });

  it("says what undici's bare `terminated` actually means", () => {
    // The word reached the composer verbatim from the runtime
    // classifier and told an operator nothing. The classifier keeps it —
    // logs and the trace are matched on it — and only the readout is
    // rewritten.
    expect(formatProviderOutage(outage({ reason: "terminated" }), NOW)).toBe(
      "waiting for provider 0s/300s — connection dropped mid-reply",
    );
  });

  it.each(["socket hang up", "other side closed"])(
    "reads %s the same way — the socket died carrying the reply",
    (reason) => {
      expect(formatProviderOutage(outage({ reason }), NOW)).toContain(
        "connection dropped mid-reply",
      );
    },
  );

  it("keeps a stack tail from hiding the phrase", () => {
    expect(
      formatProviderOutage(
        outage({ reason: "socket hang up\n  at Socket.onClose" }),
        NOW,
      ),
    ).toBe("waiting for provider 0s/300s — connection dropped mid-reply");
  });

  it("keeps the line short enough for the meta bar", () => {
    // It shares a row with the route, the context readout and the mode
    // chip; a wrapped meta bar costs the composer a line.
    const line = formatProviderOutage(
      outage({
        reason:
          'Can\'t reach "aimlapi" — no response from api.aimlapi.com after three attempts, check the provider URL or your connection',
        waitedMs: 4_000,
        attempt: 2,
      }),
      NOW,
    );
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith("…")).toBe(true);
  });

  it("splits the line where it is allowed to give up columns", () => {
    // The head is what the meta bar refuses to shrink, so the counter
    // survives a narrow row; the reason grows back in when there is
    // room for it.
    expect(
      formatProviderOutageParts(
        outage({ reason: "terminated", waitedMs: 12_000 }),
        NOW,
      ),
    ).toEqual({
      head: "waiting for provider 12s/300s",
      tail: " — connection dropped mid-reply",
    });
  });

  it("gives the retrying phase no tail at all", () => {
    // It carries no reason — the attempt and its clock are the whole
    // line, and there is nothing here that may be dropped.
    expect(
      formatProviderOutageParts(
        outage({ phase: "retrying", attempt: 2 }),
        NOW + 8_000,
      ),
    ).toEqual({ head: "retrying provider (attempt 2) — 8s", tail: null });
  });

  it("keeps the given-up state readable down to two words", () => {
    expect(
      formatProviderOutageParts(
        outage({ reason: "fetch failed", givenUp: true }),
        NOW,
      ),
    ).toEqual({ head: "provider unreachable", tail: " — no connection" });
  });

  it("flattens a multi-line reason it has no rewrite for", () => {
    expect(
      formatProviderOutage(
        outage({
          reason: "ECONNRESET\n  at TLSSocket.onError",
          maxWaitMs: 60_000,
        }),
        NOW,
      ),
    ).toBe("waiting for provider 0s/60s — ECONNRESET at TLSSocket.onError");
  });
});

describe("formatProviderWaitNotice", () => {
  const TAIL =
    " The turn is paused and retries by itself for up to 5 min — Esc stops it.";
  // The e2e regression: a 200 stream the provider ended with
  // `finish_reason: "error"`, whose reason line is the humanised one.
  const ERROR_FINISH_REASON =
    '"fake" ended its reply with an error — this is on the provider, not your setup.';

  it.each<[ProviderWaitCause, string]>([
    [{ kind: "refused" }, "The model is not answering (connection refused)."],
    [{ kind: "dropped" }, "The model is not answering (connection dropped mid-reply)."],
    [{ kind: "unreachable" }, "The model is not answering (no connection)."],
    [{ kind: "timeout" }, "The model is not answering (the request timed out)."],
    [
      { kind: "loading" },
      "The model is not answering (the server is still loading the model).",
    ],
    [{ kind: "http", status: 503 }, "The model is not answering (HTTP 503)."],
    [
      { kind: "stream_error", status: 504 },
      "The model is not answering (the provider reported an error mid-reply (504)).",
    ],
    [
      { kind: "stream_error", status: null },
      "The model is not answering (the provider reported an error mid-reply).",
    ],
    [
      { kind: "error_finish" },
      "The model is not answering (the provider ended its reply with an error).",
    ],
  ])("words %j from the cause alone", (cause, lead) => {
    expect(formatProviderWaitNotice("whatever the raw line said", 300_000, false, cause)).toBe(
      `${lead}${TAIL}`,
    );
  });

  it("an error finish never reads as a status code or a retry count", () => {
    const text = formatProviderWaitNotice(ERROR_FINISH_REASON, 300_000, false, {
      kind: "error_finish",
    });
    expect(text).not.toMatch(/\b502\b/);
    expect(text).not.toContain("Tried");
    expect(text).not.toContain("server trouble");
    expect(text).toContain("the provider ended its reply with an error");
  });

  it("reads an error finish out of the text when no cause came with it", () => {
    expect(formatProviderWaitNotice(ERROR_FINISH_REASON, 300_000, false)).toBe(
      `The model is not answering (the provider ended its reply with an error).${TAIL}`,
    );
  });

  it("falls back to a neutral sentence for text it cannot vouch for", () => {
    // A humanised 5xx line cannot be told apart from one wrongly built
    // for a stream that was never a 5xx: repeat neither its code nor its count.
    const text = formatProviderWaitNotice(
      '"fake" is having server trouble (502). Tried 3 times — this is on the provider, not your setup.',
      300_000,
      false,
    );
    expect(text).toBe(`The model is not answering.${TAIL}`);
    expect(
      formatProviderWaitNotice("something odd", 300_000, false, { kind: "unknown" }),
    ).toBe(`The model is not answering.${TAIL}`);
  });

  it("still recognises the bare transport words in the text", () => {
    expect(formatProviderWaitNotice("fetch failed", 300_000, false)).toContain(
      "(no connection)",
    );
    expect(formatProviderWaitNotice("terminated", 300_000, false)).toContain(
      "(connection dropped mid-reply)",
    );
    expect(
      formatProviderWaitNotice("llama-server returned http 503: Loading model", 300_000, false),
    ).toContain("(the server is still loading the model)");
  });

  it("the meta row words the cause too", () => {
    expect(
      formatProviderOutage(
        outage({ reason: ERROR_FINISH_REASON, cause: { kind: "error_finish" } }),
        NOW,
      ),
    ).toBe("waiting for provider 0s/300s — the provider ended its reply with an error");
  });
});

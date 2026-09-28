import { describe, it, expect } from "vitest";
import { ModelError } from "../llm/reliability/llm-failures.js";
import { GrammarError } from "../llm/reliability/llm-failures.js";
import { scrubError } from "../error-reporting/error-scrubber.js";
import { parseSentryDsn } from "../error-reporting/sentry-config.js";
import { buildEnvelope } from "../error-reporting/sentry-envelope.js";
import {
  EMPTY_COMPLETION_RECOVERY_BUDGET,
  composeEmptyCompletionNotice,
  formatEmptyCompletionNotice,
  isRecoverableEmptyCompletion,
  repeatedEmptyCompletionError,
} from "./empty-completion-recovery.js";

function emptyOn(
  transport: "grammar" | "native_tools",
  stage: "initial" | "repair",
): ModelError {
  return new ModelError("empty", "model returned an empty completion", {
    transport,
    stage,
  });
}

describe("isRecoverableEmptyCompletion", () => {
  it("accepts a wholly empty native_tools completion at the initial stage", () => {
    expect(
      isRecoverableEmptyCompletion(emptyOn("native_tools", "initial")),
    ).toBe(true);
  });

  it("rejects the grammar transport, which has its own in-step repair", () => {
    expect(isRecoverableEmptyCompletion(emptyOn("grammar", "initial"))).toBe(
      false,
    );
  });

  it("rejects the repair stage, which has already had its extra attempt", () => {
    expect(
      isRecoverableEmptyCompletion(emptyOn("native_tools", "repair")),
    ).toBe(false);
  });

  it("rejects truncated and no_stop, which a second pass cannot fix", () => {
    for (const reason of ["truncated", "no_stop"] as const) {
      expect(
        isRecoverableEmptyCompletion(
          new ModelError(reason, "cut off", {
            transport: "native_tools",
            stage: "initial",
          }),
        ),
      ).toBe(false);
    }
  });

  it("rejects an untagged ModelError and everything that is not one", () => {
    expect(isRecoverableEmptyCompletion(new ModelError("empty", "x"))).toBe(
      false,
    );
    expect(isRecoverableEmptyCompletion(new GrammarError("bad", ""))).toBe(
      false,
    );
    expect(isRecoverableEmptyCompletion(new Error("nope"))).toBe(false);
    expect(isRecoverableEmptyCompletion("not an error")).toBe(false);
  });
});

describe("formatEmptyCompletionNotice", () => {
  it("says what came back, that nothing ran, and what to do", () => {
    const notice = formatEmptyCompletionNotice();
    expect(notice).toContain("completely empty");
    expect(notice).toContain("Nothing has happened yet");
    expect(notice).toContain("Answer this step now");
  });
});

describe("composeEmptyCompletionNotice", () => {
  it("returns the block alone when the step owed nothing", () => {
    expect(composeEmptyCompletionNotice(undefined)).toBe(
      formatEmptyCompletionNotice(),
    );
    expect(composeEmptyCompletionNotice("")).toBe(
      formatEmptyCompletionNotice(),
    );
  });

  it("puts the empty-reply block first, ahead of the notice already owed", () => {
    const composed = composeEmptyCompletionNotice("stop re-reading that file");
    expect(composed.startsWith(formatEmptyCompletionNotice())).toBe(true);
    expect(composed).toContain("stop re-reading that file");
  });
});

describe("repeatedEmptyCompletionError", () => {
  it("says the model returned nothing twice and keeps the diagnostic tags", () => {
    const first = emptyOn("native_tools", "initial");
    const repeated = repeatedEmptyCompletionError(first);
    expect(repeated).toBeInstanceOf(ModelError);
    expect(repeated.message).toContain("twice in a row");
    expect(repeated.message).toContain(first.message);
    expect(repeated.reason).toBe("empty");
    expect(repeated.transport).toBe("native_tools");
    expect(repeated.stage).toBe("initial");
    expect(repeated.category).toBe("model");
    expect(repeated.cause).toBe(first);
  });
});

/**
 * Characterization of the Sentry split documented on
 * `repeatedEmptyCompletionError`. Nothing here asserts a preference — it
 * pins that a first empty and a doubled empty land in DIFFERENT issues,
 * in the one fingerprint slot that causes it, so a future edit that
 * merges or re-splits them has to change this test on purpose. The
 * comment that used to claim these two group together shipped wrong from
 * v0.6.0 to v0.6.5 because nothing held it.
 */
describe("Sentry grouping of a doubled empty", () => {
  const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;
  const META = { installId: "install-1", release: "0.6.5", platform: "darwin" };

  function fingerprintOf(err: ModelError): string[] {
    const ev = scrubError(err, { source: "llm_failure" });
    const body = buildEnvelope(DSN, ev, META).body;
    const payload = JSON.parse(body.trim().split("\n")[2]!) as {
      fingerprint: string[];
      tags: Record<string, string>;
    };
    return payload.fingerprint;
  }

  function tagsOf(err: ModelError): Record<string, string> {
    const ev = scrubError(err, { source: "llm_failure" });
    const body = buildEnvelope(DSN, ev, META).body;
    return (
      JSON.parse(body.trim().split("\n")[2]!) as {
        tags: Record<string, string>;
      }
    ).tags;
  }

  it("splits the two on the causeType slot, not on the top frame", () => {
    const first = emptyOn("native_tools", "initial");
    const doubled = repeatedEmptyCompletionError(first);

    const firstPrint = fingerprintOf(first);
    const doubledPrint = fingerprintOf(doubled);

    expect(firstPrint).not.toEqual(doubledPrint);
    // Slot 3 is `causeType ?? tool ?? reason ?? transportHost`. The bare
    // throw has no cause, so it falls through to `reason`; the wrapper
    // passes `{ cause: err }`, and `causeType` wins over `reason`.
    expect(firstPrint[3]).toBe("empty");
    expect(doubledPrint[3]).toBe("ModelError");
    // The LAST slot is the top frame, and it is IDENTICAL: `pickFrames`
    // prefers the cause's stack, so the wrapper reports the frame where
    // the original was constructed, not its own. It cannot rescue the
    // grouping — a fingerprint is equal only element-wise.
    //
    // Anchored on the length and on the frame's actual value, not on a
    // bare index: `expect(doubledPrint[4]).toBe(firstPrint[4])` passes
    // vacuously (`undefined === undefined`) the moment `topFrame` moves
    // or leaves the fingerprint, which is exactly the edit this assertion
    // exists to catch. `toHaveLength(5)` is deliberate: a PR that adds a
    // fingerprint element MUST fail here and update the count knowingly.
    expect(firstPrint).toHaveLength(5);
    expect(firstPrint.at(-1)).toBe("empty-completion-recovery.test.ts");
    expect(doubledPrint.at(-1)).toBe(firstPrint.at(-1));
    // Everything else matches too, which is why the split is easy to miss.
    expect(doubledPrint.slice(0, 3)).toEqual(firstPrint.slice(0, 3));
  });

  it("puts the grammar and post-repair empties in the SAME issue as the recoverable one", () => {
    // `transport` and `stage` are Sentry tags, never fingerprint
    // elements, so all three `reason=empty` shapes the step executor can
    // throw share one issue — and only the first of them is eligible for
    // the recovery. Any volume read off the no-`cause_type` bucket has to
    // be filtered on `tool_transport` / `failure_stage` first. This pins
    // the conflation the doc comment describes; it is not an endorsement.
    const recoverable = fingerprintOf(emptyOn("native_tools", "initial"));
    const grammarInitial = fingerprintOf(emptyOn("grammar", "initial"));
    const nativeRepair = fingerprintOf(emptyOn("native_tools", "repair"));
    // The untagged shape too: the fields contribute nothing to grouping.
    const bare = fingerprintOf(new ModelError("empty", "nothing came back"));

    expect(grammarInitial).toEqual(recoverable);
    expect(nativeRepair).toEqual(recoverable);
    expect(bare).toEqual(recoverable);
    expect(recoverable[3]).toBe("empty");

    // The tags DO tell them apart — which is the whole remedy.
    expect(tagsOf(emptyOn("grammar", "initial")).tool_transport).toBe(
      "grammar",
    );
    expect(tagsOf(emptyOn("native_tools", "repair")).failure_stage).toBe(
      "repair",
    );
  });

  it("leaves the operator-facing rewrite out of the payload", () => {
    const doubled = repeatedEmptyCompletionError(
      emptyOn("native_tools", "initial"),
    );
    const body = buildEnvelope(
      DSN,
      scrubError(doubled, { source: "llm_failure" }),
      META,
    ).body;
    expect(body).not.toContain("twice in a row");
  });

  it("tags both events the same, so only cause_type tells them apart", () => {
    const first = emptyOn("native_tools", "initial");
    const doubled = repeatedEmptyCompletionError(first);
    const firstTags = tagsOf(first);
    const doubledTags = tagsOf(doubled);

    for (const tag of ["reason", "tool_transport", "failure_stage"] as const) {
      expect(doubledTags[tag]).toBe(firstTags[tag]);
    }
    expect(firstTags.cause_type).toBeUndefined();
    expect(doubledTags.cause_type).toBe("ModelError");
  });
});

describe("EMPTY_COMPLETION_RECOVERY_BUDGET", () => {
  it("buys exactly one retry, so the second empty is terminal", () => {
    expect(EMPTY_COMPLETION_RECOVERY_BUDGET).toBe(1);
  });
});

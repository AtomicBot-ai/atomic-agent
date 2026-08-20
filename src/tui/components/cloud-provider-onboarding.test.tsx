/**
 * First-run onboarding, from the angle the sibling wizard already has
 * covered: what a cancelled key check is allowed to do afterwards.
 *
 * `verifyProviderKey` samples the abort signal at the top of each probe
 * and in the fetch catch, so an abort that lands while the response body
 * is being read produces an ordinary verdict, not `"cancelled"`. Every
 * test here drives that interleaving through real key bindings and the
 * real verify path, stubbing only the disk write, the config read and
 * the network. The one exception is the gate rejection, which no real
 * provider answer produces — `verifyProviderKey` returns a verdict for
 * every transport failure it meets.
 */

import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import type { WizardVerifyGate } from "../providers/verify-wizard-before-save.js";
import { CloudProviderOnboarding } from "./cloud-provider-onboarding.js";
import { saveProviderWizardToConfig } from "../providers/save-provider-wizard.js";

vi.mock("../../config/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/index.js")>();
  return { ...original, getConfig: () => currentConfig };
});

vi.mock("../providers/save-provider-wizard.js", () => ({
  saveProviderWizardToConfig: vi.fn(() => ({
    entry: { id: "openrouter", kind: "openrouter" },
  })),
}));

/**
 * Answers queued here stand in for the next checks; anything not queued
 * runs the real gate against the stubbed fetch. `verifyProviderKey`
 * turns every transport failure into a verdict rather than a rejection,
 * so a rejected gate is the only way to reach the component's `catch`.
 */
const gateOverrides: ((signal?: AbortSignal) => Promise<WizardVerifyGate>)[] =
  [];

vi.mock("../providers/verify-wizard-before-save.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../providers/verify-wizard-before-save.js")
    >();
  return {
    ...original,
    verifyWizardBeforeSave: (
      wizard: Parameters<typeof original.verifyWizardBeforeSave>[0],
      opts: Parameters<typeof original.verifyWizardBeforeSave>[1] = {},
    ) => {
      const queued = gateOverrides.shift();
      return queued
        ? queued(opts.signal)
        : original.verifyWizardBeforeSave(wizard, opts);
    },
  };
});

const currentConfig = {
  llm: {
    activeTextProvider: "local-llama",
    activeEmbeddingProvider: "local-llama-embed",
    toolTransport: "auto",
    providers: [],
  },
} as unknown as AtomicAgentConfig;

const saveMock = vi.mocked(saveProviderWizardToConfig);

/** Written out so an editor cannot quietly eat the control character. */
const ESC = "\u001b";
const CTRL_C = "\u0003";

/** One in-flight probe, with its body read parked until the test says so. */
interface ProbeGate {
  /** Resolves once `verifyProviderKey` has started reading the body. */
  readonly bodyRequested: Promise<void>;
  /** Hands the body over, which lets `classifyVerifyResponse` run. */
  releaseBody(body: string): void;
  readonly calls: () => number;
}

/**
 * A fetch that answers instantly but hands its body over only on demand.
 * The window between the two is where the reviewer's race lives: the
 * response has arrived, so the abort no longer reaches any of the
 * signal checks inside `verifyProviderKey`.
 */
function stubGatedProbe(status = 429): ProbeGate {
  let requested = () => {};
  const bodyRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let release: (body: string) => void = () => {};
  const bodyReady = new Promise<string>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      // Model-catalog reads share this stub; only the probe completions
      // say anything about how many checks were started.
      if (String(url).includes("/chat/completions")) calls += 1;
      return {
        ok: false,
        status,
        text: () => {
          requested();
          return bodyReady;
        },
      } as unknown as Response;
    }),
  );
  return {
    bodyRequested,
    releaseBody: (body: string) => {
      release(body);
    },
    calls: () => calls,
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Long enough for Ink's 20 ms pending-escape flush to fire. */
async function settleInput(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();
}

/**
 * Walks the wizard from the provider list to the last screen before the
 * save: OpenRouter → key → chat model → embedding. The next Enter is the
 * one that starts the credential check.
 */
async function mountAtSubmitPoint(): Promise<{
  stdin: { write(data: string): void };
  onFinished: ReturnType<typeof vi.fn>;
  frame: () => string;
  unmount: () => void;
}> {
  const onFinished = vi.fn();
  const { stdin, lastFrame, unmount } = render(
    <CloudProviderOnboarding onFinished={onFinished} onBack={() => {}} />,
  );
  await settleInput();
  stdin.write("\r"); // OpenRouter
  await settleInput();
  stdin.write("sk-onboarding-test-key");
  await settleInput();
  stdin.write("\r"); // key accepted → chat model list
  await settleInput();
  stdin.write("\r"); // chat model → embedding list
  await settleInput();
  return {
    stdin,
    onFinished,
    frame: () => (lastFrame() ?? "").replace(/\[[0-9;]*m/g, ""),
    unmount,
  };
}

describe("CloudProviderOnboarding cancellation", () => {
  beforeEach(() => {
    saveMock.mockClear();
    gateOverrides.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops a verdict that arrives after Esc cancelled the check", async () => {
    const probe = stubGatedProbe();
    const { stdin, onFinished, frame, unmount } = await mountAtSubmitPoint();

    stdin.write("\r"); // Enter on the embedding list starts the check
    await probe.bodyRequested;
    await flush();
    expect(frame()).toContain("checking the key with the provider");

    stdin.write(ESC); // Esc cancels while the body is still unread
    await settleInput();
    expect(frame()).toContain("Key check cancelled");

    // The response was already on the wire, so the check finishes with an
    // ordinary verdict rather than "cancelled".
    probe.releaseBody('{"error":{"message":"rate limited"}}');
    await flush(12);

    expect(saveMock).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();
    // The screen the operator was handed back is still the one on show.
    expect(frame()).toContain("Key check cancelled");
    unmount();
  });

  it("keeps the cancelled check from overwriting the retry started after it", async () => {
    const first = stubGatedProbe();
    const { stdin, onFinished, frame, unmount } = await mountAtSubmitPoint();

    stdin.write("\r");
    await first.bodyRequested;
    await flush();

    stdin.write(ESC);
    await settleInput();

    // Enter after Esc: the operator takes the screen's own advice.
    const second = stubGatedProbe(200);
    stdin.write("\r");
    await second.bodyRequested.catch(() => {});
    await flush();
    expect(frame()).toContain("checking the key with the provider");

    // The abandoned check answers last, and its verdict would have saved.
    first.releaseBody('{"error":{"message":"rate limited"}}');
    await flush(12);
    expect(saveMock).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();

    // The retry is still the live one, and it is the one that saves.
    second.releaseBody("{}");
    await flush(12);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0]?.[0]).toBe("saved_cloud");
    unmount();
  });

  it("starts one check when two Enters are drained from stdin in one turn", async () => {
    const probe = stubGatedProbe();
    const { stdin, onFinished, unmount } = await mountAtSubmitPoint();

    // Two key events in the same turn — what a buffered stdin hands Ink
    // in one `readable` drain. Neither is cancelled, so the post-await
    // abort check cannot separate them; only the in-flight ref can.
    stdin.write("\r");
    stdin.write("\r");
    await probe.bodyRequested;
    await flush();
    expect(probe.calls()).toBe(1);

    probe.releaseBody('{"error":{"message":"rate limited"}}');
    await flush(12);
    // One check, one save, one exit — not two of each.
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps a cancelled check's failure off the retry that replaced it", async () => {
    let failFirst: (err: Error) => void = () => {};
    gateOverrides.push(
      () =>
        new Promise<WizardVerifyGate>((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    const { stdin, onFinished, frame, unmount } = await mountAtSubmitPoint();

    stdin.write("\r");
    await settleInput();
    stdin.write(ESC); // Esc
    await settleInput();
    expect(frame()).toContain("Key check cancelled");

    const retry = stubGatedProbe(200);
    stdin.write("\r");
    await retry.bodyRequested;
    await flush();

    // The abandoned run blows up after the retry took the screen. Its
    // message must not land there, and it must not free `submitting`.
    failFirst(new Error("openrouter provider network error: socket hang up"));
    await flush(12);
    expect(frame()).not.toContain("socket hang up");
    expect(frame()).toContain("checking the key with the provider");
    expect(saveMock).not.toHaveBeenCalled();

    retry.releaseBody("{}");
    await flush(12);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("drops a verdict that arrives after Ctrl+C left onboarding", async () => {
    const probe = stubGatedProbe();
    const { stdin, onFinished, unmount } = await mountAtSubmitPoint();

    stdin.write("\r");
    await probe.bodyRequested;
    await flush();

    stdin.write(CTRL_C); // Ctrl+C
    await settleInput();
    expect(onFinished).toHaveBeenCalledWith("aborted");

    probe.releaseBody('{"error":{"message":"rate limited"}}');
    await flush(12);
    expect(saveMock).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    unmount();
  });
});

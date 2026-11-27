import { describe, expect, it } from "vitest";

import { namesHintLine, readPrivacyNamesControl, snapshotPrivacyNames } from "./privacy-names.js";

const status = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  state: "ready",
  model: { provider: "lmstudio", model: "qwen3-4b" },
  ...over,
});

describe("hiding names in the Privacy tab (ATO-2527)", () => {
  it("reads the control structurally", () => {
    expect(readPrivacyNamesControl(null)).toBeNull();
    expect(readPrivacyNamesControl({})).toBeNull();
    expect(readPrivacyNamesControl({ localNames: { status: () => status() } })).toBeNull();
    const names = { status: () => status(), setEnabled: async () => {} };
    expect(readPrivacyNamesControl({ localNames: names })).toBe(names);
  });

  it("snapshots the status and never throws", () => {
    const of = (s: () => unknown) => snapshotPrivacyNames({ status: s as never, setEnabled: async () => {} });
    expect(of(() => status())).toEqual({ enabled: true, state: "ready", model: "qwen3-4b (lmstudio)" });
    expect(of(() => status({ model: { provider: "local-llama", model: null } }))?.model).toBe("local-llama");
    expect(of(() => status({ state: "no-local-model", model: null }))?.model).toBeNull();
    expect(of(() => status({ state: "weird" }))).toBeNull();
    expect(
      of(() => {
        throw new Error("x");
      }),
    ).toBeNull();
    expect(snapshotPrivacyNames(null)).toBeNull();
  });

  it("says which model reads the text and what happens without one", () => {
    const ready = { enabled: true, state: "ready" as const, model: "qwen3-4b (lmstudio)" };
    expect(namesHintLine(ready, true)).toBe(
      "Read by qwen3-4b (lmstudio) on this computer before a cloud request. If that model is not running, only emails, phone numbers, cards and keys are hidden.",
    );
    expect(namesHintLine(ready, false)).toMatch(/^Works when Privacy Shield is on\. /);
    expect(namesHintLine({ enabled: true, state: "no-local-model", model: null }, true)).toMatch(
      /^Needs a model on this computer .* None is set up, so only emails/,
    );
    expect(namesHintLine({ enabled: false, state: "off", model: "qwen3-4b (lmstudio)" }, true)).toMatch(/^Off\. When on, qwen3-4b/);
    expect(namesHintLine({ enabled: false, state: "off", model: null }, true)).toMatch(/^Off\. Needs a model/);
  });
});

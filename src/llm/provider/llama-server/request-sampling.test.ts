import { describe, expect, it } from "vitest";

import { getLocalModelDef, type LocalModelDef } from "../../../local-llm/catalog/models-catalog.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../../model-profile.js";
import { requestThinks, resolveRequestSampling } from "./request-sampling.js";

const CHAT = { system: "s", user: "u", prefixHash: "h" };

describe("requestThinks (ATO-2482)", () => {
  it("is off for a model without a reasoning channel or a caller that asked for none", () => {
    expect(requestThinks({}, PLAIN_INSTRUCT_PROFILE, "auto")).toBe(false);
    expect(requestThinks({ disableThinking: true }, QWEN_THINK_PROFILE, "auto")).toBe(false);
    expect(requestThinks({ chat: { ...CHAT, enableThinking: false } }, QWEN_THINK_PROFILE, "on")).toBe(false);
  });

  it("follows the hand-built prompt's switch, which Gemma 4 cannot turn off", () => {
    expect(requestThinks({}, QWEN_THINK_PROFILE, "off")).toBe(false);
    expect(requestThinks({}, QWEN_THINK_PROFILE, "auto")).toBe(true);
    expect(requestThinks({}, GEMMA4_THINK_PROFILE, "off")).toBe(true);
    expect(requestThinks({ chat: CHAT }, QWEN_THINK_PROFILE, "off")).toBe(true);
  });
});

describe("resolveRequestSampling (ATO-2482)", () => {
  const qwen = getLocalModelDef("qwen-3.5-4b");

  it("puts the catalog set for the request's mode over the header's values", () => {
    const profile = { ...QWEN_THINK_PROFILE, sampling: { temperature: 1, topK: 20, minP: 0.05 } };
    const off = resolveRequestSampling({ profile, def: qwen, overrides: undefined, thinks: false });
    expect(off.modelSampling).toMatchObject({ temperature: 0.7, topP: 0.8, topK: 20, minP: 0 });
    expect(off).not.toHaveProperty("userSampling");
    const on = resolveRequestSampling({ profile, def: qwen, overrides: undefined, thinks: true });
    expect(on.modelSampling).toMatchObject({ temperature: 1, topP: 0.95 });
  });

  it("keeps the header alone when no catalog entry matches", () => {
    const profile = { ...QWEN_THINK_PROFILE, sampling: { temperature: 0.6 } };
    expect(resolveRequestSampling({ profile, def: undefined, overrides: undefined, thinks: true }))
      .toEqual({ modelSampling: { temperature: 0.6 } });
    expect(resolveRequestSampling({ profile: QWEN_THINK_PROFILE, def: undefined, overrides: undefined, thinks: true }))
      .toEqual({});
  });

  it("sends the person's override as its own layer, per mode", () => {
    const res = resolveRequestSampling({
      profile: QWEN_THINK_PROFILE,
      def: qwen,
      overrides: { "qwen-3.5-4b": { temperature: 0.4, noThinking: { temperature: 0.3 } } },
      thinks: false,
    });
    expect(res.userSampling).toEqual({ temperature: 0.3 });
  });

  it("treats an added model's own sampling as the person's, under the override map", () => {
    const own = {
      ...qwen,
      id: "custom-mine",
      family: "custom",
      sampling: { temperature: 0.9, topK: 50 },
    } as LocalModelDef;
    const res = resolveRequestSampling({
      profile: QWEN_THINK_PROFILE,
      def: own,
      overrides: { "custom-mine": { temperature: 0.5 } },
      thinks: true,
    });
    expect(res.userSampling).toEqual({ temperature: 0.5, topK: 50 });
    expect(res).not.toHaveProperty("modelSampling");
  });
});

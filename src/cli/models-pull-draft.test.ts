import { describe, expect, it } from "vitest";
import { draftToPullAfter } from "./models-pull-draft.js";

const paired = { id: "gemma-4-31b" as const, draftModelId: "gemma-4-e4b" as const };
const none = () => false;

describe("draftToPullAfter (ATO-2424)", () => {
  it("fetches nothing while speculative decoding is off and --draft was not given", () => {
    expect(draftToPullAfter(paired, { draftFlag: false, preference: "off", isDownloaded: none })).toBeNull();
  });

  it("fetches the catalog's draft on --draft or with draftModel auto", () => {
    expect(draftToPullAfter(paired, { draftFlag: true, preference: "off", isDownloaded: none })).toBe("gemma-4-e4b");
    expect(draftToPullAfter(paired, { draftFlag: false, preference: "auto", isDownloaded: none })).toBe("gemma-4-e4b");
  });

  it("fetches the catalog model draftModel names, and nothing for a path", () => {
    expect(draftToPullAfter({ id: "gemma-4-12b" }, { draftFlag: false, preference: "gemma-4-e4b", isDownloaded: none })).toBe("gemma-4-e4b");
    expect(draftToPullAfter({ id: "gemma-4-12b" }, { draftFlag: false, preference: "/m/d.gguf", isDownloaded: none })).toBeNull();
  });

  it("skips a draft already on disk, a model with no pairing, and the model itself", () => {
    expect(draftToPullAfter(paired, { draftFlag: true, preference: "auto", isDownloaded: () => true })).toBeNull();
    expect(draftToPullAfter({ id: "qwen-3.5-9b" }, { draftFlag: true, preference: "auto", isDownloaded: none })).toBeNull();
    expect(draftToPullAfter({ id: "gemma-4-e4b" }, { draftFlag: false, preference: "gemma-4-e4b", isDownloaded: none })).toBeNull();
  });
});

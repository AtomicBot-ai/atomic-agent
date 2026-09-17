import { describe, expect, it } from "vitest";

import type { ToolDescriptor } from "../prompt/stable-prefix.js";
import {
  narrowDescriptorsToToolSet,
  toolSetAdmits,
  toolSetRefusal,
  type StepToolSet,
} from "./step-tool-set.js";

const SET: StepToolSet = {
  names: ["fusion.delegate", "reply", "finish"],
  reason: "review stalled: delegate or reply",
};

const d = (name: string): ToolDescriptor => ({
  name,
  summary: name,
  argsSchema: "{}",
});

describe("step-tool-set", () => {
  it("admits exactly its names", () => {
    expect(toolSetAdmits(SET, "reply")).toBe(true);
    expect(toolSetAdmits(SET, "fusion.delegate")).toBe(true);
    expect(toolSetAdmits(SET, "os.fs.read")).toBe(false);
  });

  it("narrows a descriptor list to the set, and returns the same array when nothing is removed", () => {
    const all = [d("os.fs.read"), d("fusion.delegate"), d("reply"), d("finish")];
    expect(narrowDescriptorsToToolSet(all, SET).map((x) => x.name)).toEqual([
      "fusion.delegate",
      "reply",
      "finish",
    ]);
    const already = [d("reply"), d("finish")];
    // Identity matters: the native-tools adapter memoises on it.
    expect(narrowDescriptorsToToolSet(already, SET)).toBe(already);
  });

  it("the refusal opens with the reason and names the exits", () => {
    const refusal = toolSetRefusal("os.fs.read", SET);
    expect(refusal.status).toBe("error");
    expect(refusal.summary).toBe(
      "review stalled: delegate or reply: `os.fs.read` was not run; this step admits only `fusion.delegate`, `reply`, `finish`",
    );
    expect(refusal.details).toEqual({
      tool_set: true,
      tool: "os.fs.read",
      admitted: ["fusion.delegate", "reply", "finish"],
    });
  });
});

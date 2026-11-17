import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_DESCRIPTORS_B } from "../../prompt/default-tool-descriptors-b.js";
import { MAX_DELEGATE_TASKS } from "./delegate-args.js";

describe("fusion.delegate task cap (ATO-1515)", () => {
  it("tells the model the same task cap the parser enforces", () => {
    const descriptor = DEFAULT_TOOL_DESCRIPTORS_B.find(
      (d) => d.name === "fusion.delegate",
    );
    expect(descriptor).toBeDefined();
    expect(JSON.stringify(descriptor)).toContain(`}] /* 1..${MAX_DELEGATE_TASKS} */`);
  });
});

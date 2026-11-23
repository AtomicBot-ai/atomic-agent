import { describe, expect, it } from "vitest";

import { reconcileWorkerLabel, SaidOnce, servedModelName } from "./served-model-label.js";

describe("servedModelName (ATO-1562)", () => {
  it("prefers the server's alias, and shows a path as its file name", () => {
    expect(servedModelName({ model_alias: "huihui-qwen3.8-27b-abliterated" })).toBe("huihui-qwen3.8-27b-abliterated");
    expect(servedModelName({ model_alias: "", model_path: "/models/Qwen3.8-27B-Q4_K_M.gguf" })).toBe("Qwen3.8-27B-Q4_K_M");
    expect(servedModelName({ model_alias: "C:\\models\\gemma-4.gguf" })).toBe("gemma-4");
  });

  it("is null when the server names no model", () => {
    expect(servedModelName({})).toBeNull();
    expect(servedModelName({ model_alias: "  ", model_path: 3 })).toBeNull();
  });
});

describe("reconcileWorkerLabel (ATO-1562)", () => {
  it("labels with the served model and says so when the pick differs", () => {
    expect(reconcileWorkerLabel("qwen3.8-27b", "huihui")).toEqual({
      label: "huihui",
      mismatch: "Selected qwen3.8-27b, but the server serves huihui. The model is changed on the server side.",
    });
  });

  it("says nothing when the pick matches or nothing was picked, and keeps the pick without a served name", () => {
    expect(reconcileWorkerLabel("same", "same")).toEqual({ label: "same" });
    expect(reconcileWorkerLabel(null, "served")).toEqual({ label: "served" });
    expect(reconcileWorkerLabel("picked", null)).toEqual({ label: "picked" });
  });
});

describe("SaidOnce", () => {
  it("is true once per session and text", () => {
    const said = new SaidOnce();
    expect(said.add("s1", "note")).toBe(true);
    expect(said.add("s1", "note")).toBe(false);
    expect(said.add("s2", "note")).toBe(true);
    expect(said.add("s1", "other")).toBe(true);
  });
});

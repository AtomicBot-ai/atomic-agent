import { describe, expect, it } from "vitest";

import { resolveModelLabel } from "./resolve-model-label.js";

type Routes = Record<string, unknown>;

function fakeFetch(routes: Routes, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    if (!(url in routes)) return { ok: false, json: async () => null };
    const body = routes[url];
    if (body instanceof Error) throw body;
    return { ok: true, json: async () => body };
  };
}

describe("resolveModelLabel", () => {
  it("uses ATOMIC_AGENT_EVAL_MODEL_ID first", async () => {
    const seen: string[] = [];
    const label = await resolveModelLabel(
      { ATOMIC_AGENT_EVAL_MODEL_ID: " pinned-model ", ATOMIC_AGENT_EVAL_LLAMA_URL: "http://h:1" },
      fakeFetch({}, seen),
    );
    expect(label).toBe("pinned-model");
    expect(seen).toEqual([]);
  });

  it("says so when no server URL is set", async () => {
    expect(await resolveModelLabel({}, fakeFetch({}))).toMatch(/not set/);
  });

  it("reads /v1/models and strips a trailing /v1", async () => {
    const label = await resolveModelLabel(
      { ATOMIC_AGENT_EVAL_LLAMA_URL: "http://h:1/v1/" },
      fakeFetch({ "http://h:1/v1/models": { data: [{ id: "model-a" }] } }),
    );
    expect(label).toBe("model-a");
  });

  it("falls back to /props alias, then the file name of model_path", async () => {
    expect(
      await resolveModelLabel(
        { ATOMIC_AGENT_EVAL_LLAMA_URL: "http://h:1" },
        fakeFetch({ "http://h:1/v1/models": new Error("down"), "http://h:1/props": { model_alias: "alias-b" } }),
      ),
    ).toBe("alias-b");
    expect(
      await resolveModelLabel(
        { ATOMIC_AGENT_EVAL_LLAMA_URL: "http://h:1" },
        fakeFetch({ "http://h:1/props": { model_path: "/models/dir/model-c.gguf" } }),
      ),
    ).toBe("model-c.gguf");
  });

  it("never throws when nothing answers", async () => {
    const label = await resolveModelLabel({ ATOMIC_AGENT_EVAL_LLAMA_URL: "http://h:1" }, fakeFetch({}));
    expect(label).toMatch(/^unknown/);
  });
});

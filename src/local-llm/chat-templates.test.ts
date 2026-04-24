import { describe, expect, it } from "vitest";

import { resolveChatTemplatePath } from "./chat-templates.js";
import { getLocalModelDef } from "./models-catalog.js";

describe("chat-templates", () => {
  it("resolves qwen3.5 jinja when asset exists in repo", () => {
    const path = resolveChatTemplatePath(getLocalModelDef("qwen-3.5-4b"));
    expect(path).not.toBeNull();
    expect(path!.endsWith("qwen3.5-chat-template.jinja")).toBe(true);
  });

  it("returns null when model has no template asset", () => {
    expect(resolveChatTemplatePath(getLocalModelDef("gemma-4-e4b"))).toBeNull();
  });
});

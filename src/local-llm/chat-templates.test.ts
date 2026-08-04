import { describe, expect, it } from "vitest";

import { resolveChatTemplatePath } from "./chat-templates.js";
import { getLocalModelDef, LOCAL_MODELS_CATALOG } from "./models-catalog.js";

describe("chat-templates", () => {
  it("returns null when model has no template asset", () => {
    expect(resolveChatTemplatePath(getLocalModelDef("gemma-4-e4b"))).toBeNull();
  });

  // Regression guard for the managed-mode hang: `--chat-template-file`
  // overrides what `llama-server` reports at `/props.chat_template`, which
  // is the only signal `detectModelProfile` has. Shipping a template that
  // omits the model's reasoning markers silently demotes a thinking model
  // to `plain-instruct`, which strips the reasoning prelude out of the
  // GBNF root — the sampler is then forced to open with `[` and stalls in
  // the unbounded `ws` rule until `n_predict`. No catalog model should
  // override its GGUF's own template unless the override preserves those
  // markers.
  it("ships no chat-template override for any catalog model", () => {
    const overriding = LOCAL_MODELS_CATALOG.filter((m) => m.chatTemplateAsset);
    expect(overriding.map((m) => m.id)).toEqual([]);
  });

  it("resolves every declared template asset to a file on disk", () => {
    for (const model of LOCAL_MODELS_CATALOG) {
      if (!model.chatTemplateAsset) continue;
      expect(resolveChatTemplatePath(model), model.id).not.toBeNull();
    }
  });
});

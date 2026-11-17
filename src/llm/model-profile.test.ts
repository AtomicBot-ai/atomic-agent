import { describe, expect, it } from "vitest";

import {
  detectModelProfile,
  detectModelProfileWithMatch,
  extractTotalSlots,
  detectAudioSupport,
  detectVisionSupport,
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "./model-profile.js";
import {
  GEMMA4_PROPS,
  GPT_OSS_PROPS,
  LLAMA3_PROPS,
  NEMOTRON_BOLT_E4B_PROPS,
  NEMOTRON_PROPS,
  QWEN3_PROPS,
} from "./model-profile.fixtures.js";

describe("extractTotalSlots", () => {
  it("reads a positive integer slot count", () => {
    expect(extractTotalSlots({ total_slots: 2 })).toBe(2);
  });

  // Falling back to `null` (and thus the conservative SlotManager default)
  // is deliberate: llama.cpp wraps an out-of-range id into another
  // session's slot rather than erroring, so guessing high corrupts cache
  // affinity silently.
  it("collapses missing, non-numeric, and sub-1 values to null", () => {
    for (const raw of [undefined, null, "2", 0, -1, Number.NaN, Infinity]) {
      expect(extractTotalSlots({ total_slots: raw })).toBeNull();
    }
    expect(extractTotalSlots({})).toBeNull();
  });

  it("truncates a fractional count", () => {
    expect(extractTotalSlots({ total_slots: 2.9 })).toBe(2);
  });
});

describe("detectModelProfile", () => {
  it("detects qwen think profile from props", () => {
    expect(detectModelProfile(QWEN3_PROPS)).toEqual(QWEN_THINK_PROFILE);
  });

  it("falls back to plain profile for llama style instruct templates", () => {
    expect(detectModelProfile(LLAMA3_PROPS)).toEqual(PLAIN_INSTRUCT_PROFILE);
  });

  it("marks a plain template that reads enable_thinking as switchable (F31)", () => {
    const glmLike = {
      model_alias: "glm-4-9b-chat",
      chat_template:
        "[gMASK]<sop>{% for m in messages %}<|{{ m['role'] }}|>\n{{ m['content'] }}{% endfor %}{% if enable_thinking is defined and not enable_thinking %}<|assistant|>\n<think></think>{% endif %}",
    };
    expect(detectModelProfile(glmLike)).toEqual({
      ...PLAIN_INSTRUCT_PROFILE,
      supportsThinkingSwitch: true,
    });
    expect(detectModelProfile(LLAMA3_PROPS).supportsThinkingSwitch).toBeUndefined();
  });

  it("detects gemma 4 think profile from channel tags", () => {
    expect(detectModelProfile(GEMMA4_PROPS)).toEqual(GEMMA4_THINK_PROFILE);
  });

  // Nemotron has no profile of its own: its ChatML template is qwen-shaped,
  // so the dedicated detector deliberately maps onto QWEN_THINK_PROFILE. The
  // contract under test is that the Nemotron template yields the think-tags
  // reasoning profile at all — deleting the branch drops it to plain-instruct
  // and silently kills the reasoning channel.
  it("maps the nemotron ChatML + enable_thinking template onto the think-tags profile", () => {
    const profile = detectModelProfile(NEMOTRON_PROPS);
    expect(profile).toEqual(QWEN_THINK_PROFILE);
    expect(profile.reasoningStyle).toBe("think-tags");
  });

  // ATO-1294. A fine-tune with the full ChatML + `<think>` thinking
  // template keeps its reasoning channel under a neutral alias: the
  // template alone is enough when it is the exact framing the qwen
  // profile reproduces.
  it("resolves a neutral-alias ChatML + <think> template from the template alone", () => {
    for (const props of [NEMOTRON_PROPS, QWEN3_PROPS]) {
      const detected = detectModelProfileWithMatch({
        ...props,
        model_alias: "some-other-chatml-think-model",
      });
      expect(detected.profile).toEqual(QWEN_THINK_PROFILE);
      expect(detected.matchedBy).toBe("template");
    }
  });

  // The Nemotron gate still matters for a template that is not ChatML:
  // without ChatML markers the template alone does not classify, and the
  // `nemotron` name hint is what tips it onto the think-tags profile.
  it("requires a nemotron alias when the template is not the ChatML framing", () => {
    const nonChatMl = NEMOTRON_PROPS.chat_template.replaceAll(
      "<|im_start|>",
      "<|turn_start|>",
    );
    expect(
      detectModelProfile({
        ...NEMOTRON_PROPS,
        chat_template: nonChatMl,
        model_alias: "some-other-chatml-think-model",
      }),
    ).toEqual({
      // Plain, but the template does read `enable_thinking` (F31).
      ...PLAIN_INSTRUCT_PROFILE,
      supportsThinkingSwitch: true,
    });
    const named = detectModelProfileWithMatch({
      ...NEMOTRON_PROPS,
      chat_template: nonChatMl,
    });
    expect(named.profile).toEqual(QWEN_THINK_PROFILE);
    expect(named.matchedBy).toBe("name");
  });

  it("keeps a ChatML template plain when the generation prompt does not open <think>", () => {
    // Non-thinking ChatML fine-tune: reads `enable_thinking` and strips old
    // think blocks from history, but never writes `<think>` at the
    // generation point.
    const historyStripOnly = {
      model_alias: "my-finetune",
      chat_template:
        "{%- for m in messages -%}{{- '<|im_start|>' + m['role'] + '\\n' -}}" +
        "{%- set c = m['content'].split('</think>')[-1] if '<think>' in m['content'] else m['content'] -%}" +
        "{{- c -}}{{- '<|im_end|>\\n' -}}{%- endfor -%}" +
        "{%- if add_generation_prompt -%}{{- '<|im_start|>assistant\\n' -}}{%- endif -%}" +
        "{%- if enable_thinking is defined -%}{%- endif -%}",
    };
    const detected = detectModelProfileWithMatch(historyStripOnly);
    expect(detected.profile.id).toBe("plain-instruct");
    expect(detected.matchedBy).toBe("fallback");
  });

  it("keeps a GLM-like template plain under a neutral alias", () => {
    const glmLike = {
      model_alias: "my-local-model",
      chat_template:
        "[gMASK]<sop>{% for m in messages %}<|{{ m['role'] }}|>\n{{ m['content'] }}{% endfor %}{% if add_generation_prompt %}<|assistant|>\n<think>{% endif %}{% if enable_thinking is defined and not enable_thinking %}<think></think>{% endif %}",
    };
    expect(detectModelProfile(glmLike).id).toBe("plain-instruct");
  });

  it("reports what matched: name for an alias-gated profile, fallback for plain", () => {
    expect(detectModelProfileWithMatch(QWEN3_PROPS).matchedBy).toBe("name");
    expect(detectModelProfileWithMatch(LLAMA3_PROPS).matchedBy).toBe("fallback");
    expect(detectModelProfileWithMatch(GEMMA4_PROPS).matchedBy).toBe("template");
  });

  // Pins branch ordering. This alias satisfies BOTH gates (it contains
  // "qwen" and "nemotron"), which is the only input where the order of the
  // two branches is observable: whichever runs first decides. The qwen
  // branch runs first, so the qwen gate must win. Both branches currently
  // yield QWEN_THINK_PROFILE, so this is pinned on the gate that fired
  // rather than on the returned object.
  it("lets the qwen gate win when an alias matches both the qwen and nemotron hints", () => {
    const alias = "qwen-nemotron-hybrid-think";
    // Guard: the alias really does trip both gates, so the assertion below
    // is about ordering and not about one gate quietly failing to match.
    expect(alias).toContain("qwen");
    expect(alias).toContain("nemotron");
    expect(
      detectModelProfile({ ...NEMOTRON_PROPS, model_alias: alias }),
    ).toEqual(QWEN_THINK_PROFILE);
  });

  it("falls back to plain profile for gpt-oss style templates", () => {
    expect(detectModelProfile(GPT_OSS_PROPS)).toEqual(PLAIN_INSTRUCT_PROFILE);
  });

  // ATO-879. Bolt E4B is a Gemma 4 fine-tune named "nemotron": the old
  // alias-gated detectors sent it to plain-instruct (the nemotron gate
  // wants a `<think>` template, the gemma gate a `gemma` alias) and the
  // thinking channel was lost. The Gemma 4 template alone decides now.
  describe("Gemma 4 template under another name (Nemotron 3.5 Bolt E4B)", () => {
    it("resolves gemma4-think for a file-path alias", () => {
      expect(NEMOTRON_BOLT_E4B_PROPS.model_alias).toContain("Nemotron");
      expect(NEMOTRON_BOLT_E4B_PROPS.model_alias).not.toMatch(/gemma/i);
      expect(detectModelProfile(NEMOTRON_BOLT_E4B_PROPS)).toEqual(
        GEMMA4_THINK_PROFILE,
      );
    });

    it("resolves the same profile under the managed custom id, the old workaround alias and no alias", () => {
      for (const model_alias of [
        "custom-nvidia-nvidia-nemotron-3.5-bolt-e4b-4gb-nvidia-nemotron-3.5-bolt-e4b-q4_k_m",
        "nemotron-bolt-e4b-gemma4",
        "nemotron-bolt",
        "",
      ]) {
        expect(
          detectModelProfile({ ...NEMOTRON_BOLT_E4B_PROPS, model_alias }),
        ).toEqual(GEMMA4_THINK_PROFILE);
      }
    });

    it("wins over a qwen- or nemotron-named alias, which would mean a ChatML <think> prefill", () => {
      expect(
        detectModelProfile({
          ...NEMOTRON_BOLT_E4B_PROPS,
          model_alias: "qwen-nemotron-gemma-merge",
          // A history-stripping mention of `<think>` and the Qwen switch must
          // not pull a `<|turn>`-framed template onto the qwen profile.
          chat_template:
            NEMOTRON_BOLT_E4B_PROPS.chat_template +
            "{%- set content = content.split('</think>')[-1] if '<think>' in content else content -%}",
        }),
      ).toEqual(GEMMA4_THINK_PROFILE);
    });

    it("needs the whole native framing — a template that only mentions the channel tags stays plain", () => {
      // ChatML template that strips Gemma-style thought channels out of
      // history: it names `<|channel>thought` and `<channel|>` but never
      // writes `<|turn>system`, `<|think|>` or `<|turn>model`.
      const mentionsOnly = {
        model_alias: "/models/Some-Nemotron-Merge-Q4_K_M.gguf",
        chat_template:
          "{%- for m in messages -%}{{- '<|im_start|>' + m['role'] + '\\n' -}}" +
          "{%- if '<|channel>thought' in m['content'] -%}{{- m['content'].split('<channel|>')[-1] -}}" +
          "{%- else -%}{{- m['content'] -}}{%- endif -%}{{- '<|im_end|>\\n' -}}{%- endfor -%}" +
          "{%- if add_generation_prompt -%}{{- '<|im_start|>assistant\\n' -}}{%- endif -%}",
      };
      expect(detectModelProfile(mentionsOnly)).toEqual(PLAIN_INSTRUCT_PROFILE);
      // Missing just the `<|think|>` switch is enough to keep it plain.
      expect(
        detectModelProfile({
          ...NEMOTRON_BOLT_E4B_PROPS,
          chat_template: NEMOTRON_BOLT_E4B_PROPS.chat_template.replaceAll(
            "<|think|>",
            "",
          ),
        }).id,
      ).toBe("plain-instruct");
    });
  });

  // Managed serves a catalog id as the alias, external the model path or
  // any `--alias`: the GGUF file name from `/props.model_path` is read as
  // a name hint too, so the same file resolves the same profile.
  describe("model_path as a name hint", () => {
    it("classifies a nemotron GGUF served under a neutral alias", () => {
      expect(
        detectModelProfile({
          ...NEMOTRON_PROPS,
          model_alias: "my-local-model",
          model_path: "/models/NVIDIA-Nemotron-3.5-30B-A3B-Q4_K_M.gguf",
        }),
      ).toEqual(QWEN_THINK_PROFILE);
    });

    it("reads a Windows path's file name", () => {
      expect(
        detectModelProfile({
          ...QWEN3_PROPS,
          model_alias: "local",
          model_path: "C:\\models\\Qwen3.5-4B-Q4_K_M.gguf",
        }),
      ).toEqual(QWEN_THINK_PROFILE);
    });

    it("ignores directory names — only the file name counts", () => {
      expect(
        detectModelProfile({
          ...NEMOTRON_PROPS,
          // Not ChatML, so the template alone does not classify (ATO-1294)
          // and only a name hint could — which the directory must not give.
          chat_template: NEMOTRON_PROPS.chat_template.replaceAll(
            "<|im_start|>",
            "<|turn_start|>",
          ),
          model_alias: "some-other-chatml-think-model",
          model_path: "/home/me/nemotron/llama-3.1-8b-instruct.gguf",
        }).id,
      ).toBe("plain-instruct");
    });

    it("keeps the alias-only result when model_path is absent", () => {
      expect(detectModelProfile(NEMOTRON_PROPS)).toEqual(QWEN_THINK_PROFILE);
      expect(detectModelProfile(GEMMA4_PROPS)).toEqual(GEMMA4_THINK_PROFILE);
    });
  });

  it("reads context window from default_generation_settings.n_ctx", () => {
    const profile = detectModelProfile({
      ...QWEN3_PROPS,
      default_generation_settings: { n_ctx: 32768 },
    });
    expect(profile.id).toBe("qwen-think");
    expect(profile.contextWindow).toBe(32768);
  });

  it("falls back to root-level n_ctx when nested setting is absent", () => {
    const profile = detectModelProfile({
      ...LLAMA3_PROPS,
      n_ctx: 4096,
    });
    expect(profile.id).toBe("plain-instruct");
    expect(profile.contextWindow).toBe(4096);
  });

  it("leaves context window undefined when neither field is present", () => {
    const profile = detectModelProfile(LLAMA3_PROPS);
    expect(profile.contextWindow).toBeUndefined();
  });

  it("ignores non-positive n_ctx values", () => {
    const profile = detectModelProfile({
      ...LLAMA3_PROPS,
      default_generation_settings: { n_ctx: 0 },
      n_ctx: -10,
    });
    expect(profile.contextWindow).toBeUndefined();
  });

  it("defaults vision to absent for text-only props payloads", () => {
    expect(detectModelProfile(QWEN3_PROPS).vision).toEqual({
      supported: false,
      source: "absent",
    });
  });

  it("detects vision via modalities.vision flag (current llama.cpp surface)", () => {
    const profile = detectModelProfile({
      ...GEMMA4_PROPS,
      modalities: { vision: true, audio: false },
    });
    expect(profile.vision).toEqual({
      supported: true,
      source: "modalities.vision",
    });
  });

  it("detects audio input only from modalities.audio (ATO-497)", () => {
    expect(detectAudioSupport({ modalities: { vision: false, audio: true } })).toEqual({
      supported: true,
      source: "modalities.audio",
    });
    // A projector that says nothing about audio is not an audio model.
    expect(detectAudioSupport({ has_multimodal: true, mmproj: {} })).toEqual({
      supported: false,
      source: "absent",
    });
    expect(detectAudioSupport({})).toEqual({ supported: false, source: "absent" });
  });

  it("sets profile.audio only when /props says the model hears", () => {
    expect(
      detectModelProfile({ ...GEMMA4_PROPS, modalities: { vision: true, audio: true } }).audio,
    ).toEqual({ supported: true, source: "modalities.audio" });
    expect("audio" in detectModelProfile(QWEN3_PROPS)).toBe(false);
  });

  it("ignores modalities.audio when vision is false", () => {
    expect(
      detectVisionSupport({ modalities: { vision: false, audio: true } }),
    ).toEqual({
      supported: false,
      source: "absent",
    });
  });

  it("prefers modalities.vision over legacy has_multimodal", () => {
    expect(
      detectVisionSupport({
        modalities: { vision: true },
        has_multimodal: true,
      }),
    ).toEqual({
      supported: true,
      source: "modalities.vision",
    });
  });

  it("detects vision via top-level has_multimodal flag", () => {
    const profile = detectModelProfile({
      ...GEMMA4_PROPS,
      has_multimodal: true,
    });
    expect(profile.vision).toEqual({
      supported: true,
      source: "has_multimodal",
    });
  });

  it("detects vision via legacy `multimodal: true` flag", () => {
    expect(detectVisionSupport({ multimodal: true })).toEqual({
      supported: true,
      source: "multimodal",
    });
  });

  it("detects vision when `mmproj` is a non-null object", () => {
    expect(
      detectVisionSupport({ mmproj: { path: "/tmp/mmproj-F16.gguf" } }),
    ).toEqual({
      supported: true,
      source: "mmproj",
    });
  });

  it("detects vision via default_generation_settings.has_multimodal", () => {
    expect(
      detectVisionSupport({
        default_generation_settings: { has_multimodal: true },
      }),
    ).toEqual({
      supported: true,
      source: "default_generation_settings.has_multimodal",
    });
  });

  it("returns absent for non-object mmproj values", () => {
    expect(detectVisionSupport({ mmproj: null })).toEqual({
      supported: false,
      source: "absent",
    });
    expect(detectVisionSupport({ mmproj: "ignored-string" })).toEqual({
      supported: false,
      source: "absent",
    });
  });
});

import { describe, expect, it } from "vitest";

import { buildLlamaServerArgs, type DaemonStartOptions } from "./daemon-lifecycle.js";

const baseOpts: DaemonStartOptions = {
  dataDir: "/tmp/data",
  modelId: "qwen-3.5-4b",
  port: 19091,
};

describe("buildLlamaServerArgs", () => {
  it("emits the canonical text-only flag set in stable order", () => {
    const args = buildLlamaServerArgs(
      baseOpts,
      "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
      "qwen-3.5-4b",
    );
    expect(args).toEqual([
      "--no-webui",
      "--jinja",
      "-m",
      "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
      "--port",
      "19091",
      "--host",
      "127.0.0.1",
      "-ngl",
      "-1",
      "--flash-attn",
      "auto",
      "--cache-type-k",
      "turbo3",
      "--cache-type-v",
      "turbo3",
      "--parallel",
      "2",
      "-kvu",
      "-a",
      "qwen-3.5-4b",
    ]);
    expect(args).not.toContain("--mmproj");
    expect(args).not.toContain("--chat-template-file");
  });

  it("appends --chat-template-file when chatTemplateFile is set", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, chatTemplateFile: "/tmp/templates/qwen.jinja" },
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
    );
    const idx = args.indexOf("--chat-template-file");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/templates/qwen.jinja");
  });

  it("appends --mmproj and vision-token / batch flags when mmprojFile is set", () => {
    const args = buildLlamaServerArgs(
      {
        ...baseOpts,
        mmprojFile: "/tmp/data/models/qwen-3.5-4b/mmproj-F16.gguf",
      },
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
    );
    const idx = args.indexOf("--mmproj");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/data/models/qwen-3.5-4b/mmproj-F16.gguf");
    // Vision-token + ubatch flags ride along whenever --mmproj is present.
    // Without these defaults, Gemma-4 / Qwen-VL hallucinate image content.
    expect(args).toContain("--image-min-tokens");
    expect(args).toContain("--image-max-tokens");
    expect(args).toContain("--ubatch-size");
    expect(args).toContain("--batch-size");
    expect(args[args.indexOf("--image-min-tokens") + 1]).toBe("560");
    expect(args[args.indexOf("--image-max-tokens") + 1]).toBe("560");
    expect(args[args.indexOf("--ubatch-size") + 1]).toBe("1024");
    expect(args[args.indexOf("--batch-size") + 1]).toBe("2048");
  });

  it("does NOT emit vision flags when mmprojFile is absent", () => {
    const args = buildLlamaServerArgs(
      baseOpts,
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
    );
    expect(args).not.toContain("--image-min-tokens");
    expect(args).not.toContain("--image-max-tokens");
    expect(args).not.toContain("--ubatch-size");
    expect(args).not.toContain("--batch-size");
  });

  it("emits both --chat-template-file and --mmproj together", () => {
    const args = buildLlamaServerArgs(
      {
        ...baseOpts,
        chatTemplateFile: "/tpl.jinja",
        mmprojFile: "/proj.gguf",
      },
      "/m.gguf",
      "alias",
    );
    expect(args).toContain("--chat-template-file");
    expect(args).toContain("/tpl.jinja");
    expect(args).toContain("--mmproj");
    expect(args).toContain("/proj.gguf");
  });
});

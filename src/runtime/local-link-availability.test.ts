import { describe, expect, it } from "vitest";

import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import { isLocalLinkWithoutModel } from "./local-link-availability.js";

const MANAGED_URL = "http://127.0.0.1:8090";

function llm(localUrl?: string): ResolvedLlmConfig {
  return {
    activeTextProvider: "claude-cli",
    activeEmbeddingProvider: "local-llama",
    toolTransport: "auto",
    providers: [
      { id: "claude-cli", kind: "subscription-cli" },
      {
        id: "local-llama",
        kind: "llama-server",
        ...(localUrl !== undefined ? { url: localUrl } : {}),
      },
    ],
  };
}

function cfg(
  mode: "managed" | "external",
  modelId: string | null,
): Parameters<typeof isLocalLinkWithoutModel>[2] {
  return {
    localModels: {
      mode,
      url: MANAGED_URL,
      managed: { modelId },
    },
    paths: { localModelsDataDir: "/data" },
  } as unknown as Parameters<typeof isLocalLinkWithoutModel>[2];
}

const onDisk = (present: boolean) => () => present;

describe("isLocalLinkWithoutModel", () => {
  it("is the managed link whose model was never pulled", () => {
    // ATO-117: the fallback behind a missing `claude` on Windows.
    expect(
      isLocalLinkWithoutModel(
        llm(MANAGED_URL),
        "local-llama",
        cfg("managed", "qwen3.5-4b"),
        onDisk(false),
      ),
    ).toBe(true);
  });

  it("is the managed link with no model selected at all", () => {
    expect(
      isLocalLinkWithoutModel(llm(), "local-llama", cfg("managed", null)),
    ).toBe(true);
  });

  it("is not the managed link once its model is on disk", () => {
    expect(
      isLocalLinkWithoutModel(
        llm(MANAGED_URL),
        "local-llama",
        cfg("managed", "qwen3.5-4b"),
        onDisk(true),
      ),
    ).toBe(false);
  });

  it("never judges an external server", () => {
    expect(
      isLocalLinkWithoutModel(llm(), "local-llama", cfg("external", null)),
    ).toBe(false);
    // An entry with a URL of its own is somebody else's server.
    expect(
      isLocalLinkWithoutModel(
        llm("http://192.168.1.5:8080"),
        "local-llama",
        cfg("managed", null),
      ),
    ).toBe(false);
  });

  it("never judges a link that is not llama-server", () => {
    expect(
      isLocalLinkWithoutModel(llm(), "claude-cli", cfg("managed", null)),
    ).toBe(false);
    expect(
      isLocalLinkWithoutModel(llm(), "unknown", cfg("managed", null)),
    ).toBe(false);
  });
});

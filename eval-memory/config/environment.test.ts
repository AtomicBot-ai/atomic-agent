import { describe, it, expect } from "vitest";

import {
  captureEnvironmentSnapshot,
  captureGitProvenance,
  diffSnapshots,
  readAgentVersion,
  CAMPAIGN_SAMPLING,
  type EnvironmentSnapshot,
} from "./environment.js";

describe("readAgentVersion", () => {
  it("returns a non-empty string", () => {
    const v = readAgentVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });
});

describe("CAMPAIGN_SAMPLING", () => {
  it("uses deterministic-friendly sampling knobs", () => {
    expect(CAMPAIGN_SAMPLING.temperature).toBeLessThanOrEqual(0.3);
    expect(CAMPAIGN_SAMPLING.cachePrompt).toBe(true);
    expect(typeof CAMPAIGN_SAMPLING.seed).toBe("number");
  });
});

describe("captureEnvironmentSnapshot", () => {
  it("folds llama probe failure into nulls without throwing", async () => {
    const snap = await captureEnvironmentSnapshot({
      chatUrl: "http://127.0.0.1:18991",
      embeddingUrl: "http://127.0.0.1:18992",
      fetchProps: async () => null,
    });
    expect(snap.llama.chatModelId).toBeNull();
    expect(snap.llama.chatNCtx).toBeNull();
    expect(snap.llama.embeddingModelId).toBeNull();
    expect(snap.llama.serverVersion).toBeNull();
    expect(snap.agentVersion.length).toBeGreaterThan(0);
    expect(snap.node.version.startsWith("v")).toBe(true);
    expect(snap.sampling.temperature).toBe(CAMPAIGN_SAMPLING.temperature);
    expect(typeof snap.git.dirty).toBe("boolean");
    expect(typeof snap.git.dirtyFiles).toBe("number");
  });

  it("extracts the basename of model_path", async () => {
    const snap = await captureEnvironmentSnapshot({
      chatUrl: "http://127.0.0.1:18991",
      embeddingUrl: null,
      fetchProps: async (url: string) => {
        if (url.includes("18991")) {
          return {
            default_generation_settings: { n_ctx: 32768 },
            model_path: "/Users/me/.atomic-agent/models/qwen3-30b-a3b-q4_k_m.gguf",
            build_info: "b5234",
          };
        }
        return null;
      },
    });
    expect(snap.llama.chatModelId).toBe("qwen3-30b-a3b-q4_k_m");
    expect(snap.llama.chatNCtx).toBe(32768);
    expect(snap.llama.serverVersion).toBe("b5234");
  });
});

describe("captureGitProvenance", () => {
  it("returns boolean dirty + numeric dirtyFiles, even outside a repo it stays callable", () => {
    const g = captureGitProvenance();
    expect(typeof g.dirty).toBe("boolean");
    expect(typeof g.dirtyFiles).toBe("number");
    if (g.sha !== null) {
      expect(g.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(g.shortSha).toBe(g.sha.slice(0, 12));
    } else {
      expect(g.shortSha).toBeNull();
    }
  });
});

describe("diffSnapshots", () => {
  function base(): EnvironmentSnapshot {
    return {
      capturedAt: "2025-01-01T00:00:00.000Z",
      agentVersion: "0.1.26",
      git: {
        sha: "1111111111111111111111111111111111111111",
        shortSha: "111111111111",
        branch: "main",
        dirty: false,
        dirtyFiles: 0,
      },
      node: { version: "v25.7.0", platform: "darwin", arch: "arm64" },
      llama: {
        chatUrl: "http://127.0.0.1:18991",
        chatModelId: "qwen3-30b",
        chatNCtx: 32768,
        embeddingUrl: "http://127.0.0.1:18992",
        embeddingModelId: "nomic-embed",
        serverVersion: "b5234",
      },
      judge: {
        model: "openai/gpt-4o-mini",
        url: "https://openrouter.ai/api/v1",
        disabled: false,
      },
      sampling: {
        temperature: 0.2,
        topP: 0.95,
        topK: 40,
        seed: 42,
        cachePrompt: true,
      },
    };
  }

  it("reports no diffs when only capturedAt differs", () => {
    const a = base();
    const b = base();
    b.capturedAt = "2025-02-01T00:00:00.000Z";
    expect(diffSnapshots(a, b)).toEqual([]);
  });

  it("reports nested field changes with their dotted path", () => {
    const a = base();
    const b = base();
    b.llama.chatNCtx = 16384;
    b.sampling.seed = 99;
    const diffs = diffSnapshots(a, b);
    const paths = diffs.map((d) => d.path);
    expect(paths).toContain("llama.chatNCtx");
    expect(paths).toContain("sampling.seed");
  });

  it("reports added / removed nested keys", () => {
    const a = base();
    const b = base();
    b.llama.chatModelId = null;
    const diffs = diffSnapshots(a, b);
    expect(diffs.some((d) => d.path === "llama.chatModelId")).toBe(true);
  });

  it("reports git SHA drift on its dotted path", () => {
    const a = base();
    const b = base();
    b.git.sha = "2222222222222222222222222222222222222222";
    b.git.shortSha = "222222222222";
    b.git.dirty = true;
    b.git.dirtyFiles = 3;
    const diffs = diffSnapshots(a, b);
    const paths = diffs.map((d) => d.path).sort();
    expect(paths).toContain("git.sha");
    expect(paths).toContain("git.shortSha");
    expect(paths).toContain("git.dirty");
    expect(paths).toContain("git.dirtyFiles");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { baseHeaders, isGitHubUrl } from "./download-attempt.js";

describe("isGitHubUrl", () => {
  it("matches real GitHub release hosts", () => {
    expect(isGitHubUrl("https://github.com/ggml-org/llama.cpp/releases/download/b1/x.gguf")).toBe(true);
    expect(isGitHubUrl("https://objects.githubusercontent.com/...")).toBe(true);
    expect(isGitHubUrl("https://raw.githubusercontent.com/..." )).toBe(true);
    expect(isGitHubUrl("https://api.github.com/repos")).toBe(true);
    expect(isGitHubUrl("https://release-assets.githubusercontent.com/...")).toBe(true);
    expect(isGitHubUrl("https://github-releases.githubusercontent.com/...")).toBe(true);
  });

  it("matches any *.githubusercontent.com redirect target", () => {
    expect(isGitHubUrl("https://github-cloud.githubusercontent.com/...")).toBe(true);
    expect(isGitHubUrl("https://media.githubusercontent.com/...")).toBe(true);
  });

  it("rejects a lookalike host (github.com.example.net)", () => {
    expect(isGitHubUrl("https://github.com.example.net/..." )).toBe(false);
    expect(isGitHubUrl("https://not-github.com/..." )).toBe(false);
  });

  it("rejects a lookalike path (example.com/.../github.com/...)", () => {
    // The substring "github.com" appears in the path, not the host.
    expect(isGitHubUrl("https://example.com/github.com/model.gguf")).toBe(false);
    expect(isGitHubUrl("https://huggingface.co/github.com/..." )).toBe(false);
  });

  it("rejects non-https GitHub URLs", () => {
    expect(isGitHubUrl("http://github.com/..." )).toBe(false);
    expect(isGitHubUrl("ftp://github.com/..." )).toBe(false);
  });

  it("rejects garbage / non-URL input", () => {
    expect(isGitHubUrl("github.com")).toBe(false);
    expect(isGitHubUrl("not a url")).toBe(false);
    expect(isGitHubUrl("")).toBe(false);
  });
});

describe("baseHeaders token gating", () => {
  let prevToken: string | undefined;
  let prevGhToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.GITHUB_TOKEN;
    prevGhToken = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_testtoken";
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken;
    if (prevGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGhToken;
  });

  it("sends Authorization to a real GitHub release URL", () => {
    const h = baseHeaders("https://github.com/ggml-org/llama.cpp/releases/download/b1/x.gguf");
    expect(h.Authorization).toBe("Bearer ghp_testtoken");
  });

  it("sends Authorization to a githubusercontent.com redirect target", () => {
    const h = baseHeaders("https://objects.githubusercontent.com/...");
    expect(h.Authorization).toBe("Bearer ghp_testtoken");
  });

  it("does NOT leak the token to a lookalike host", () => {
    const h = baseHeaders("https://github.com.example.net/evil/..." );
    expect(h.Authorization).toBeUndefined();
  });

  it("does NOT leak the token to a lookalike path", () => {
    const h = baseHeaders("https://example.com/github.com/model.gguf");
    expect(h.Authorization).toBeUndefined();
  });

  it("does NOT leak the token over http", () => {
    const h = baseHeaders("http://github.com/..." );
    expect(h.Authorization).toBeUndefined();
  });

  it("still sends HF token to Hugging Face URLs (unchanged behaviour)", () => {
    process.env.GITHUB_TOKEN = undefined;
    process.env.HF_TOKEN = "hf_testtoken";
    const h = baseHeaders("https://huggingface.co/org/repo/resolve/main/x.gguf");
    expect(h.Authorization).toBe("Bearer hf_testtoken");
  });
});

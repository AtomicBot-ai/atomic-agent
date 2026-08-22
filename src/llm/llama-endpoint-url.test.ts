import { describe, expect, it } from "vitest";
import { llamaEndpointUrl } from "./llama-endpoint-url.js";

describe("llamaEndpointUrl", () => {
  // The shapes most operators type are pure origins; for those the fix
  // must be a byte-for-byte no-op against the old `new URL(path, base)`
  // construction, so nothing that worked before can regress.
  it("matches the legacy origin-resolving join for prefix-free bases", () => {
    const bases = [
      "http://127.0.0.1:8080",
      "http://192.168.1.50:8080",
      "http://192.168.1.50:8080/",
    ];
    const paths = ["/health", "/props", "/completion", "/v1/models"];
    for (const base of bases) {
      for (const path of paths) {
        expect(llamaEndpointUrl(base, path)).toBe(new URL(path, base).toString());
      }
    }
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(llamaEndpointUrl("https://box.example/llama", "/health")).toBe(
      "https://box.example/llama/health",
    );
    expect(llamaEndpointUrl("https://box.example/llama/", "/completion")).toBe(
      "https://box.example/llama/completion",
    );
    expect(llamaEndpointUrl("https://box.example/llama", "/v1/models")).toBe(
      "https://box.example/llama/v1/models",
    );
  });

  it("drops a trailing /v1 pasted from the openai-compatible field", () => {
    expect(llamaEndpointUrl("http://192.168.1.50:8080/v1", "/health")).toBe(
      "http://192.168.1.50:8080/health",
    );
    // ... including under a proxy prefix, where both conventions stack.
    expect(llamaEndpointUrl("https://box.example/llama/v1", "/props")).toBe(
      "https://box.example/llama/props",
    );
  });

  it("strips query and fragment from the base", () => {
    expect(llamaEndpointUrl("http://127.0.0.1:8080/?x=1#frag", "/health")).toBe(
      "http://127.0.0.1:8080/health",
    );
  });
});

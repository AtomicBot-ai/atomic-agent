import { describe, expect, it } from "vitest";

import { LlamaServerError } from "../llm/llama-server-client.js";
import { classifyFailure } from "../llm/reliability/classify-failure.js";
import { formatAgentErrorForChat } from "./format-agent-error-for-chat.js";

describe("formatAgentErrorForChat", () => {
  it("prefixes category and message", () => {
    expect(formatAgentErrorForChat("transport", "connection reset")).toBe(
      "Turn failed [transport]: connection reset",
    );
  });

  it("replaces HTML error bodies with a short hint", () => {
    const html =
      "chat completion stream failed: 404 <!DOCTYPE html><html><body>x</body></html>";
    expect(formatAgentErrorForChat("grammar", html)).toBe(
      "Turn failed [grammar]: upstream HTTP 404 (wrong API URL or provider config)",
    );
  });

  it("appends the llama-server hint for transport failures on a local provider", () => {
    const text = formatAgentErrorForChat("transport", "fetch failed", {
      activeProviderIsLocal: true,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toContain("Turn failed [transport]: fetch failed");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
    expect(text).toContain("atomic-agent models start");
  });

  it("keeps the hint away from cloud providers — advice about the wrong server", () => {
    expect(
      formatAgentErrorForChat("transport", "fetch failed", {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [transport]: fetch failed");
  });

  it("keeps the hint away from non-transport failures", () => {
    expect(
      formatAgentErrorForChat("model", "empty completion", {
        activeProviderIsLocal: true,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [model]: empty completion");
  });
});

describe("formatAgentErrorForChat — classified llama failures", () => {
  // Mirrors the real pipeline: `agent-loop` classifies the thrown error
  // and the reducer hands that category straight to the formatter. The
  // hint is gated on `transport`, so the one failure where "check your
  // llama URL" is exactly right — a 404 from a wrong `localModels.url` —
  // used to be the one failure that never got it.
  const local = {
    activeProviderIsLocal: true,
    llamaUrl: "http://127.0.0.1:19091",
  };

  it("carries the unreachable hint for a llama 404 on a local provider", () => {
    const err = new LlamaServerError(
      "llama-server returned http 404",
      404,
      local.llamaUrl,
    );
    const text = formatAgentErrorForChat(
      classifyFailure(err),
      err.message,
      local,
    );
    expect(text).toContain("Turn failed [transport]");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
  });

  it("keeps a llama 400 as a grammar failure with no URL advice", () => {
    const err = new LlamaServerError(
      "llama-server returned http 400",
      400,
      local.llamaUrl,
    );
    const text = formatAgentErrorForChat(
      classifyFailure(err),
      err.message,
      local,
    );
    expect(text).toBe(
      "Turn failed [grammar]: llama-server returned http 400",
    );
  });
});

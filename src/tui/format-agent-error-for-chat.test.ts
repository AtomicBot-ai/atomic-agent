import { describe, expect, it } from "vitest";

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

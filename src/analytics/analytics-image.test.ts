import { describe, expect, it, vi } from "vitest";

import type { AnalyticsClient } from "./analytics-client.js";
import { ANALYTICS_EVENTS, captureImageGenerated } from "./analytics-events.js";

function fakeClient() {
  return { capture: vi.fn() } as unknown as AnalyticsClient & { capture: ReturnType<typeof vi.fn> };
}

describe("image_generated", () => {
  it("sends shape only: kind, model id, duration, success, count", () => {
    const client = fakeClient();
    captureImageGenerated(client, { kind: "cloud", model: "google/gemini-nano-banana-2.1", durationMs: 8123.4, success: true, count: 2 });
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.imageGenerated, {
      kind: "cloud", model: "google/gemini-nano-banana-2.1", duration_ms: 8123, success: true, count: 2,
    });
  });

  it("never lets a path, a prompt or a message through the model or the error code", () => {
    const client = fakeClient();
    captureImageGenerated(client, { kind: "local", model: "/Users/me/models/z image.gguf", durationMs: 5, success: false, count: 0, errorCode: "unsafe prompt: a fox" });
    captureImageGenerated(client, { kind: "cloud", model: "x/y", durationMs: 5, success: false, count: 0, errorCode: "REMOTE_QUOTA" });
    expect(client.capture.mock.calls[0]?.[1]).toMatchObject({ model: "unknown", error_code: "unknown" });
    expect(client.capture.mock.calls[1]?.[1]).toMatchObject({ error_code: "remote_quota" });
  });

  it("does nothing with analytics off", () => {
    expect(() => captureImageGenerated(null, { kind: "cloud", model: "x", durationMs: 1, success: true, count: 1 })).not.toThrow();
  });
});

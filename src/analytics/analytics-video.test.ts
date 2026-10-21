import { describe, expect, it, vi } from "vitest";

import type { AnalyticsClient } from "./analytics-client.js";
import { ANALYTICS_EVENTS, captureVideoGenerated } from "./analytics-events.js";

function fakeClient() {
  return { capture: vi.fn() } as unknown as AnalyticsClient & { capture: ReturnType<typeof vi.fn> };
}

describe("video_generated", () => {
  it("sends model, clip length and outcome only", () => {
    const client = fakeClient();
    captureVideoGenerated(client, { model: "google/veo-3.1-fast", durationSecs: 4, outcome: "success" });
    expect(ANALYTICS_EVENTS.videoGenerated).toBe("video_generated");
    expect(client.capture).toHaveBeenCalledWith("video_generated", { model: "google/veo-3.1-fast", duration_secs: 4, outcome: "success" });
  });

  it("never lets a path, a prompt or a message through the model or the error code", () => {
    const client = fakeClient();
    captureVideoGenerated(client, { model: "/Users/me/a fox.mp4", durationSecs: 8, outcome: "failed", errorCode: "unsafe prompt: a fox" });
    captureVideoGenerated(client, { model: "x/y", durationSecs: 6, outcome: "failed", errorCode: "REMOTE_QUOTA" });
    expect(client.capture.mock.calls[0]?.[1]).toEqual({ model: "unknown", duration_secs: 8, outcome: "failed", error_code: "unknown" });
    expect(client.capture.mock.calls[1]?.[1]).toMatchObject({ error_code: "remote_quota" });
  });

  it("does nothing with analytics off", () => {
    expect(() => captureVideoGenerated(null, { model: "x", durationSecs: 4, outcome: "cancelled" })).not.toThrow();
  });
});

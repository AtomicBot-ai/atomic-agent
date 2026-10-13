import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AnalyticsClient } from "./analytics-client.js";
import { ANALYTICS_EVENTS, captureLocalEngineFailed, captureMessageSent } from "./analytics-events.js";
import type { AnalyticsStateStore } from "./analytics-state-store.js";
import { reportLocalEngineFailed } from "./report-local-engine-failed.js";

function fakeClient() {
  return { capture: vi.fn() } as unknown as AnalyticsClient & { capture: ReturnType<typeof vi.fn> };
}
function sentStore() {
  return { isFirstMessageSent: () => true, markFirstMessageSent: vi.fn() } as unknown as AnalyticsStateStore;
}

describe("local engine analytics", () => {
  it("tags a local turn's message_sent with its engine, and a cloud turn with none", () => {
    const client = fakeClient();
    captureMessageSent(client, sentStore(), { provider: "local-llama", model: "qwen", localEngine: "atomic-core" });
    captureMessageSent(client, sentStore(), { provider: "openrouter", model: "gpt" });
    expect(client.capture.mock.calls[0]).toEqual([ANALYTICS_EVENTS.messageSent, { provider: "local-llama", model: "qwen", local_engine: "atomic-core" }]);
    expect(client.capture.mock.calls[1]?.[1]).not.toHaveProperty("local_engine");
  });

  it("sends local_engine_failed with fixed words only", () => {
    const client = fakeClient();
    captureLocalEngineFailed(client, { engine: "atomic-core", stage: "download", reasonCode: "network" });
    captureLocalEngineFailed(client, { engine: "atomic-core", stage: "/Users/me/x", reasonCode: "fetch failed: https://example.org" });
    expect(client.capture).toHaveBeenNthCalledWith(1, "local_engine_failed", { engine: "atomic-core", stage: "download", reason_code: "network" });
    expect(client.capture).toHaveBeenNthCalledWith(2, "local_engine_failed", { engine: "atomic-core", stage: "unknown", reason_code: "unknown" });
    captureLocalEngineFailed(null, { engine: "atomic-core", stage: "start", reasonCode: "not_ready" });
  });

  it("reports from a one-shot command, and not at all when analytics is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-engine-failed-"));
    try {
      const posthog = { capture: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) };
      const context = { engine: "atomic-core" as const, stage: "backend", reasonCode: "server" };
      await reportLocalEngineFailed({ stateDir: dir, version: "1.0.0", enabled: false, context, posthog });
      expect(posthog.capture).not.toHaveBeenCalled();
      expect(existsSync(join(dir, "analytics.json"))).toBe(false);
      await reportLocalEngineFailed({ stateDir: dir, version: "1.0.0", enabled: true, context, posthog });
      expect(posthog.capture).toHaveBeenCalledTimes(1);
      const arg = posthog.capture.mock.calls[0]?.[0];
      expect(arg.event).toBe("local_engine_failed");
      expect(arg.properties).toMatchObject({ engine: "atomic-core", stage: "backend", reason_code: "server" });
      expect(posthog.shutdown).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

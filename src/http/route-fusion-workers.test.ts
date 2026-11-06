import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * `/api/sessions/{id}/fusion/workers…` (ATO-568): the desktop's stop /
 * steer / escalate on one running fusion worker. The routes only
 * translate `runtime.fusionWorkers`; the routing itself (parent session
 * + task id → that worker's inbox) is covered in
 * `src/tools/fusion/worker-steer.test.ts`.
 */
describe("/api/sessions/{id}/fusion/workers", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const post = (path: string, body?: unknown) =>
    fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    });

  it("lists the running workers of that session and the actions it accepts", async () => {
    const running = vi
      .spyOn(harness.runtime.fusionWorkers, "running")
      .mockReturnValue(["ui", "api"]);
    const res = await fetch(`${harness.baseUrl}/api/sessions/s-1/fusion/workers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: "s-1",
      running: ["ui", "api"],
      actions: ["stop", "steer", "escalate"],
    });
    expect(running).toHaveBeenCalledWith("s-1");
  });

  it("lists nothing for a session with no fan-out running", async () => {
    const res = await fetch(`${harness.baseUrl}/api/sessions/s-idle/fusion/workers`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { running: string[] }).running).toEqual([]);
  });

  it("steers one worker, addressed by session and task id", async () => {
    const steer = vi.spyOn(harness.runtime.fusionWorkers, "steer").mockReturnValue(true);
    const res = await post("/api/sessions/s-1/fusion/workers/ui/steer", {
      text: "reuse the existing Button",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steered: true, sessionId: "s-1", taskId: "ui" });
    expect(steer).toHaveBeenCalledWith("s-1", "ui", "reuse the existing Button");
  });

  it("refuses a blank or missing note without asking the runtime", async () => {
    const steer = vi.spyOn(harness.runtime.fusionWorkers, "steer");
    expect((await post("/api/sessions/s-1/fusion/workers/ui/steer", { text: "  " })).status).toBe(400);
    expect((await post("/api/sessions/s-1/fusion/workers/ui/steer", {})).status).toBe(400);
    expect(steer).not.toHaveBeenCalled();
  });

  it("names a refused steer: 404 when the worker is gone, 409 when it is running but not taking notes", async () => {
    vi.spyOn(harness.runtime.fusionWorkers, "steer").mockReturnValue(false);
    const running = vi.spyOn(harness.runtime.fusionWorkers, "running").mockReturnValue([]);
    expect((await post("/api/sessions/s-1/fusion/workers/ui/steer", { text: "x" })).status).toBe(404);
    running.mockReturnValue(["ui"]);
    expect((await post("/api/sessions/s-1/fusion/workers/ui/steer", { text: "x" })).status).toBe(409);
  });

  it("stops one worker, and says 404 when it is not running", async () => {
    const stop = vi.spyOn(harness.runtime.fusionWorkers, "stop").mockReturnValueOnce(true);
    const ok = await post("/api/sessions/s-1/fusion/workers/api/stop");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ stopped: true, sessionId: "s-1", taskId: "api" });
    expect(stop).toHaveBeenCalledWith("s-1", "api");
    stop.mockReturnValueOnce(false);
    expect((await post("/api/sessions/s-1/fusion/workers/api/stop")).status).toBe(404);
  });

  it("escalates one worker and returns the line the TUI prints", async () => {
    vi.spyOn(harness.runtime.fusionWorkers, "escalate")
      .mockResolvedValueOnce("escalated to big as advisor (the person asked for it): $0.0018")
      .mockResolvedValueOnce(null);
    const ok = await post("/api/sessions/s-1/fusion/workers/ui/escalate");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { line: string }).line).toMatch(/escalated to big/);
    expect((await post("/api/sessions/s-1/fusion/workers/ui/escalate")).status).toBe(404);
  });

  it("decodes task ids that need escaping", async () => {
    const steer = vi.spyOn(harness.runtime.fusionWorkers, "steer").mockReturnValue(true);
    await post(`/api/sessions/s-1/fusion/workers/${encodeURIComponent("t 1/a")}/steer`, { text: "go" });
    expect(steer).toHaveBeenCalledWith("s-1", "t 1/a", "go");
  });
});

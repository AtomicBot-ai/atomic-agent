import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";
import { ROUTE_SCOPES } from "./http-scopes.js";

/**
 * `/api/sessions/{id}/shell-jobs…` (ATO-2485): the desktop's terminal tab
 * on the agent's kept jobs. The routes only translate
 * `runtime.shellJobs`; the job side is covered in
 * `src/tools/os/shell/shell-job-host.test.ts`.
 */
describe("/api/sessions/{id}/shell-jobs", () => {
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
  const controls = () => harness.runtime.shellJobs!;

  it("is wired into the runtime", () => {
    expect(harness.runtime.shellJobs).toBeDefined();
  });

  it("lists nothing for a session with no jobs, and names the actions", async () => {
    const res = await fetch(`${harness.baseUrl}/api/sessions/s-idle/shell-jobs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: "s-idle",
      jobs: [],
      actions: ["output", "input", "resize", "stop"],
    });
  });

  it("reads output from a position", async () => {
    const read = vi.spyOn(controls(), "read").mockReturnValue({
      text: ">>> ",
      next: 4,
      dropped: false,
      job: {
        id: 2, commandLine: "python3", cwd: "/w", state: "running", interactive: true,
        resizable: false, startedAt: 1, exitCode: null, signal: null,
      },
    });
    const res = await fetch(`${harness.baseUrl}/api/sessions/s-1/shell-jobs/2/output?since=0`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe(">>> ");
    expect(read).toHaveBeenCalledWith("s-1", 2, 0);
  });

  it("types the person's text into the job", async () => {
    const write = vi.spyOn(controls(), "write").mockReturnValue("written");
    const res = await post("/api/sessions/s-1/shell-jobs/2/input", { text: "hunter2\n" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: true, sessionId: "s-1", jobId: 2 });
    expect(write).toHaveBeenCalledWith("s-1", 2, "hunter2\n", false, { secret: false });
  });

  it("passes Hide typing on as secret, and says whether the value can be masked", async () => {
    const write = vi.spyOn(controls(), "write").mockReturnValue("written");
    const strong = await post("/api/sessions/s-1/shell-jobs/2/input", { text: "Tr0ub4dor&3\n", secret: true });
    expect(strong.status).toBe(200);
    expect(await strong.json()).toEqual({ written: true, sessionId: "s-1", jobId: 2, masked: true });
    expect(write).toHaveBeenCalledWith("s-1", 2, "Tr0ub4dor&3\n", false, { secret: true });
    const weak = await post("/api/sessions/s-1/shell-jobs/2/input", { text: "1234\n", secret: true });
    expect(((await weak.json()) as { masked: boolean }).masked).toBe(false);
    expect((await post("/api/sessions/s-1/shell-jobs/2/input", { text: "x", secret: "yes" })).status).toBe(400);
  });

  it("refuses a bad body or job id without touching the job, and never echoes the text", async () => {
    const write = vi.spyOn(controls(), "write");
    expect((await post("/api/sessions/s-1/shell-jobs/0/input", { text: "x" })).status).toBe(400);
    expect((await post("/api/sessions/s-1/shell-jobs/abc/input", { text: "x" })).status).toBe(400);
    expect((await post("/api/sessions/s-1/shell-jobs/2/input", { text: "" })).status).toBe(400);
    const bad = await post("/api/sessions/s-1/shell-jobs/2/input", { text: 7 });
    expect(bad.status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it("names a refused write: 404 gone, 409 not a terminal, 413 too long", async () => {
    const write = vi.spyOn(controls(), "write").mockReturnValue("not_found");
    expect((await post("/api/sessions/s-1/shell-jobs/2/input", { text: "x" })).status).toBe(404);
    write.mockReturnValue("closed");
    const closed = await post("/api/sessions/s-1/shell-jobs/2/input", { text: "secret-value" });
    expect(closed.status).toBe(409);
    expect(await closed.text()).not.toContain("secret-value");
    write.mockReturnValue("too_long");
    expect((await post("/api/sessions/s-1/shell-jobs/2/input", { text: "x" })).status).toBe(413);
  });

  it("answers a resize the terminal cannot take with resized:false", async () => {
    vi.spyOn(controls(), "resize").mockReturnValue("not_supported");
    const res = await post("/api/sessions/s-1/shell-jobs/2/resize", { cols: 120, rows: 40 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resized: boolean }).resized).toBe(false);
    expect((await post("/api/sessions/s-1/shell-jobs/2/resize", { cols: 0, rows: 40 })).status).toBe(400);
  });

  it("stops one job, and says 404 when there is none", async () => {
    const stop = vi.spyOn(controls(), "stop").mockReturnValueOnce("stopped");
    const ok = await post("/api/sessions/s-1/shell-jobs/3/stop");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ stopped: true, sessionId: "s-1", jobId: 3 });
    expect(stop).toHaveBeenCalledWith("s-1", 3);
    stop.mockReturnValueOnce("not_found");
    expect((await post("/api/sessions/s-1/shell-jobs/3/stop")).status).toBe(404);
  });

  it("needs admin to type into a job", () => {
    expect(ROUTE_SCOPES["POST /api/sessions/{id}/shell-jobs/{jobId}/input"]).toBe("admin");
  });
});

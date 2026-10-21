import { describe, expect, it, vi } from "vitest";
import { CoreRequestError, type CoreControlClient } from "./core-client.js";
import {
  CoreVideoError,
  DEFAULT_OPENROUTER_VIDEO_MODEL,
  defaultVideoModel,
  describeCoreVideoError,
  listCoreVideoModels,
  runCoreVideoJob,
  type CoreVideoJob,
  type CoreVideoRequest,
} from "./core-video.js";

const request: CoreVideoRequest = {
  prompt: "a fox running", width: 1280, height: 720, steps: 0, cfgScale: 0,
  target: { provider: "openrouter", model: "google/veo-3.1-fast" },
  remote: { durationSecs: 4, aspectRatio: "16:9" },
};
const output = { id: "abc", path: "/core/data/videos/abc.mp4", width: 1280, height: 720, durationSecs: 4, sizeBytes: 4321 };
const job = (change: Partial<CoreVideoJob>): CoreVideoJob => ({ id: "abc", state: "generating", outputs: [], ...change });

/** A Core that answers the submit, then each poll from `jobs` in turn. */
function fakeCore(jobs: Array<CoreVideoJob | Error>, submit: unknown = { jobId: "abc" }) {
  const call = vi.fn(async (path: string, _body?: unknown) => {
    if (path === "/diffusion/video/jobs") { if (submit instanceof Error) throw submit; return submit; }
    if (path.endsWith("/cancel")) return { cancelled: true, serverStopped: false };
    const next = jobs.length > 1 ? jobs.shift()! : jobs[0]!;
    if (next instanceof Error) throw next;
    return { job: next };
  });
  return { client: { call } as unknown as CoreControlClient, call };
}

describe("runCoreVideoJob", () => {
  it("submits once on the video route, polls the video job and returns the clip", async () => {
    const progress = vi.fn();
    const { client, call } = fakeCore([
      job({ progress: { phase: "sampling", step: 0, totalSteps: 0, fraction: 0.4, etaSeconds: null, elapsedMs: 30_000 } }),
      job({ state: "completed", outputs: [output] }),
    ]);
    const done = await runCoreVideoJob(client, request, { pollMs: 1, onProgress: progress });
    expect(done.outputs).toEqual([output]);
    expect(call.mock.calls.filter(([path]) => path === "/diffusion/video/jobs")).toHaveLength(1);
    expect(call.mock.calls[0]![1]).toEqual(request);
    expect(call.mock.calls[1]![0]).toBe("/diffusion/video/jobs/abc");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ fraction: 0.4 }));
  });

  it("turns Core's failure code into a sentence a person can act on", async () => {
    const { client } = fakeCore([job({ state: "failed", error: { code: "REMOTE_QUOTA", message: "Payment required" } })]);
    const err = await runCoreVideoJob(client, request, { pollMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreVideoError);
    expect((err as CoreVideoError).code).toBe("REMOTE_QUOTA");
    expect((err as Error).message).toMatch(/out of credits/);
  });

  it("maps a refused submit without retrying it", async () => {
    const { client, call } = fakeCore([], new CoreRequestError(429, "Too many requests", "REMOTE_RATE_LIMITED"));
    const err = await runCoreVideoJob(client, request, { pollMs: 1 }).catch((e: unknown) => e) as CoreVideoError;
    expect(err.code).toBe("REMOTE_RATE_LIMITED");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("treats a completed job without a file as a failure", async () => {
    const { client } = fakeCore([job({ state: "completed", outputs: [] })]);
    await expect(runCoreVideoJob(client, request, { pollMs: 1 })).rejects.toMatchObject({ code: "NO_OUTPUT" });
  });

  it("cancels the video job in Core when the call is aborted", async () => {
    const controller = new AbortController();
    const { client, call } = fakeCore([job({})]);
    const running = runCoreVideoJob(client, request, { pollMs: 5, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toThrow();
    expect(call.mock.calls.some(([path]) => path === "/diffusion/video/jobs/abc/cancel")).toBe(true);
  });

  it("cancels and says the clip may still be billed when it outlives the timeout", async () => {
    const { client, call } = fakeCore([job({})]);
    const err = await runCoreVideoJob(client, request, { pollMs: 1, timeoutMs: 10 }).catch((e: unknown) => e) as CoreVideoError;
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toMatch(/may still finish and bill/);
    expect(call.mock.calls.some(([path]) => path === "/diffusion/video/jobs/abc/cancel")).toBe(true);
  });

  it("rides out a few dropped polls but not a Core that stays away", async () => {
    const dropped = new TypeError("fetch failed");
    const ok = fakeCore([dropped, dropped, job({ state: "completed", outputs: [output] })]);
    await expect(runCoreVideoJob(ok.client, request, { pollMs: 1 })).resolves.toMatchObject({ state: "completed" });
    const gone = fakeCore([dropped]);
    await expect(runCoreVideoJob(gone.client, request, { pollMs: 1 })).rejects.toMatchObject({ code: "CORE_UNREACHABLE" });
  });
});

describe("video catalog", () => {
  it("picks the catalog default, then the first model, then Veo 3.1 Fast", () => {
    expect(defaultVideoModel([{ id: "a" }, { id: "b", default: true }])).toBe("b");
    expect(defaultVideoModel([{ id: "a" }])).toBe("a");
    expect(defaultVideoModel([])).toBe(DEFAULT_OPENROUTER_VIDEO_MODEL);
    expect(DEFAULT_OPENROUTER_VIDEO_MODEL).toBe("google/veo-3.1-fast");
  });

  it("reads the video models and answers empty when Core cannot say", async () => {
    const call = vi.fn(async () => ({ models: [{ id: "google/veo-3.1-fast" }, { name: "no id" }] }));
    expect(await listCoreVideoModels({ call } as unknown as CoreControlClient, "openrouter")).toEqual([{ id: "google/veo-3.1-fast" }]);
    expect(call).toHaveBeenCalledWith("/media/providers/openrouter/models?kind=video", undefined, { timeoutMs: 20_000 });
    const broken = vi.fn(async () => { throw new CoreRequestError(409, "not configured", "REMOTE_NOT_CONFIGURED"); });
    expect(await listCoreVideoModels({ call: broken } as unknown as CoreControlClient, "openrouter")).toEqual([]);
  });

  it("says what to do for the codes a person can act on", () => {
    expect(describeCoreVideoError("REMOTE_AUTH_FAILED", "401")).toMatch(/refused the API key/);
    expect(describeCoreVideoError("JOB_BUSY", "busy")).toMatch(/4 cloud generations/);
    expect(describeCoreVideoError("SOMETHING_NEW", "it broke.")).toBe("Video generation failed: it broke.");
  });
});

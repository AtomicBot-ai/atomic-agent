import { describe, expect, it, vi } from "vitest";
import { CoreRequestError, type CoreControlClient } from "./core-client.js";
import {
  CoreImageError,
  DEFAULT_OPENROUTER_IMAGE_MODEL,
  defaultImageModel,
  describeCoreImageError,
  listCoreImageModels,
  OPENROUTER_MEDIA_BASE_URL,
  registerOpenRouterMedia,
  runCoreImageJob,
  type CoreImageJob,
  type CoreImageRequest,
} from "./core-image.js";

const request: CoreImageRequest = {
  prompt: "a fox", width: 1024, height: 1024, steps: 8, cfgScale: 1, batchSize: 1,
  target: { provider: "openrouter", model: "google/gemini-nano-banana-2.1" },
};
const output = { id: "abc-00", path: "/core/data/images/abc-00.png", width: 1024, height: 1024, sizeBytes: 1234 };
const job = (change: Partial<CoreImageJob>): CoreImageJob => ({ id: "abc", state: "generating", outputs: [], ...change });

/** A Core that answers the submit, then each poll from `jobs` in turn. */
function fakeCore(jobs: Array<CoreImageJob | Error>, submit: unknown = { jobId: "abc" }) {
  const call = vi.fn(async (path: string, _body?: unknown) => {
    if (path === "/diffusion/jobs") { if (submit instanceof Error) throw submit; return submit; }
    if (path.endsWith("/cancel")) return { cancelled: true, serverStopped: false };
    const next = jobs.length > 1 ? jobs.shift()! : jobs[0]!;
    if (next instanceof Error) throw next;
    return { job: next };
  });
  return { client: { call } as unknown as CoreControlClient, call };
}

describe("runCoreImageJob", () => {
  it("submits once, polls until completed and returns the files", async () => {
    const progress = vi.fn();
    const { client, call } = fakeCore([
      job({ progress: { step: 0, totalSteps: 0, fraction: 0.5, etaSeconds: null } }),
      job({ state: "completed", outputs: [output] }),
    ]);
    const done = await runCoreImageJob(client, request, { pollMs: 1, onProgress: progress });
    expect(done.outputs).toEqual([output]);
    expect(call.mock.calls.filter(([path]) => path === "/diffusion/jobs")).toHaveLength(1);
    expect(call.mock.calls[0]![1]).toEqual(request);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ fraction: 0.5 }));
  });

  it("turns Core's failure code into a sentence a person can act on", async () => {
    const { client } = fakeCore([job({ state: "failed", error: { code: "REMOTE_QUOTA", message: "Payment required" } })]);
    const err = await runCoreImageJob(client, request, { pollMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreImageError);
    expect((err as CoreImageError).code).toBe("REMOTE_QUOTA");
    expect((err as Error).message).toMatch(/out of credits/);
  });

  it("maps a refused submit (JOB_BUSY) without retrying it", async () => {
    const { client, call } = fakeCore([], new CoreRequestError(409, "4 remote jobs are running", "JOB_BUSY"));
    const err = await runCoreImageJob(client, request, { pollMs: 1 }).catch((e: unknown) => e) as CoreImageError;
    expect(err.code).toBe("JOB_BUSY");
    expect(err.message).toMatch(/4 cloud image jobs/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("treats a completed job without files as a failure", async () => {
    const { client } = fakeCore([job({ state: "completed", outputs: [] })]);
    await expect(runCoreImageJob(client, request, { pollMs: 1 })).rejects.toMatchObject({ code: "NO_OUTPUT" });
  });

  it("cancels the job in Core when the call is aborted", async () => {
    const controller = new AbortController();
    const { client, call } = fakeCore([job({})]);
    const running = runCoreImageJob(client, request, { pollMs: 5, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toThrow();
    expect(call.mock.calls.some(([path]) => path === "/diffusion/jobs/abc/cancel")).toBe(true);
  });

  it("cancels and says so when the job outlives its timeout", async () => {
    const { client, call } = fakeCore([job({})]);
    await expect(runCoreImageJob(client, request, { pollMs: 1, timeoutMs: 10 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(call.mock.calls.some(([path]) => path === "/diffusion/jobs/abc/cancel")).toBe(true);
  });

  it("rides out a few dropped polls but not a Core that stays away", async () => {
    const dropped = new TypeError("fetch failed");
    const ok = fakeCore([dropped, dropped, job({ state: "completed", outputs: [output] })]);
    await expect(runCoreImageJob(ok.client, request, { pollMs: 1 })).resolves.toMatchObject({ state: "completed" });
    const gone = fakeCore([dropped]);
    await expect(runCoreImageJob(gone.client, request, { pollMs: 1 })).rejects.toMatchObject({ code: "CORE_UNREACHABLE" });
  });
});

describe("cloud media", () => {
  it("registers OpenRouter with the key in the body and the images dialect", async () => {
    const call = vi.fn(async () => ({}));
    await registerOpenRouterMedia({ call } as unknown as CoreControlClient, "sk-or-test");
    expect(call).toHaveBeenCalledWith("/cloud/providers/openrouter", {
      api_key: "sk-or-test", base_url: OPENROUTER_MEDIA_BASE_URL, custom_headers: [], models: [],
      media: { image_api: "openrouter-images", models: [] },
    }, { method: "PUT" });
  });

  it("picks the catalog default, then the first model, then the pinned fallback", () => {
    expect(defaultImageModel([{ id: "a" }, { id: "b", default: true }])).toBe("b");
    expect(defaultImageModel([{ id: "a" }])).toBe("a");
    expect(defaultImageModel([])).toBe(DEFAULT_OPENROUTER_IMAGE_MODEL);
  });

  it("reads Core's model list and answers empty when Core cannot say", async () => {
    const call = vi.fn(async () => ({ models: [{ id: "x/y" }, { name: "no id" }] }));
    expect(await listCoreImageModels({ call } as unknown as CoreControlClient, "openrouter")).toEqual([{ id: "x/y" }]);
    expect(call).toHaveBeenCalledWith("/media/providers/openrouter/models?kind=image", undefined, { timeoutMs: 20_000 });
    const broken = vi.fn(async () => { throw new CoreRequestError(409, "not configured", "REMOTE_NOT_CONFIGURED"); });
    expect(await listCoreImageModels({ call: broken } as unknown as CoreControlClient, "openrouter")).toEqual([]);
  });
});

describe("describeCoreImageError", () => {
  it("says what to do for the codes a person can act on", () => {
    expect(describeCoreImageError("GPU_BUSY", "busy", false)).toMatch(/graphics card is busy/);
    expect(describeCoreImageError("MODEL_NOT_LOADED", "no model", false)).toMatch(/No local image model/);
    expect(describeCoreImageError("REMOTE_AUTH_FAILED", "401", true)).toMatch(/refused the API key/);
    expect(describeCoreImageError("SOMETHING_NEW", "it broke.", true)).toBe("Image generation failed: it broke.");
  });
});

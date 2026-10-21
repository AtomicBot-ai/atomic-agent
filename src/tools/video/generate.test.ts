import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreControlClient } from "../../local-llm/core/core-client.js";
import type { withImageCore } from "../../local-llm/core/core-image.js";
import type { ToolContext } from "../tool-registry.js";
import { parseVideoArgs } from "./args.js";
import { fitVideoToModel } from "./fit-model.js";
import { buildVideoGenerateTool, videoApprovalReason, type VideoGenerateToolOptions } from "./generate.js";

const VEO = {
  id: "google/veo-3.1-fast", name: "Veo 3.1 Fast", default: true, workflows: ["create", "image-to-video"],
  params: { durations: { values: [4, 6, 8], default: 8 }, resolutions: { values: ["720p", "1080p", "4K"], default: "720p" }, aspect_ratios: { values: ["16:9", "9:16"] }, audio: true, seed: true, last_frame: true },
};
const KLING = {
  id: "kwaivgi/kling-v3.0-std", name: "Kling 3.0 Standard", workflows: ["create", "image-to-video"],
  params: { durations: { values: [3, 4, 5, 6, 7, 8] }, aspect_ratios: { values: ["16:9", "9:16", "1:1"] }, audio: true },
};
const TEXT_ONLY = { id: "acme/text-only", workflows: ["create"], params: { durations: { values: [4] } } };

let dir: string;
let work: string;
let produced: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "video-generate-"));
  work = mkdtempSync(join(tmpdir(), "video-work-"));
  produced = join(dir, "abc.mp4");
  writeFileSync(produced, Buffer.from("ftypmp42"));
  // A real PNG signature, so the first-frame check sniffs it as an image.
  writeFileSync(join(work, "frame.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  writeFileSync(join(work, "notes.txt"), "not a picture");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const ctx = (signal = new AbortController().signal): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal });

/** A Core whose video jobs finish at once with `produced`, unless `failFor` names the model. */
function fakeCore(models: unknown[] = [VEO, KLING], failFor: Record<string, string> = {}) {
  const submitted: Array<Record<string, unknown> & { target: { model: string } }> = [];
  const call = vi.fn(async (path: string, body?: unknown) => {
    if (path === "/diffusion/video/jobs") { submitted.push(body as never); return { jobId: `j${submitted.length}` }; }
    if (path.startsWith("/diffusion/video/jobs/")) {
      const id = path.split("/")[4]!;
      const model = submitted[Number(id.slice(1)) - 1]!.target.model;
      const code = failFor[model];
      return code
        ? { job: { id, state: "failed", outputs: [], error: { code, message: "upstream said no" } } }
        : { job: { id, state: "completed", progress: { step: 0, totalSteps: 0, fraction: 1, etaSeconds: null }, outputs: [{ id, path: produced, width: 1280, height: 720, durationSecs: 4, sizeBytes: 8 }] } };
    }
    if (path.startsWith("/media/providers/")) return { models };
    return {};
  });
  const client = { call } as unknown as CoreControlClient;
  const withCore = (async (_dataDir: string, fn: (c: CoreControlClient, dataFolder: string) => Promise<unknown>) => fn(client, "/core/data")) as typeof withImageCore;
  return { call, submitted, withCore };
}

function tool(over: Partial<VideoGenerateToolOptions> & Pick<VideoGenerateToolOptions, "withCore">) {
  const request = vi.fn(async () => ({ approved: true }));
  const report = vi.fn();
  const onProgress = vi.fn();
  const built = buildVideoGenerateTool({
    approvals: { request } as never, approvalRequired: true,
    dataDir: () => dir, openRouterKey: () => "sk-or-test", report, onProgress, needsCoreInstall: () => false,
    now: () => new Date(2026, 9, 21, 14, 22, 33), progressEveryMs: 0,
    ...over,
  });
  return { built, request, report, onProgress };
}

describe("video.generate", () => {
  it("asks before a paid clip, saves it in the working folder and points at reply.attachments", async () => {
    const core = fakeCore();
    const { built, request, report, onProgress } = tool({ withCore: core.withCore });
    const result = await built.run({ prompt: "a fox running through snow", aspect: "portrait" }, ctx());
    expect(result.status).toBe("ok");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ tool: "video.generate", category: "paid_generation", preview: "a fox running through snow", affectedResources: ["openrouter.ai"] }), expect.anything());
    const saved = join(work, "video-20261021-142233.mp4");
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved)).toEqual(readFileSync(produced));
    expect(result.details.paths).toEqual([saved]);
    expect(result.summary).toContain("reply.attachments");
    expect(core.call).toHaveBeenCalledWith("/cloud/providers/openrouter", expect.objectContaining({ api_key: "sk-or-test" }), expect.anything());
    expect(core.submitted).toEqual([expect.objectContaining({
      prompt: "a fox running through snow", workflow: "create", width: 720, height: 1280, steps: 0, cfgScale: 0,
      target: { provider: "openrouter", model: "google/veo-3.1-fast" },
      remote: { durationSecs: 4, aspectRatio: "9:16" },
    })]);
    expect(report).toHaveBeenCalledWith({ model: "google/veo-3.1-fast", durationSecs: 4, outcome: "success" });
    expect(onProgress).toHaveBeenCalledWith("s1", expect.objectContaining({ label: expect.stringContaining("google/veo-3.1-fast") }));
  });

  it("never overwrites a file", async () => {
    writeFileSync(join(work, "video-20261021-142233.mp4"), "mine");
    const { built } = tool({ withCore: fakeCore().withCore });
    const result = await built.run({ prompt: "a fox" }, ctx());
    expect(readFileSync(join(work, "video-20261021-142233.mp4"), "utf8")).toBe("mine");
    expect(result.details.paths).toEqual([join(work, "video-20261021-142233-2.mp4")]);
  });

  it("starts from an image in the working folder, and refuses a file that is not a picture before asking", async () => {
    const core = fakeCore();
    const { built, request } = tool({ withCore: core.withCore });
    await built.run({ prompt: "the fox turns its head", image: "frame.png", duration: 6, audio: false }, ctx());
    expect(core.submitted[0]).toMatchObject({ workflow: "image-to-video", initImage: { path: join(work, "frame.png") }, remote: { durationSecs: 6, generateAudio: false } });
    request.mockClear();
    const bad = await built.run({ prompt: "x", image: "notes.txt" }, ctx());
    expect(bad.status).toBe("error");
    expect(bad.summary).toMatch(/first frame/);
    expect(request).not.toHaveBeenCalled();
  });

  it("moves to the next catalog model that can take the clip when the default is busy, never when the user picked it", async () => {
    const core = fakeCore([VEO, TEXT_ONLY, KLING], { "google/veo-3.1-fast": "REMOTE_RATE_LIMITED" });
    const { built, report } = tool({ withCore: core.withCore });
    const result = await built.run({ prompt: "a fox", image: "frame.png" }, ctx());
    expect(result.status).toBe("ok");
    // The text-only model cannot start from an image, so Kling is next.
    expect(core.submitted.map(j => j.target.model)).toEqual(["google/veo-3.1-fast", "kwaivgi/kling-v3.0-std"]);
    expect(result.summary).toContain("made it instead");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ model: "kwaivgi/kling-v3.0-std", outcome: "success" }));

    core.submitted.length = 0;
    const picked = await built.run({ prompt: "a fox", model: "google/veo-3.1-fast" }, ctx());
    expect(picked.status).toBe("error");
    expect(core.submitted).toHaveLength(1);
  });

  it("does not fall back on a failure that may have billed", async () => {
    const core = fakeCore([VEO, KLING], { "google/veo-3.1-fast": "REMOTE_CONTENT_BLOCKED" });
    const { built, report } = tool({ withCore: core.withCore });
    const result = await built.run({ prompt: "a fox" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/refused this prompt/);
    expect(core.submitted).toHaveLength(1);
    expect(report).toHaveBeenCalledWith({ model: "google/veo-3.1-fast", durationSecs: 4, outcome: "failed", errorCode: "REMOTE_CONTENT_BLOCKED" });
  });

  it("answers plainly for local models, a missing key and bad arguments, without touching Core", async () => {
    const withCore = vi.fn() as unknown as typeof withImageCore;
    const { built, request } = tool({ withCore });
    expect((await built.run({ prompt: "a fox", model: "local" }, ctx())).summary).toMatch(/not available in Atomic Agent yet/);
    expect((await tool({ withCore, openRouterKey: () => undefined }).built.run({ prompt: "a fox" }, ctx())).summary).toMatch(/needs an OpenRouter API key/);
    expect((await built.run({ prompt: "" }, ctx())).status).toBe("error");
    expect((await built.run({ prompt: "x", duration: 60 }, ctx())).summary).toMatch(/1 to 15/);
    expect((await built.run({ prompt: "x", aspect: "1:1" }, ctx())).summary).toMatch(/16:9/);
    expect(withCore).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not generate when the user declines", async () => {
    const core = fakeCore();
    const declined = buildVideoGenerateTool({
      approvals: { request: async () => ({ approved: false }) } as never, approvalRequired: true,
      dataDir: () => dir, openRouterKey: () => "k", withCore: core.withCore,
    });
    await expect(declined.run({ prompt: "a fox" }, ctx())).rejects.toThrow(/declined/);
    expect(core.submitted).toHaveLength(0);
  });

  it("keeps the paid clip's path when copying it into the folder fails", async () => {
    const { built } = tool({ withCore: fakeCore().withCore });
    const result = await built.run({ prompt: "a fox" }, { ...ctx(), workingDir: join(work, "missing", "dir") });
    expect(result.status).toBe("error");
    expect(result.summary).toContain(produced);
    expect(result.details.corePaths).toEqual([produced]);
  });
});

describe("approval text", () => {
  it("says it is a paid video on OpenRouter and that stopping does not cancel the charge", () => {
    const reason = videoApprovalReason(parseVideoArgs({ prompt: "a fox", duration: 8 }), false);
    expect(reason).toMatch(/paid 8-second video on OpenRouter/);
    expect(reason).toMatch(/google\/veo-3\.1-fast/);
    expect(reason).toMatch(/Stopping the agent does not cancel the charge/);
    expect(reason).not.toMatch(/Atomic Chat engine/);
    expect(videoApprovalReason(parseVideoArgs({ prompt: "a fox", image: "frame.png" }), true)).toMatch(/from frame\.png .*downloads the Atomic Chat engine/);
  });
});

describe("arguments and model fit", () => {
  it("defaults to a 4-second landscape clip and reads the shape words", () => {
    expect(parseVideoArgs({ prompt: " a fox " })).toEqual({ prompt: "a fox", duration: 4, durationGiven: false, aspect: "16:9", local: false });
    expect(parseVideoArgs({ prompt: "x", aspect: "vertical", resolution: "1080P", seed: 3 })).toMatchObject({ aspect: "9:16", resolution: "1080p", seed: 3 });
    expect(() => parseVideoArgs({ prompt: "x", resolution: "8K" })).toThrow(/resolution/);
    expect(() => parseVideoArgs({ prompt: "x", audio: "yes" })).toThrow(/audio/);
    expect(() => parseVideoArgs({ prompt: "x", seed: -1 })).toThrow(/seed/);
    expect(() => parseVideoArgs({ prompt: "x", model: "not a model" })).toThrow(/model id/);
  });

  it("refuses a length the user chose and the model lacks, and adapts one the user did not choose", () => {
    expect(fitVideoToModel(parseVideoArgs({ prompt: "x", duration: 5 }), VEO)).toEqual({ ok: false, reason: expect.stringMatching(/takes 4, 6, 8 seconds/) });
    const hailuo = { id: "minimax/hailuo-3", params: { durations: { values: [5, 6, 8] } } };
    const fitted = fitVideoToModel(parseVideoArgs({ prompt: "x" }), hailuo);
    expect(fitted).toMatchObject({ ok: true, duration: 5, remote: { durationSecs: 5 } });
  });

  it("leaves out what the model does not offer and says so", () => {
    const fitted = fitVideoToModel(parseVideoArgs({ prompt: "x", resolution: "4K", audio: true }), KLING);
    expect(fitted.ok && fitted.remote).toEqual({ durationSecs: 4, aspectRatio: "16:9", generateAudio: true });
    expect(fitted.ok && fitted.notes.join(" ")).toMatch(/does not offer 4K/);
    expect(fitVideoToModel(parseVideoArgs({ prompt: "x", image: "a.png" }), TEXT_ONLY).ok).toBe(false);
  });
});

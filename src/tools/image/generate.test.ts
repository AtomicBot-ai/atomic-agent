import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreControlClient } from "../../local-llm/core/core-client.js";
import type { withImageCore } from "../../local-llm/core/core-image.js";
import type { ToolContext } from "../tool-registry.js";
import { buildImageGenerateTool, cloudAspectRatio, cloudBatches, type ImageGenerateToolOptions } from "./generate.js";
import { openRouterImageKey } from "./openrouter-key.js";

let dir: string;
let work: string;
let produced: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "image-generate-"));
  work = mkdtempSync(join(tmpdir(), "image-work-"));
  produced = join(dir, "abc-00.png");
  writeFileSync(produced, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const ctx = (signal = new AbortController().signal): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal });

/** A Core whose jobs all finish at once with `produced`. */
function fakeCore(models: unknown[] = [{ id: "google/gemini-nano-banana-2.1", default: true, params: { aspect_ratios: { values: ["1:1", "16:9"] } } }]) {
  const submitted: unknown[] = [];
  let jobs = 0;
  const call = vi.fn(async (path: string, body?: unknown) => {
    if (path === "/diffusion/jobs") { submitted.push(body); return { jobId: `job${++jobs}` }; }
    if (path.startsWith("/diffusion/jobs/")) {
      const id = path.split("/")[3]!;
      return { job: { id, state: "completed", outputs: [{ id: `${id}-00`, path: produced, width: 1024, height: 1024, sizeBytes: 4 }] } };
    }
    if (path.startsWith("/media/providers/")) return { models };
    return {};
  });
  const client = { call } as unknown as CoreControlClient;
  const withCore = (async (_dataDir: string, fn: (c: CoreControlClient, dataFolder: string) => Promise<unknown>) => fn(client, "/core/data")) as typeof withImageCore;
  return { call, submitted, withCore };
}

function tool(over: Partial<ImageGenerateToolOptions> & Pick<ImageGenerateToolOptions, "withCore">) {
  const request = vi.fn(async () => ({ approved: true }));
  const report = vi.fn();
  const built = buildImageGenerateTool({
    approvals: { request } as never, approvalRequired: true,
    dataDir: () => dir, openRouterKey: () => "sk-or-test", report, needsCoreInstall: () => false,
    now: () => new Date(2026, 9, 15, 14, 22, 33),
    ...over,
  });
  return { built, request, report };
}

describe("image.generate", () => {
  it("asks before a paid cloud picture, saves it in the working folder and points at reply.attachments", async () => {
    const core = fakeCore();
    const { built, request, report } = tool({ withCore: core.withCore });
    const result = await built.run({ prompt: "a fox", size: "landscape" }, ctx());
    expect(result.status).toBe("ok");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ tool: "image.generate", category: "paid_generation", preview: "a fox" }), expect.anything());
    const saved = join(work, "image-20261015-142233.png");
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved)).toEqual(readFileSync(produced));
    expect(result.details.paths).toEqual([saved]);
    expect(result.summary).toContain("reply.attachments");
    expect(core.call).toHaveBeenCalledWith("/cloud/providers/openrouter", expect.objectContaining({ api_key: "sk-or-test" }), expect.anything());
    expect(core.submitted).toEqual([expect.objectContaining({
      prompt: "a fox", batchSize: 1, steps: 0, cfgScale: 0,
      target: { provider: "openrouter", model: "google/gemini-nano-banana-2.1" },
      remote: { aspectRatio: "16:9" },
    })]);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "cloud", model: "google/gemini-nano-banana-2.1", success: true, count: 1 }));
  });

  it("never overwrites a file and numbers the pictures of one call", async () => {
    writeFileSync(join(work, "image-20261015-142233.png"), "mine");
    const core = fakeCore();
    const { built } = tool({ withCore: core.withCore });
    const result = await built.run({ prompt: "a fox", count: 2 }, ctx());
    expect(readFileSync(join(work, "image-20261015-142233.png"), "utf8")).toBe("mine");
    expect((result.details.paths as string[]).length).toBe(2);
    // The model draws one at a time (no `n` in its catalog entry): two jobs.
    expect(core.submitted).toHaveLength(2);
  });

  it("gives a different seed to each job when the model draws one picture per request", async () => {
    const core = fakeCore([{ id: "bytedance-seed/seedream-5-0-flash", default: true, params: { seed: true } }]);
    const { built } = tool({ withCore: core.withCore });
    await built.run({ prompt: "a fox", count: 3, seed: 7 }, ctx());
    expect(core.submitted.map(j => (j as { seed?: number }).seed)).toEqual([7, 8, 9]);
  });

  it("says when the first picture downloads the engine", async () => {
    const core = fakeCore();
    const { built, request } = tool({ withCore: core.withCore, needsCoreInstall: () => true });
    await built.run({ prompt: "a fox" }, ctx());
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/downloads the Atomic Chat engine/) }), expect.anything());
  });

  it("answers plainly for local models and a missing key, without touching Core", async () => {
    const withCore = vi.fn() as unknown as typeof withImageCore;
    expect((await tool({ withCore }).built.run({ prompt: "a fox", model: "local" }, ctx())).summary).toMatch(/not available in Atomic Agent yet/);
    expect((await tool({ withCore, openRouterKey: () => undefined }).built.run({ prompt: "a fox" }, ctx())).summary).toMatch(/needs an OpenRouter API key/);
    expect(withCore).not.toHaveBeenCalled();
  });

  it("refuses a cloud model without a key, and bad arguments, before touching Core", async () => {
    const withCore = vi.fn() as unknown as typeof withImageCore;
    const { built } = tool({ withCore, openRouterKey: () => undefined });
    expect((await built.run({ prompt: "a fox", model: "openai/gpt-image-2.5-flare" }, ctx())).summary).toMatch(/needs an OpenRouter API key/);
    expect((await built.run({ prompt: "" }, ctx())).status).toBe("error");
    expect((await built.run({ prompt: "x", count: 5 }, ctx())).summary).toMatch(/1 to 4/);
    expect((await built.run({ prompt: "x", size: "7:5" }, ctx())).summary).toMatch(/not supported/);
    expect(withCore).not.toHaveBeenCalled();
  });

  it("does not generate when the user declines", async () => {
    const core = fakeCore();
    const declined = buildImageGenerateTool({
      approvals: { request: async () => ({ approved: false }) } as never, approvalRequired: true,
      dataDir: () => dir, openRouterKey: () => "k", withCore: core.withCore,
    });
    await expect(declined.run({ prompt: "a fox" }, ctx())).rejects.toThrow(/declined/);
    expect(core.submitted).toHaveLength(0);
  });

  it("keeps the paid pictures' paths when copying them into the folder fails", async () => {
    const core = fakeCore();
    const { built } = tool({ withCore: core.withCore });
    const result = await built.run({ prompt: "a fox" }, { ...ctx(), workingDir: join(work, "missing", "dir") });
    expect(result.status).toBe("error");
    expect(result.summary).toContain(produced);
    expect(result.details.corePaths).toEqual([produced]);
  });

  it("reports a model the user typed as custom unless Core's catalog lists it", async () => {
    const core = fakeCore();
    const { built, report } = tool({ withCore: core.withCore });
    await built.run({ prompt: "a fox", model: "acme/private-model" }, ctx());
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ model: "custom" }));
    expect(core.submitted[0]).toMatchObject({ target: { model: "acme/private-model" } });
  });

  it("moves to the next catalog model when the default one is rate limited upstream, never when the user picked it", async () => {
    const submitted: Array<{ target: { model: string } }> = [];
    const call = vi.fn(async (path: string, body?: unknown) => {
      if (path === "/diffusion/jobs") { submitted.push(body as { target: { model: string } }); return { jobId: `j${submitted.length}` }; }
      if (path.startsWith("/diffusion/jobs/")) {
        const id = path.split("/")[3]!;
        const model = submitted[Number(id.slice(1)) - 1]!.target.model;
        return model === "google/gemini-nano-banana-2.1"
          ? { job: { id, state: "failed", outputs: [], error: { code: "REMOTE_RATE_LIMITED", message: "quota" } } }
          : { job: { id, state: "completed", outputs: [{ id: `${id}-00`, path: produced, width: 1, height: 1, sizeBytes: 4 }] } };
      }
      if (path.startsWith("/media/")) return { models: [{ id: "google/gemini-nano-banana-2.1", default: true }, { id: "openai/gpt-image-2.5-flare" }] };
      return {};
    });
    const withCore = (async (_d: string, fn: (c: CoreControlClient, f: string) => Promise<unknown>) => fn({ call } as unknown as CoreControlClient, "/d")) as typeof withImageCore;
    const { built, report } = tool({ withCore });
    const result = await built.run({ prompt: "a fox" }, ctx());
    expect(result.status).toBe("ok");
    expect(submitted.map(j => j.target.model)).toEqual(["google/gemini-nano-banana-2.1", "openai/gpt-image-2.5-flare"]);
    expect(result.summary).toContain("made it instead");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/gpt-image-2.5-flare", success: true }));

    submitted.length = 0;
    const picked = await built.run({ prompt: "a fox", model: "google/gemini-nano-banana-2.1" }, ctx());
    expect(picked.status).toBe("error");
    expect(submitted).toHaveLength(1);
  });

  it("reports a failure with Core's code only", async () => {
    const call = vi.fn(async (path: string) => {
      if (path === "/diffusion/jobs") return { jobId: "j" };
      if (path.startsWith("/diffusion/jobs/")) return { job: { id: "j", state: "failed", outputs: [], error: { code: "REMOTE_CONTENT_BLOCKED", message: "unsafe prompt about /Users/me" } } };
      if (path.startsWith("/media/")) return { models: [] };
      return {};
    });
    const withCore = (async (_d: string, fn: (c: CoreControlClient, f: string) => Promise<unknown>) => fn({ call } as unknown as CoreControlClient, "/d")) as typeof withImageCore;
    const { built, report } = tool({ withCore });
    const result = await built.run({ prompt: "a fox" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/refused this prompt/);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: "REMOTE_CONTENT_BLOCKED", model: "google/gemini-nano-banana-2.1" }));
  });
});

describe("cloud request shape", () => {
  it("batches only as far as the model draws at once", () => {
    expect(cloudBatches(3, { id: "m", params: { n: { max: 4 } } })).toEqual([3]);
    expect(cloudBatches(3, { id: "m" })).toEqual([1, 1, 1]);
    expect(cloudBatches(3, { id: "m", params: { n: { max: 2 } } })).toEqual([2, 1]);
  });
  it("sends the ratio only when the model offers it", () => {
    expect(cloudAspectRatio("16:9", { id: "m", params: { aspect_ratios: { values: ["1:1"] } } })).toBeUndefined();
    expect(cloudAspectRatio("16:9", { id: "m" })).toBe("16:9");
  });
});

describe("openRouterImageKey", () => {
  it("takes the first openrouter entry on openrouter.ai, else the env key", () => {
    expect(openRouterImageKey({ llm: { providers: [
      { kind: "openrouter", apiKey: "proxy", baseUrl: "https://my-proxy.example.com/v1" },
      { kind: "openrouter", apiKey: "real" },
    ] } }, {})).toBe("real");
    expect(openRouterImageKey({ llm: { providers: [{ kind: "openai", apiKey: "x" }] } }, { OPENROUTER_API_KEY: "env" })).toBe("env");
    expect(openRouterImageKey({}, {})).toBeUndefined();
  });
});

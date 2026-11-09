import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../local-llm/index.js", async () => ({
  ...(await vi.importActual<typeof import("../local-llm/index.js")>("../local-llm/index.js")),
  getDaemonStatus: vi.fn(),
  isModelDownloaded: vi.fn(),
  isMmprojDownloaded: vi.fn(),
  readDownloadJob: vi.fn(),
  removeDownloadJob: vi.fn(),
}));

vi.mock("./models-handlers.js", async () => ({
  ...(await vi.importActual<typeof import("./models-handlers.js")>("./models-handlers.js")),
  runLocalModelsPull: vi.fn(),
  runLocalModelsStart: vi.fn(),
  runLocalModelsStop: vi.fn(),
  runLocalModelsUse: vi.fn(),
}));

import { addCustomModel, getConfig, resetConfigCache } from "../config/index.js";
import * as localLlm from "../local-llm/index.js";
import type { DownloadJob } from "../local-llm/index.js";
import {
  runLocalModelsPull,
  runLocalModelsStart,
  runLocalModelsStop,
  runLocalModelsUse,
} from "./models-handlers.js";
import { runLocalModelsPullAndRun } from "./models-pull-run.js";

const VISION_ID = "qwen-3.5-4b";
const TEXT_ID = "qwen-3.5-2b";

const pull = vi.mocked(runLocalModelsPull);
const start = vi.mocked(runLocalModelsStart);
const stop = vi.mocked(runLocalModelsStop);
const use = vi.mocked(runLocalModelsUse);

function jobWith(status: DownloadJob["status"], mode: DownloadJob["mode"]): DownloadJob {
  return { id: "job", status, mode, pid: 4242 } as DownloadJob;
}

describe("runLocalModelsPullAndRun", () => {
  let stateDir: string;
  let userDir: string;
  let stderrChunks: string[];
  let job: DownloadJob | null;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-pull-run-"));
    userDir = mkdtempSync(join(tmpdir(), "atomic-models-pull-run-user-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    getConfig();
    stderrChunks = [];
    job = null;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    pull.mockReset().mockResolvedValue(0);
    start.mockReset().mockResolvedValue(0);
    stop.mockReset().mockResolvedValue(0);
    use.mockReset().mockResolvedValue(0);
    vi.mocked(localLlm.getDaemonStatus).mockReset().mockResolvedValue({ running: false } as never);
    vi.mocked(localLlm.isModelDownloaded).mockReset().mockReturnValue(true);
    vi.mocked(localLlm.isMmprojDownloaded).mockReset().mockReturnValue(false);
    vi.mocked(localLlm.readDownloadJob).mockReset().mockImplementation(() => job);
    vi.mocked(localLlm.removeDownloadJob).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localLlm.setCustomLocalModels([]);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function expectNotStarted(): void {
    expect(use).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  }

  it("refuses --background with exit 2 before touching anything", async () => {
    expect(await runLocalModelsPullAndRun([TEXT_ID, "--run", "--background"])).toBe(2);
    expect(stderrChunks.join("")).toContain("--background");
    expect(pull).not.toHaveBeenCalled();
    expectNotStarted();
  });

  it("downloads, makes active, then starts", async () => {
    expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(0);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith([TEXT_ID]);
    expect(use).toHaveBeenCalledTimes(1);
    expect(use).toHaveBeenCalledWith(TEXT_ID);
    expect(start).toHaveBeenCalledTimes(1);
    expect(use.mock.invocationCallOrder[0]!).toBeLessThan(start.mock.invocationCallOrder[0]!);
    expect(stop).not.toHaveBeenCalled();
  });

  it("gives the start a cancel signal on Atomic Core", async () => {
    await runLocalModelsPullAndRun([TEXT_ID, "--run"]);
    expect(start.mock.calls[0]![0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for the projector on a vision model, once", async () => {
    await runLocalModelsPullAndRun([VISION_ID, "--run"]);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith([VISION_ID, "--mmproj"]);
    await runLocalModelsPullAndRun([VISION_ID, "--mmproj", "--run"]);
    expect(pull).toHaveBeenLastCalledWith([VISION_ID, "--mmproj"]);
  });

  it("still starts text-only when the projector did not come", async () => {
    // A failed projector leaves the pull at exit 0 with its note.
    expect(await runLocalModelsPullAndRun([VISION_ID, "--run"])).toBe(0);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("lets the pull report an unknown id", async () => {
    pull.mockResolvedValue(1);
    expect(await runLocalModelsPullAndRun(["no-such-model", "--run"])).toBe(1);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith(["no-such-model"]);
    expectNotStarted();
  });

  it("returns the pull's exit code when the download fails", async () => {
    pull.mockResolvedValue(1);
    expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(1);
    expectNotStarted();
  });

  it("returns the non-zero result of a followed background job", async () => {
    job = jobWith("running", "with-mmproj");
    pull.mockImplementation(async () => {
      job = jobWith("failed", "with-mmproj");
      return 1;
    });
    expect(await runLocalModelsPullAndRun([VISION_ID, "--run"])).toBe(1);
    expectNotStarted();
  });

  it("does not start after detaching from a job that is still running", async () => {
    job = jobWith("running", "with-mmproj");
    expect(await runLocalModelsPullAndRun([VISION_ID, "--run"])).toBe(1);
    expect(stderrChunks.join("")).toContain("still downloading");
    expectNotStarted();
  });

  it("does not start when the pull says 0 but the weights are not on disk", async () => {
    vi.mocked(localLlm.isModelDownloaded).mockReturnValue(false);
    expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(1);
    expect(stderrChunks.join("")).toContain("not on disk");
    expectNotStarted();
  });

  it("starts a followed job's model and clears its finished record", async () => {
    job = jobWith("running", "with-mmproj");
    pull.mockImplementation(async () => {
      job = jobWith("done", "with-mmproj");
      return 0;
    });
    expect(await runLocalModelsPullAndRun([VISION_ID, "--run"])).toBe(0);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(localLlm.removeDownloadJob).toHaveBeenCalledTimes(1);
  });

  it("clears an interrupted record once the pull has completed it", async () => {
    job = jobWith("interrupted", "gguf-only");
    expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(localLlm.removeDownloadJob).toHaveBeenCalledTimes(1);
  });

  it("fetches the projector a followed weights-only job left out", async () => {
    job = jobWith("running", "gguf-only");
    pull.mockImplementationOnce(async () => {
      job = jobWith("done", "gguf-only");
      return 0;
    });
    expect(await runLocalModelsPullAndRun([VISION_ID, "--run"])).toBe(0);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenLastCalledWith([VISION_ID, "--mmproj"]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  describe("a GGUF added from disk", () => {
    function addFromDisk(): string {
      const path = join(userDir, "model.gguf");
      writeFileSync(path, Buffer.alloc(64, 1));
      const def = localLlm.buildLocalGgufModelDef({ path, sizeBytes: 64 });
      addCustomModel(def);
      return def.id;
    }

    it("starts a file that is there", async () => {
      const id = addFromDisk();
      expect(await runLocalModelsPullAndRun([id, "--run"])).toBe(0);
      expect(use).toHaveBeenCalledTimes(1);
      expect(use).toHaveBeenCalledWith(id);
      expect(start).toHaveBeenCalledTimes(1);
    });

    it("stops at a missing file with the pull's exit code", async () => {
      const id = addFromDisk();
      pull.mockResolvedValue(1);
      expect(await runLocalModelsPullAndRun([id, "--run"])).toBe(1);
      expectNotStarted();
    });
  });

  describe("with a chat model already running", () => {
    beforeEach(() => {
      vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({ running: true } as never);
    });

    it("stops only the chat model, before switching and starting", async () => {
      expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith({ chatOnly: true });
      expect(stop.mock.invocationCallOrder[0]!).toBeLessThan(use.mock.invocationCallOrder[0]!);
    });

    it("returns the stop's exit code when it fails", async () => {
      stop.mockResolvedValue(1);
      expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(1);
      expectNotStarted();
    });
  });

  it("does not start when making the model active fails", async () => {
    use.mockResolvedValue(1);
    expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns the start's exit code", async () => {
    start.mockResolvedValue(1);
    expect(await runLocalModelsPullAndRun([TEXT_ID, "--run"])).toBe(1);
  });
});

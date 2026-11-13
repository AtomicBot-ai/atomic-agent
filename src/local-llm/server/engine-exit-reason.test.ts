import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLogFilePath } from "../backend-paths.js";
import { sanitizeLlmFailureTags } from "../../error-reporting/llm-failure-tags.js";
import { classifyEngineExitReason, readEngineExitReason } from "./engine-exit-reason.js";

/**
 * ATO-1435: why the managed engine's process is gone, as one fixed word
 * from its log. The samples are the lines llama.cpp and Core print for
 * each case; the surrounding lines carry a path and a model name that
 * must never come out.
 */
const LAUNCH = "[atomic-agent] launch: model qwen3-8b-q4 on 127.0.0.1:19091\n";
const PREAMBLE = "llama_model_loader: loaded meta data from /Users/someone/models/secret-model.gguf\n";

describe("classifyEngineExitReason", () => {
  it.each<[string, string]>([
    ["CUDA out of memory", "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 4096.00 MiB on device 0: cudaMalloc failed: out of memory\n"],
    ["Metal out of memory", "ggml_metal_graph_compute: command buffer 0 failed with status 5\nerror: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)\n"],
    ["Vulkan out of memory", "ggml_vulkan: Device memory allocation of size 2147483648 failed.\nvk::Device::allocateMemory: ErrorOutOfDeviceMemory\n"],
  ])("%s is out_of_memory", (_name, log) => {
    expect(classifyEngineExitReason(LAUNCH + PREAMBLE + log)).toBe("out_of_memory");
  });

  it("a model file that is not there is model_file_missing", () => {
    const log = "gguf_init_from_file: failed to open GGUF file '/Users/someone/models/gone.gguf' (No such file or directory)\n"
      + "llama_model_load: error loading model: llama_model_loader: failed to load model from /Users/someone/models/gone.gguf\n";
    expect(classifyEngineExitReason(LAUNCH + log)).toBe("model_file_missing");
  });

  it.each<[string, string]>([
    ["bad magic", "gguf_init_from_file_impl: invalid magic characters: 'PK\\x03\\x04', expected 'GGUF'\n"],
    ["unknown architecture", "llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'qwen9'\n"],
    ["truncated", "llama_model_load: error loading model: tensor 'blk.30.ffn_down.weight' data is not within the file bounds, model is corrupted or incomplete\n"],
  ])("a model llama.cpp cannot read (%s) is model_file_corrupt", (_name, log) => {
    expect(classifyEngineExitReason(LAUNCH + PREAMBLE + log)).toBe("model_file_corrupt");
  });

  it.each<[string, string]>([
    ["old CUDA driver", "ggml_cuda_init: failed to initialize CUDA: CUDA driver version is insufficient for CUDA runtime version\n"],
    ["no CUDA device", "ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected\n"],
    ["Vulkan device lost", "ggml_vulkan: vk::Queue::submit: ErrorDeviceLost\n"],
  ])("a GPU backend that fails to start (%s) is gpu_driver", (_name, log) => {
    expect(classifyEngineExitReason(LAUNCH + PREAMBLE + log)).toBe("gpu_driver");
  });

  it("a taken port is port_in_use", () => {
    expect(classifyEngineExitReason(LAUNCH + "main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 19091\n")).toBe("port_in_use");
    expect(classifyEngineExitReason(LAUNCH + "listen EADDRINUSE: address already in use 127.0.0.1:19091\n")).toBe("port_in_use");
  });

  it("an empty log is no_log", () => {
    expect(classifyEngineExitReason("")).toBe("no_log");
    expect(classifyEngineExitReason("\n  \n")).toBe("no_log");
  });

  it("a log with nothing recognised is crashed_unknown", () => {
    expect(classifyEngineExitReason(LAUNCH + PREAMBLE + "srv  update_slots: all slots are idle\n")).toBe("crashed_unknown");
  });

  it("reads only the current run: an earlier launch's fault is not this one's", () => {
    const earlier = LAUNCH + "cudaMalloc failed: out of memory\n";
    expect(classifyEngineExitReason(earlier + LAUNCH + "main: couldn't bind HTTP server socket\n")).toBe("port_in_use");
  });
});

describe("readEngineExitReason", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-exit-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("no log file is no_log", () => {
    expect(readEngineExitReason(dataDir)).toBe("no_log");
  });

  it("reads the managed engine's log", () => {
    writeFileSync(resolveLogFilePath(dataDir), LAUNCH + "gguf_init_from_file: failed to open GGUF file '/x.gguf' (No such file or directory)\n");
    expect(readEngineExitReason(dataDir)).toBe("model_file_missing");
  });

  it("a read that throws is no_log", () => {
    expect(readEngineExitReason(dataDir, () => { throw new Error("EACCES"); })).toBe("no_log");
  });

  it("no character of the log reaches the error report's tags", () => {
    const log = LAUNCH + PREAMBLE + "gguf_init_from_file: failed to open GGUF file '/Users/someone/models/secret-model.gguf' (No such file or directory)\n";
    writeFileSync(resolveLogFilePath(dataDir), log);
    const tags = sanitizeLlmFailureTags({
      localEngine: "atomic-core",
      connectionRefused: true,
      engineLiveness: "no_pid",
      engineExitReason: readEngineExitReason(dataDir),
    });
    expect(tags?.engine_exit_reason).toBe("model_file_missing");
    const sent = JSON.stringify(tags);
    for (const piece of ["someone", "secret-model", "qwen3", "gguf", "19091", "/"]) {
      expect(sent).not.toContain(piece);
    }
  });
});

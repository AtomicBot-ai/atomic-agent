import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { commandOf, resolveBinary } from "../agent-client.js";

/**
 * The agent's own `models start`, end to end, with nothing real behind it —
 * for the checks of backlog items 39 and 42 (smoke-tasks/t39.ts, t42.ts).
 *
 * A throwaway state dir holds a config on the managed route with
 * Qwen 3.5 4B picked, a llama.cpp "install" (its version record) and the
 * model's file, which is a GGUF header only: the launch reads the KV layout
 * from it, and nothing ever loads it. The installed `llama-server` is a
 * stand-in, run by this app's own binary as Node. It answers
 * `--list-devices` with the device table the check sets, serves `/health`,
 * `/v1/models`, `/slots` and the speed probe's `/completion` (21.5 tok/s),
 * and writes down what it was asked: `list-devices`, `serve {ctx, parallel,
 * device}` with its own flags, and `probe`. The agent binary is the real one,
 * pointed at the throwaway dir through ATOMIC_AGENT_STATE_DIR; the
 * llama.cpp auto-update is off there, so nothing is fetched.
 */

const run = promisify(execFile);

const STAND_IN = String.raw`const fs = require("fs");
const http = require("http");
const path = require("path");
const note = (line) => fs.appendFileSync(path.join(__dirname, "calls.log"), line + "\n");
const args = process.argv.slice(2);
if (args.indexOf("--list-devices") >= 0) {
  note("list-devices");
  let rows = "";
  try { rows = fs.readFileSync(path.join(__dirname, "devices.txt"), "utf8"); } catch (e) {}
  process.stdout.write("Available devices:\n" + rows);
  process.exit(0);
}
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const alias = at("-a");
note("serve " + JSON.stringify({ctx: at("--ctx-size"), parallel: at("--parallel"), device: at("--device")}));
const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, {"content-type": "application/json"}); res.end(JSON.stringify(body)); };
  req.resume();
  if (req.url === "/health") return send(200, {status: "ok"});
  if (req.url === "/v1/models") return send(200, {data: [{id: alias}]});
  if (req.url === "/slots") return send(200, [{id: 0, is_processing: false}]);
  if (req.url === "/completion") {
    note("probe");
    return send(200, {content: "4\n", timings: {predicted_n: 64, predicted_per_second: 21.5, prompt_per_second: 150}});
  }
  send(404, {error: "not found"});
});
server.listen(Number(at("--port")), "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
setInterval(() => {}, 1 << 30);
`;

const MODEL_ID = "qwen-3.5-4b";
const MODEL_FILE = "Qwen3.5-4B-Q4_K_M.gguf";

/** A GGUF v3 header with these keys and no tensors: strings as STRING, numbers as UINT32. */
function ggufHeader(pairs: Array<[string, string | number]>): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
  const str = (s: string) => { const bytes = Buffer.from(s, "utf8"); return Buffer.concat([u64(bytes.length), bytes]); };
  const parts = [u32(0x46554747), u32(3), u64(0), u64(pairs.length)];
  for (const [key, value] of pairs) {
    parts.push(str(key));
    parts.push(typeof value === "string" ? Buffer.concat([u32(8), str(value)]) : Buffer.concat([u32(4), u32(value)]));
  }
  return Buffer.concat(parts);
}

/** KV bytes a token of context costs the `dense` header at turbo3 (3.5 bits a value): 28 KiB. */
export const DENSE_KV_BYTES_PER_TOKEN = (32 * 8 * (128 + 128) * 3.5) / 8;

/**
 * The model's header. `qwen35`: Qwen 3.5 4B as its file has it (8 of 32
 * layers attend, 4 KV heads × 256 dims: 7 KiB a token at turbo3).
 * `dense`: every one of 32 layers attends, 8 KV heads × 128 dims — 28 KiB a
 * token, dear enough that the unified-memory share shows on a 32 GB machine.
 */
function header(model: "qwen35" | "dense"): Buffer {
  if (model === "qwen35") {
    return ggufHeader([
      ["general.architecture", "qwen35"],
      ["qwen35.block_count", 32],
      ["qwen35.context_length", 262_144],
      ["qwen35.embedding_length", 2560],
      ["qwen35.attention.head_count", 16],
      ["qwen35.attention.head_count_kv", 4],
      ["qwen35.attention.key_length", 256],
      ["qwen35.attention.value_length", 256],
      ["qwen35.ssm.conv_kernel", 4],
      ["qwen35.ssm.state_size", 128],
      ["qwen35.full_attention_interval", 4],
    ]);
  }
  return ggufHeader([
    ["general.architecture", "llama"],
    ["llama.block_count", 32],
    ["llama.context_length", 262_144],
    ["llama.embedding_length", 4096],
    ["llama.attention.head_count", 32],
    ["llama.attention.head_count_kv", 8],
    ["llama.attention.key_length", 128],
    ["llama.attention.value_length", 128],
  ]);
}

const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const srv = createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
});
/** Below the ephemeral range, as t30's stand-ins: a port bind(0) hands out could answer for another run. */
async function standInPort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    if (await portFree(port)) return port;
  }
  throw new Error("no free port for the stand-in");
}

export interface CliRun { ok: boolean; stdout: string; stderr: string; error?: string }

export interface ManagedStart {
  /** The port the config names, which the stand-in serves on. */
  port: number;
  /** `atag models start` / `models stop` on the throwaway state dir. */
  start(): Promise<CliRun>;
  stop(): Promise<CliRun>;
  /** What the stand-in was asked since the last `clearCalls`, in order. */
  calls(): string[];
  clearCalls(): void;
  /** The `--list-devices` table rows the stand-in answers with. */
  devices(...rows: string[]): void;
  /** A llama.cpp update: a new tag in the version record. */
  build(tag: string): void;
  /** `localModels.managed.*` over the defaults this config starts from. */
  managed(over: Record<string, unknown>): void;
  /** The daemon log `models start` writes its launch lines to. */
  log(): string;
  dispose(): Promise<void>;
}

/** The `{ctx, parallel, device}` the last `serve` line recorded, or null. */
export function servedWith(calls: string[]): { ctx: string | null; parallel: string | null; device: string | null } | null {
  const line = [...calls].reverse().find((l) => l.startsWith("serve "));
  return line ? (JSON.parse(line.slice("serve ".length)) as { ctx: string | null; parallel: string | null; device: string | null }) : null;
}

export async function managedStart(model: "qwen35" | "dense"): Promise<ManagedStart> {
  const bin = resolveBinary();
  if (!bin) throw new Error("no agent binary");
  const dir = mkdtempSync(join(tmpdir(), "aa-managed-start-"));
  const state = join(dir, "state");
  const data = join(state, "models");
  const backend = join(data, "backend");
  mkdirSync(backend, { recursive: true });
  mkdirSync(join(data, "models", MODEL_ID), { recursive: true });
  writeFileSync(join(data, "models", MODEL_ID, MODEL_FILE), header(model));

  const script = join(dir, "llama-server-stand-in.cjs");
  writeFileSync(script, STAND_IN);
  writeFileSync(join(dir, "calls.log"), "");
  const server = join(backend, "llama-server");
  writeFileSync(server, ["#!/bin/sh", `ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(script)} "$@"`, ""].join("\n"));
  chmodSync(server, 0o755);

  const port = await standInPort();
  let managedOver: Record<string, unknown> = {};
  const writeConfig = () => writeFileSync(join(state, "config.json"), JSON.stringify({
    localModels: {
      mode: "managed",
      managed: { modelId: MODEL_ID, port, autoUpdate: false, parallel: 1, contextSize: 0, ...managedOver },
    },
  }, null, 2));
  writeConfig();
  const build = (tag: string) => writeFileSync(join(backend, "backend-version.json"), JSON.stringify({
    tag,
    downloadedAt: new Date().toISOString(),
    asset: "llama-turboquant-macos-arm64.zip",
  }, null, 2));
  build("turboquant-smoke-1");

  const cli = async (verb: "start" | "stop"): Promise<CliRun> => {
    try {
      const { stdout, stderr } = await run(bin, ["models", verb], {
        env: { ...process.env, ATOMIC_AGENT_STATE_DIR: state },
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: e.message ?? String(err) };
    }
  };
  const pidFile = join(data, "llama-server.pid");
  /** A stand-in the stop left behind (it never should) goes — only ever one of ours, by its command line. */
  const reap = () => {
    let pid = 0;
    try { pid = Number(readFileSync(pidFile, "utf8").trim()) || 0; } catch { /* none */ }
    if (pid > 1 && (commandOf(pid) ?? "").includes(script)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  };

  return {
    port,
    start: () => cli("start"),
    stop: async () => {
      const res = await cli("stop");
      // The stand-in's port is free again before the next start asserts it is.
      for (let i = 0; i < 40 && !(await portFree(port)); i++) await wait(50);
      return res;
    },
    calls: () => readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
    clearCalls: () => writeFileSync(join(dir, "calls.log"), ""),
    devices: (...rows: string[]) => writeFileSync(join(dir, "devices.txt"), rows.map((r) => `  ${r}\n`).join("")),
    build,
    managed: (over) => { managedOver = { ...managedOver, ...over }; writeConfig(); },
    log: () => {
      const file = join(data, "llama-server.log");
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
    dispose: async () => {
      await cli("stop");
      reap();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

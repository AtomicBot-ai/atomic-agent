import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CORE_PROTOCOL, coreBinary, coreDataDir, coreVersionDir, readCoreJson, type CoreSession } from "./core-state.js";

export interface CoreSnapshot {
  instance_id: string;
  version: string;
  protocol: number;
  owner_scope: string;
  data_folder: string;
  sessions: CoreSession[];
  clients: Array<{ id: string; pid: number | null }>;
}
interface CoreLock {
  state: string;
  instance_id: string;
  version: string;
  protocol: number;
  data_folder: string;
  control_host: string;
  control_port: number;
}
export class CoreControlClient {
  constructor(readonly base: string, private readonly token: string, readonly version: string,
    readonly instanceId: string, private readonly request: typeof fetch = fetch) {}

  async call<T>(path: string, body?: unknown, opts: { method?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const response = await this.request(`${this.base}/atomic/v1${path}`, {
      method: opts.method ?? (body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      redirect: "error",
    });
    const value = await response.json() as T & { error?: { code?: string; message?: string } };
    if (!response.ok) throw new Error(value.error?.message ?? `Atomic Core request failed (${response.status})`);
    return value;
  }

  async downloadEvents(taskId: string, onProgress: (p: number, transferred: number, total: number) => void, signal?: AbortSignal): Promise<() => Promise<void>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try { response = await this.request(`${this.base}/atomic/v1/events`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, redirect: "error",
    }); } finally { clearTimeout(timer); }
    if (!response.ok || !response.body) throw new Error("Atomic Core download events are unavailable.");
    const reader = response.body.getReader();
    const done = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error("Atomic Core event is too large.");
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const lines = frame.split("\n");
          const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
          if (event !== "download:progress") continue;
          const data = JSON.parse(lines.filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n")) as { payload?: { taskId: string; transferred: number; total: number; percent: number }; taskId?: string; transferred?: number; total?: number; percent?: number };
          const progress = data.payload ?? data;
          if (progress.taskId === taskId && typeof progress.transferred === "number" && typeof progress.total === "number" && progress.total > 0) {
            onProgress(Math.min(100, Math.floor(progress.transferred / progress.total * 100)), progress.transferred, progress.total);
          }
        }
      }
    })().catch(() => { /* Progress is advisory; the install response owns success/failure. */ });
    return async () => { controller.abort(); await reader.cancel().catch(() => {}); await done; reader.releaseLock(); };
  }

  async snapshot(dataFolder?: string): Promise<CoreSnapshot> {
    const snapshot = await this.call<CoreSnapshot>("/snapshot");
    if (snapshot.protocol !== CORE_PROTOCOL || snapshot.version !== this.version ||
        snapshot.instance_id !== this.instanceId || snapshot.owner_scope !== "cli" ||
        (dataFolder && snapshot.data_folder !== dataFolder)) {
      throw new Error("Atomic Core version, protocol or ownership changed. Reconnect before continuing.");
    }
    return snapshot;
  }
}

export async function connectCore(dataDir: string, version: string): Promise<CoreControlClient | null> {
  const data = coreDataDir(dataDir, version);
  const lock = readCoreJson<CoreLock>(join(data, "atomic-core", "instance.lock"));
  if (!lock || lock.state !== "ready") return null;
  if (lock.control_host !== "127.0.0.1" || !Number.isInteger(lock.control_port) || lock.control_port < 1 || lock.control_port > 65535) {
    throw new Error("Atomic Core supplied an invalid control address.");
  }
  let token: string;
  try { token = readFileSync(join(data, "atomic-core", "control-token"), "utf8").trim(); } catch { return null; }
  if (!token || /\s/.test(token)) throw new Error("Atomic Core control credentials are invalid.");
  const client = new CoreControlClient(`http://127.0.0.1:${lock.control_port}`, token, version, lock.instance_id);
  try { await client.snapshot(realpathSync(data)); } catch (err) {
    if (err instanceof TypeError && /fetch failed/.test(err.message)) return null;
    throw err;
  }
  return client;
}

/** The CLI-scoped daemon survives one-shot model commands; Core owns its lock and child journal. */
export async function ensureCore(dataDir: string, version: string, signal?: AbortSignal): Promise<CoreControlClient> {
  const existing = await connectCore(dataDir, version);
  if (existing) return existing;
  const binary = coreBinary(dataDir, version);
  if (!existsSync(binary)) throw new Error("Atomic Core is not installed. Choose Update engine to install it.");
  mkdirSync(coreDataDir(dataDir, version), { recursive: true, mode: 0o700 });
  const log = openSync(join(coreVersionDir(dataDir, version), "core.log"), "a", 0o600);
  let spawnError: Error | undefined;
  try {
    // No public listener: Agent connects only to Core's authenticated control and model sessions.
    const child = spawn(binary, ["daemon", "--data-folder", coreDataDir(dataDir, version), "--control-port", "0", "--telemetry", "off"], {
      detached: true, windowsHide: true, stdio: ["ignore", log, log],
      env: { ...process.env, ATOMIC_CORE_TELEMETRY: "off" },
    });
    child.once("error", err => { spawnError = err; });
    child.unref();
  } finally { closeSync(log); }
  // Concurrent launches converge through Core's own exclusive owner lock, never by killing a PID.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (spawnError) throw new Error(`Atomic Core could not start: ${spawnError.message}`);
    const client = await connectCore(dataDir, version);
    if (client) return client;
    await delay(150, undefined, signal ? { signal } : {});
  }
  throw new Error("Atomic Core did not become ready. See the engine log and retry.");
}

/** Every operation keeps a lease until it settles, including long downloads and model loads. */
export async function withCoreClient<T>(dataDir: string, version: string, fn: (client: CoreControlClient, clientId: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const client = await ensureCore(dataDir, version, signal);
  const lease = await client.call<{ client: { id: string }; heartbeat_interval_ms: number }>("/clients", { name: "Atomic Agent", pid: process.pid });
  const id = lease.client.id;
  const timer = setInterval(() => { void client.call(`/clients/${encodeURIComponent(id)}/heartbeat`, {}).catch(() => {}); }, Math.max(1000, lease.heartbeat_interval_ms));
  timer.unref();
  try { return await fn(client, id); }
  finally {
    clearInterval(timer);
    await client.call(`/clients/${encodeURIComponent(id)}`, undefined, { method: "DELETE" }).catch(() => {});
  }
}

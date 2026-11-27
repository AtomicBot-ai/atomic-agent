import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

/**
 * `vault://mount/path#field` (ATO-2530): one field of a HashiCorp Vault
 * KV v2 secret, read over HTTP with no `vault` CLI. Precedent: the Vault
 * CLI and Vault Agent, which read the same `VAULT_ADDR`, `VAULT_TOKEN`
 * (else `~/.vault-token`, what `vault login` writes) and `VAULT_NAMESPACE`.
 *
 * - `GET <VAULT_ADDR>/v1/<mount>/data/<path>`, header `X-Vault-Token`;
 *   each path part URL-encoded, `..` refused when the reference is parsed.
 * - The token travels to `https://` only, or plain `http://` to this
 *   machine (a dev server): never in clear over the network.
 * - Redirects are refused, so the token is never sent on to another host.
 * - The answer is capped at 1 MiB; only `data.data[field]` as text is used.
 *
 * `.env` loading is synchronous, so the request can also run on a worker
 * thread while this one waits ({@link fetchVaultSync}).
 */

export interface VaultRef {
  mount: string;
  path: string;
  field: string;
}

export interface VaultRequest {
  url: string;
  headers: Record<string, string>;
  field: string;
}

/** What one Vault request came back with. Never holds the token. */
export type VaultResponse =
  | { status: number; text: string }
  | { failure: "timeout" | "network" | "too-large" };

const MAX_VAULT_RESPONSE_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The request for `ref`, or why it cannot be made (never the token). */
export function planVaultRequest(
  ref: VaultRef,
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): VaultRequest | string {
  const addr = env.VAULT_ADDR?.trim();
  if (!addr) return "vault:// needs VAULT_ADDR (the Vault server address)";
  let base: URL;
  try {
    base = new URL(addr);
  } catch {
    return "VAULT_ADDR is not a URL";
  }
  const local = LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
    return "VAULT_ADDR must be https:// (plain http:// only to this computer), so the token is not sent in clear";
  }
  const token = env.VAULT_TOKEN?.trim() || readTokenFile(home);
  if (!token) return "vault:// needs VAULT_TOKEN or a ~/.vault-token file (vault login)";
  const parts = [ref.mount, "data", ...ref.path.split("/")].map(encodeURIComponent);
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = `${base.origin}${prefix}/v1/${parts.join("/")}`;
  const headers: Record<string, string> = { "X-Vault-Token": token, Accept: "application/json" };
  const namespace = env.VAULT_NAMESPACE?.trim();
  if (namespace) headers["X-Vault-Namespace"] = namespace;
  return { url, headers, field: ref.field };
}

function readTokenFile(home: string): string | undefined {
  const path = join(home, ".vault-token");
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The field's value, or why there is none. The message never holds a value. */
export function vaultFieldOf(response: VaultResponse, request: VaultRequest): { value: string } | { error: string } {
  if ("failure" in response) {
    if (response.failure === "timeout") return { error: "Vault did not answer in time" };
    if (response.failure === "too-large") return { error: "Vault sent more than 1 MiB" };
    return { error: "could not reach Vault (check VAULT_ADDR)" };
  }
  if (response.status === 403) return { error: "Vault refused the token (permission denied)" };
  if (response.status === 404) return { error: "Vault has no secret at that path (KV v2)" };
  if (response.status < 200 || response.status >= 300) return { error: `Vault answered HTTP ${response.status}` };
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    return { error: "Vault did not answer with JSON" };
  }
  const data = (body as { data?: { data?: Record<string, unknown> } } | null)?.data?.data;
  if (data === null || typeof data !== "object") return { error: "not a KV v2 secret (no data.data)" };
  const value = (data as Record<string, unknown>)[request.field];
  if (value === undefined) return { error: `the secret has no field ${request.field}` };
  if (typeof value !== "string") return { error: `field ${request.field} is not text` };
  return { value };
}

/** The production request: `fetch`, redirects refused, a deadline. */
export async function fetchVault(request: VaultRequest, timeoutMs: number): Promise<VaultResponse> {
  try {
    const res = await fetch(request.url, {
      headers: request.headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > MAX_VAULT_RESPONSE_BYTES) return { failure: "too-large" };
    return { status: res.status, text };
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return { failure: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}

// The same request on a worker thread; plain JS, so it runs in the SEA build too.
const WORKER_CODE = `
const { workerData } = require("node:worker_threads");
const { url, headers, timeoutMs, port, shared, max } = workerData;
(async () => {
  let msg;
  try {
    const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    msg = Buffer.byteLength(text, "utf8") > max ? { failure: "too-large" } : { status: res.status, text };
  } catch (err) {
    const name = err && err.name;
    msg = { failure: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
  port.postMessage(msg);
  const flag = new Int32Array(shared);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
})();
`;

/**
 * {@link fetchVault}, blocking this thread until it is done (or a little
 * past `timeoutMs`). For the synchronous `.env` loader only.
 */
export function fetchVaultSync(request: VaultRequest, timeoutMs: number): VaultResponse {
  const shared = new SharedArrayBuffer(4);
  const flag = new Int32Array(shared);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_CODE, {
    eval: true,
    workerData: {
      url: request.url,
      headers: request.headers,
      timeoutMs,
      port: port2,
      shared,
      max: MAX_VAULT_RESPONSE_BYTES,
    },
    transferList: [port2],
  });
  try {
    Atomics.wait(flag, 0, 0, timeoutMs + 2_000);
    const received = receiveMessageOnPort(port1);
    return (received?.message as VaultResponse | undefined) ?? { failure: "timeout" };
  } finally {
    port1.close();
    void worker.terminate();
  }
}

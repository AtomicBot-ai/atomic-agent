/**
 * JSON-RPC client for a local `signal-cli daemon --http` (ATO-629).
 *
 * Only the calls the channel needs: `send` and `sendTyping`. The daemon
 * is started with `-a <account>` (single-account mode), so no request
 * carries an `account` param. Every call has a timeout: a wedged daemon
 * must not hang a turn's reply forever.
 */

const RPC_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A DM partner (number or UUID) or a group (base64 id). */
export type SignalTarget = { recipient: string } | { groupId: string };

export class SignalRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "SignalRpcError";
  }
}

export interface SignalRpcDeps {
  /** Daemon base URL, e.g. `http://127.0.0.1:8080`. */
  url: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class SignalRpc {
  private nextId = 1;

  constructor(private readonly deps: SignalRpcDeps) {}

  /** Send one text message. Returns the Signal timestamp when reported. */
  async send(target: SignalTarget, message: string): Promise<number | null> {
    const result = await this.call("send", { ...targetParams(target), message });
    if (result !== null && typeof result === "object") {
      const ts = (result as { timestamp?: unknown }).timestamp;
      if (typeof ts === "number") return ts;
    }
    return null;
  }

  /** Show or clear the "typing…" indicator. Best-effort by contract. */
  async sendTyping(target: SignalTarget, stop = false): Promise<void> {
    await this.call("sendTyping", { ...targetParams(target), ...(stop ? { stop: true } : {}) });
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.deps.url}/api/v1/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? RPC_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SignalRpcError(
        `signal-cli daemon not reachable at ${this.deps.url} (${describeFetchError(err)})`,
      );
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Fall through to the HTTP status check below.
    }
    if (body !== null && typeof body === "object" && "error" in body) {
      const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
      const code = typeof error?.code === "number" ? error.code : null;
      const message = typeof error?.message === "string" ? error.message : "unknown error";
      throw new SignalRpcError(`signal-cli ${method} failed: ${message}`, code);
    }
    if (!res.ok) {
      throw new SignalRpcError(`signal-cli ${method} failed: HTTP ${res.status}`);
    }
    return body !== null && typeof body === "object"
      ? ((body as { result?: unknown }).result ?? null)
      : null;
  }
}

function targetParams(target: SignalTarget): Record<string, unknown> {
  return "groupId" in target
    ? { groupId: target.groupId }
    : { recipient: [target.recipient] };
}

/** `fetch failed` hides the useful part in `cause` (ECONNREFUSED etc.). */
export function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const code =
      cause !== null && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code
        : null;
    if (err.name === "TimeoutError") return "timed out";
    return code ?? err.message;
  }
  return String(err);
}

/**
 * Studio (Images + Video): the HTTP side of Atomic Chat Core's control API,
 * as the desktop main process speaks it.
 *
 * The desktop does not import the agent's sources (a separate CommonJS
 * build), so this mirrors the agent's `CoreControlClient`
 * (src/local-llm/core/core-client.ts): `<base>/atomic/v1<path>`, a bearer
 * token read from Core's own data folder, JSON both ways, no redirects, a
 * deadline on every call. Core answers a refusal as
 * `{error: {code, message, details?}}` (atomic-chat-core v0.18.6
 * src/server/http.ts `sendError`).
 *
 * Nothing here touches Electron, so the unit tests load it from `out/`.
 */

/** A Core refusal, or a failure on the way to Core, with a code the UI can branch on. */
export class StudioCoreError extends Error {
  override readonly name = "StudioCoreError";
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: string,
  ) {
    super(message);
  }
}

export interface StudioCallOptions {
  method?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One frame of Core's `GET /atomic/v1/events` stream (`id`, `event`, JSON `data`). */
export interface CoreEventFrame {
  id: string | undefined;
  event: string;
  data: unknown;
}

/** Frames bigger than this are not Core's: the stream is dropped rather than buffered without end. */
const MAX_FRAME_CHARS = 4 * 1024 * 1024;

/**
 * Split a server-sent-event buffer into whole frames and the unfinished
 * tail. Core writes `id: …\nevent: …\ndata: <json>\n\n`
 * (src/server/control/routes/lifecycle.ts `sseFrame`). A frame whose data
 * is not JSON is skipped, not thrown: progress is advisory.
 */
export function parseSseFrames(buffer: string): { frames: CoreEventFrame[]; rest: string } {
  const frames: CoreEventFrame[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  let split: number;
  while ((split = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, split);
    rest = rest.slice(split + 2);
    let id: string | undefined;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    try {
      frames.push({ id, event, data: JSON.parse(data.join("\n")) });
    } catch {
      /* not JSON: not a frame this client reads */
    }
  }
  return { frames, rest };
}

export class StudioCoreClient {
  constructor(
    readonly base: string,
    private readonly token: string,
    readonly version: string,
    readonly instanceId: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async call<T>(path: string, body?: unknown, opts: StudioCallOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    let response: Response;
    try {
      response = await this.request(`${this.base}/atomic/v1${path}`, {
        method: opts.method ?? (body === undefined ? "GET" : "POST"),
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        redirect: "error",
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const timedOut = timeout.aborted;
      throw new StudioCoreError(
        timedOut ? "Atomic Core did not answer in time." : "Atomic Core could not be reached.",
        timedOut ? "CORE_TIMEOUT" : "CORE_UNREACHABLE",
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
    // A proxy or a crashed handler may answer without JSON; the status still decides.
    const value = (await response.json().catch(() => null)) as
      | (T & { error?: { code?: string; message?: string; details?: unknown } })
      | null;
    if (!response.ok) {
      const e = value?.error;
      throw new StudioCoreError(
        e?.message ?? `Atomic Core request failed (${response.status}).`,
        e?.code ?? "HTTP_ERROR",
        response.status,
        typeof e?.details === "string" ? e.details : undefined,
      );
    }
    if (value === null) throw new StudioCoreError("Atomic Core returned an unreadable answer.", "BAD_ANSWER", response.status);
    return value;
  }

  /**
   * Follow Core's event stream until `signal` aborts or the stream ends.
   * Resolves when it ends (the caller reconnects or falls back to polling);
   * rejects only when the stream cannot be opened.
   */
  async events(onFrame: (frame: CoreEventFrame) => void, signal: AbortSignal): Promise<void> {
    // The deadline covers opening only: an open stream may stay quiet for minutes.
    const opening = new AbortController();
    const timer = setTimeout(() => opening.abort(), 15_000);
    const response = await this.request(`${this.base}/atomic/v1/events`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
      signal: AbortSignal.any([signal, opening.signal]),
      redirect: "error",
    }).catch((err: unknown) => {
      throw new StudioCoreError("Atomic Core events are unavailable.", "EVENTS_UNAVAILABLE", undefined, err instanceof Error ? err.message : String(err));
    }).finally(() => clearTimeout(timer));
    if (!response.ok || !response.body) throw new StudioCoreError("Atomic Core events are unavailable.", "EVENTS_UNAVAILABLE", response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        if (buffer.length > MAX_FRAME_CHARS) return;
        for (const frame of parsed.frames) onFrame(frame);
      }
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

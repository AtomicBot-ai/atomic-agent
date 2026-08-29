import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type {
  HostRequest,
  SidecarEvent,
  SidecarEventType,
  SidecarMessage,
  SidecarResponse,
} from "./sidecar-events.js";
import { isHostRequest } from "./sidecar-events.js";
import { isBrokenPipeError } from "../error-reporting/broken-pipe.js";

export interface StdioProtocolOptions {
  input: Readable;
  output: Writable;
  onParseError?: (error: Error, rawLine: string) => void;
}

export type RequestHandler = (request: HostRequest) => void;

/**
 * Newline-delimited JSON framing over stdin/stdout.
 * The sidecar emits events and responses; the host sends requests.
 * Every frame is a single JSON object terminated by \n.
 */
export class StdioProtocol {
  private buffer = "";
  private requestHandler: RequestHandler | null = null;
  private closed = false;
  private outputClosed = false;

  constructor(private readonly options: StdioProtocolOptions) {
    options.input.setEncoding("utf8");
    options.input.on("data", (chunk: string) => this.ingest(chunk));
    options.input.on("end", () => {
      this.flushTail();
      this.closed = true;
    });
    // The host end of the pipe can vanish at any moment — the desktop
    // app quits, the CLI that spawned us is killed. Node surfaces that
    // as an ASYNCHRONOUS `error` on the stream, and a stream with no
    // `error` listener throws it as an uncaught exception: a healthy
    // agent dying with a raw EPIPE stack because its peer went away
    // first. Listening (and latching `outputClosed`) turns that into
    // "stop emitting", which is all a vanished host can mean.
    options.output.on("error", (err) => this.onOutputError(err));
    options.output.on("close", () => {
      this.outputClosed = true;
    });
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  emitEvent<TPayload>(
    type: SidecarEventType,
    payload: TPayload,
    correlationId?: string,
  ): SidecarEvent<SidecarEventType, TPayload> {
    const event: SidecarEvent<SidecarEventType, TPayload> = {
      kind: "event",
      id: randomUUID(),
      type,
      correlationId,
      payload,
    };
    this.writeMessage(event);
    return event;
  }

  respond<TPayload>(
    correlationId: string,
    payload: TPayload,
    ok = true,
    error?: { message: string; code?: string },
  ): SidecarResponse<TPayload> {
    const response: SidecarResponse<TPayload> = {
      kind: "response",
      id: randomUUID(),
      correlationId,
      ok,
      payload,
      error,
    };
    this.writeMessage(response);
    return response;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * True once the host stopped reading — the pipe errored, was
   * destroyed, or ended. Every subsequent `emitEvent` / `respond` is a
   * silent no-op; there is nobody left to read the frame.
   */
  isOutputClosed(): boolean {
    return this.outputClosed;
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleLine(rawLine);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private flushTail(): void {
    if (this.buffer.trim().length > 0) {
      this.handleLine(this.buffer);
      this.buffer = "";
    }
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;
    let message: SidecarMessage;
    try {
      message = JSON.parse(trimmed) as SidecarMessage;
    } catch (err) {
      this.options.onParseError?.(
        err instanceof Error ? err : new Error(String(err)),
        trimmed,
      );
      return;
    }
    if (isHostRequest(message) && this.requestHandler) {
      this.requestHandler(message);
    }
  }

  /**
   * Latch the output as closed. Only a broken-pipe style failure is
   * swallowed — anything else is a real stream bug and is re-thrown on
   * the next tick so it is not lost, matching Node's default behaviour
   * for an unhandled stream error.
   */
  private onOutputError(err: unknown): void {
    this.outputClosed = true;
    if (isBrokenPipeError(err)) return;
    queueMicrotask(() => {
      throw err;
    });
  }

  private writeMessage(message: SidecarMessage): void {
    if (this.outputClosed || this.options.output.destroyed) return;
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.options.output.write(line);
    } catch (err) {
      // A synchronous throw from `write` (already-destroyed stream)
      // reaches us here rather than through the `error` event.
      this.outputClosed = true;
      if (!isBrokenPipeError(err)) throw err;
    }
  }
}

export function framed(message: SidecarMessage): string {
  return `${JSON.stringify(message)}\n`;
}

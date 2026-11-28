/**
 * ATO-2514: the other side of a call ("Them"), for Record a meeting.
 *
 * Where it comes from, per OS:
 *   macOS    native/atomic-system-audio.swift (ScreenCaptureKit), spawned
 *            here; its stdout is raw 16 kHz mono s16le, cut into the same
 *            100 ms frames the microphone tap sends, with their peak.
 *   Windows  the renderer's getDisplayMedia with WASAPI loopback audio
 *            (meeting-system-ipc.ts answers the display-media request).
 *   Linux    the renderer opens the PulseAudio / PipeWire "Monitor of …"
 *            input, when the sound server lists one.
 * The Windows and Linux frames come over IPC, so only macOS needs this file's
 * process half; the framing and the helper's event lines are pure and tested.
 *
 * No electron: test/meeting-system-audio.test.mjs drives it with a fake helper.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** 100 ms of 16 kHz s16le, the microphone tap's frame. */
export const SYSTEM_FRAME_BYTES = 3_200;

export type SystemAudioMode = "helper" | "loopback" | "monitor" | "none";

/** How this OS gets the other side of a call. */
export function systemAudioMode(platform: NodeJS.Platform): SystemAudioMode {
  if (platform === "darwin") return "helper";
  if (platform === "win32") return "loopback";
  if (platform === "linux") return "monitor";
  return "none";
}

/** The loudest sample of an s16le frame, 0 to 1 (the worklet's `peak`). */
export function peakOf(frame: Uint8Array): number {
  const n = frame.byteLength - (frame.byteLength % 2);
  const view = new DataView(frame.buffer, frame.byteOffset, n);
  let max = 0;
  for (let i = 0; i < n; i += 2) {
    const v = Math.abs(view.getInt16(i, true));
    if (v > max) max = v;
  }
  return max / 32768;
}

/** Bytes in, whole frames out; the tail waits for the next push. */
export class PcmFramer {
  private rest: Buffer = Buffer.alloc(0);
  constructor(private readonly size = SYSTEM_FRAME_BYTES) {}

  push(data: Uint8Array): Uint8Array[] {
    const all = this.rest.length ? Buffer.concat([this.rest, Buffer.from(data)]) : Buffer.from(data);
    const out: Uint8Array[] = [];
    let at = 0;
    for (; at + this.size <= all.length; at += this.size) out.push(new Uint8Array(all.subarray(at, at + this.size)));
    this.rest = Buffer.from(all.subarray(at));
    return out;
  }
}

export interface HelperEvent {
  type: "ready" | "error" | "done";
  code?: string;
}

/** One stderr line of the helper → its event, or null for anything else. */
export function parseHelperLine(line: string): HelperEvent | null {
  try {
    const o = JSON.parse(String(line || "").trim()) as { type?: unknown; code?: unknown };
    if (o.type !== "ready" && o.type !== "error" && o.type !== "done") return null;
    return typeof o.code === "string" ? { type: o.type, code: o.code } : { type: o.type };
  } catch {
    return null;
  }
}

export interface SystemCaptureDeps {
  /** The helper binary (Resources/native/atomic-system-audio). */
  command: string;
  /** The app's bundle id: its own sound is left out of the capture. */
  excludeBundle?: string;
  onFrame: (frame: Uint8Array, peak: number) => void;
  /** `ready`, or why it stopped: `screen-denied`, `no-display`, `failed`, `exited`. */
  onState: (state: string) => void;
  spawnFn?: typeof spawn;
}

/** The macOS capture: start once, stop once. */
export class MacSystemAudio {
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(private readonly deps: SystemCaptureDeps) {}

  start(): boolean {
    if (this.child || this.stopped) return false;
    const args = this.deps.excludeBundle ? ["--exclude-bundle", this.deps.excludeBundle] : [];
    let child: ChildProcess;
    try {
      child = (this.deps.spawnFn ?? spawn)(this.deps.command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.deps.onState("failed");
      return false;
    }
    this.child = child;
    const framer = new PcmFramer();
    let reported = false;
    const report = (state: string) => { if (!reported || state === "ready") { if (state !== "ready") reported = true; this.deps.onState(state); } };
    child.stdout?.on("data", (c: Buffer) => {
      if (this.stopped) return;
      for (const f of framer.push(c)) this.deps.onFrame(f, peakOf(f));
    });
    let pending = "";
    child.stderr?.on("data", (c: Buffer) => {
      pending += c.toString("utf8");
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const ev = parseHelperLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        if (ev?.type === "ready") report("ready");
        else if (ev?.type === "error") report(ev.code ?? "failed");
        nl = pending.indexOf("\n");
      }
    });
    child.on("error", () => report("failed"));
    child.on("exit", () => { this.child = null; if (!this.stopped) report("exited"); });
    return true;
  }

  /** Stdin closes (the helper stops itself); a helper that hangs is killed after a second. */
  stop(): void {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    try { child.stdin?.end(); } catch { /* gone */ }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1000);
    child.once("exit", () => clearTimeout(t));
  }
}

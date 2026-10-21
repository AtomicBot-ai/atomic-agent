/**
 * Studio and the local chat model on one machine's memory.
 *
 * A local image or video model and the managed chat model (llama.cpp) both
 * want most of the GPU's memory. Left alone they fight: loading a diffusion
 * model through Atomic Core stops the chat session (Core 0.18.6 keeps one
 * resident local model per GPU, src/core/gpu/policy.ts), the supervisor
 * (daemon-supervisor.ts) reads that as a crash and starts the chat model
 * again, Core refuses that start with GPU_BUSY while the job runs, and after
 * three quick deaths the supervisor gives up — or, on the plain llama-server
 * engine, both stay loaded and the machine swaps or runs out of memory.
 *
 * What happens instead (the order Atomic Chat's arbiter uses,
 * web-app/src/lib/diffusion/arbiter.ts, plus the desktop's own supervisor):
 *
 *   - Before a local generation the chat model **yields** its memory when the
 *     two would not both fit (always under Core, which never keeps them
 *     together): it is stopped as Studio's, not as a crash nor as a stop on
 *     purpose, and the supervisor holds still while it is yielded.
 *     When they fit, both stay, and the diffusion load's offload policy is
 *     worked out against what the chat model leaves (offload when tight).
 *   - While it is yielded, a chat turn that needs the local model waits in
 *     main with a clear line instead of failing; cloud turns never wait.
 *   - When the last local generation ends the chat model comes back in the
 *     background (as the launch brings it up), a short while later so a run
 *     of images does not reload it between each, or at once when a chat turn
 *     is waiting. The diffusion model is unloaded first unless both fit.
 *   - A local chat turn that finds an idle diffusion model in the way unloads
 *     it first.
 *   - One local generation at a time; studio-media.ts queues the next.
 *
 * `decideGpuShare` is the whole policy, pure, for the unit suite. `GpuShare`
 * runs it with every effect handed in, so no Electron and no agent here.
 */

import type { MachineProfile } from "./studio-local.js";

const GIB = 1024 ** 3;

/** Atomic Chat's arbiter: two models coexist when they take at most this share of the budget (COEXIST_SHARE). */
export const COEXIST_SHARE = 0.9;
/** A running llama.cpp model holds its weights plus the KV cache and compute buffers: the file size × this, + RUNTIME_OVERHEAD. */
export const CHAT_RUNTIME_FACTOR = 1.1;
export const CHAT_RUNTIME_OVERHEAD_BYTES = 1 * GIB;
/** How long after the last local generation the yielded chat model comes back, unless a chat turn waits for it. */
export const RESUME_DELAY_MS = 20_000;

/** What the chat model holds while it runs, from the size of its GGUF files on disk; null when unknown. */
export function chatResidentBytes(fileBytes: number | null | undefined): number | null {
  if (typeof fileBytes !== "number" || !Number.isFinite(fileBytes) || fileBytes <= 0) return null;
  return Math.round(fileBytes * CHAT_RUNTIME_FACTOR + CHAT_RUNTIME_OVERHEAD_BYTES);
}

/* ------------------------------------------------------------ the policy */

export interface GpuSnapshot {
  /** What a model may use here (MachineProfile.budgetBytes: RAM, × 0.85 on Macs); null when unknown. */
  budgetBytes: number | null;
  /** The chat model's resident estimate (chatResidentBytes); null when unknown. */
  chatBytes: number | null;
  /** The diffusion model's need: the one about to load, or the one resident (fitFor residentBytes). */
  diffusionBytes: number | null;
  /** Core runs the chat model: it never keeps a chat and a diffusion model loaded together (one model per GPU). */
  oneModelPerGpu: boolean;
  /** `on`: the route needs the managed chat model (Local models, or Fusion with a local seat). `yielded`: stopped for Studio. */
  chat: "off" | "on" | "yielded";
  /** `busy`: a local generation is loading or running. `idle`: a diffusion model sits loaded with no job. */
  diffusion: "none" | "idle" | "busy";
  /** Chat turns held in main for the generation. */
  waitingTurns: number;
}

export type GpuEvent =
  /** A local generation (or an explicit model load) is about to load its model. */
  | "diffusion-start"
  /** The local generations ended: done, failed or cancelled, and nothing queued follows. */
  | "diffusion-end"
  /** The pause after the last generation is over: time to bring the chat model back. */
  | "chat-resume"
  /** A chat turn that needs the local model is about to be sent. */
  | "chat-turn";

export type GpuAction =
  /** Stop the chat model as Studio's: no auto-restart, no "stopped" incident. */
  | { do: "yield-chat" }
  /** Bring the yielded chat model back in the background; `later` after RESUME_DELAY_MS. */
  | { do: "resume-chat"; when: "now" | "later" }
  | { do: "unload-diffusion" }
  /** The chat turn waits until the generation ends. */
  | { do: "hold-turn" }
  /** The memory the diffusion load's offload policy is worked out against (Core's "Auto": offload when tight). */
  | { do: "budget"; bytes: number | null };

/** Whether the chat model and the diffusion model can both stay loaded. Unknown sizes do not fit (Atomic Chat's rule). */
export function canCoexist(s: Pick<GpuSnapshot, "budgetBytes" | "chatBytes" | "diffusionBytes" | "oneModelPerGpu">): boolean {
  if (s.oneModelPerGpu) return false;
  if (s.budgetBytes === null || s.chatBytes === null || s.diffusionBytes === null) return false;
  return s.chatBytes + s.diffusionBytes <= s.budgetBytes * COEXIST_SHARE;
}

/** What to do on `event`, given the machine and both models now. Pure; the order of the actions is the order to run them in. */
export function decideGpuShare(event: GpuEvent, s: GpuSnapshot): GpuAction[] {
  const coexist = canCoexist(s);
  const comeBack = (when: "now" | "later"): GpuAction[] =>
    s.diffusion === "busy" ? [] : [...(!coexist && s.diffusion === "idle" ? [{ do: "unload-diffusion" } as const] : []), { do: "resume-chat", when }];
  switch (event) {
    case "diffusion-start":
      if (s.chat === "on" && !coexist) return [{ do: "yield-chat" }, { do: "budget", bytes: s.budgetBytes }];
      if (s.chat === "on") return [{ do: "budget", bytes: s.budgetBytes === null || s.chatBytes === null ? s.budgetBytes : Math.max(0, s.budgetBytes - s.chatBytes) }];
      return [{ do: "budget", bytes: s.budgetBytes }];
    case "diffusion-end":
      // The unload, when one is due, waits for the resume: another image a moment later keeps the model loaded.
      if (s.chat === "yielded") return [{ do: "resume-chat", when: s.waitingTurns > 0 ? "now" : "later" }];
      if (s.chat === "on" && s.diffusion === "idle" && !coexist) return [{ do: "unload-diffusion" }];
      return [];
    case "chat-resume":
      return s.chat === "yielded" ? comeBack("now") : [];
    case "chat-turn":
      if (s.chat === "yielded") return s.diffusion === "busy" ? [{ do: "hold-turn" }] : comeBack("now");
      if (s.chat === "on" && s.diffusion === "idle" && !coexist) return [{ do: "unload-diffusion" }];
      return [];
  }
}

/* ------------------------------------------------------------ the runner */

/** The chat side, as main reads it (daemon-watch.ts chatForStudio). Cheap: no probe of the server. */
export interface ChatSide {
  /** The route needs the managed chat model. */
  wanted: boolean;
  /** Its GGUF files' size on disk; null when unknown. */
  fileBytes: number | null;
  oneModelPerGpu: boolean;
}

/** The diffusion side, from studio-media.ts once it exists. */
export interface DiffusionSide {
  /** Unload the diffusion model from Core (a no-op when none is loaded). */
  unload(): Promise<void>;
}

export interface GpuShareDeps {
  profile(): MachineProfile | null;
  chat(): ChatSide;
  /** Stop the chat model for Studio (daemon-watch.ts yieldChatToStudio). Answers a token for `resumeChat`. */
  yieldChat(): Promise<unknown>;
  /** Bring it back in the background (daemon-watch.ts resumeChatAfterStudio). */
  resumeChat(token: unknown): void;
  say?(line: string): void;
  resumeDelayMs?: number;
}

export interface GpuShareState {
  chat: "off" | "on" | "yielded";
  /** The local generation loading or running, or null. `jobId` is null while its model loads. */
  generating: { kind: "image" | "video"; model: string; jobId: string | null } | null;
  /** Local generations queued behind it (studio-media.ts). */
  queued: number;
  /** Chat turns held for it. */
  heldTurns: number;
  /** The composer's line for a held chat turn, or null. */
  chatLine: string | null;
}

/** A held chat turn: `wait` settles once the chat model is on its way back; `drop` when the person stops the turn first. */
export interface HeldTurn { wait: Promise<void>; drop(): void }

export class GpuShare {
  private yielded = false;
  private token: unknown = null;
  private job: GpuShareState["generating"] = null;
  private jobBytes: number | null = null;
  /** The diffusion model left loaded after the last job, and its need. */
  private resident: { model: string; bytes: number | null } | null = null;
  private queued = 0;
  private readonly waiters = new Set<() => void>();
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private diffusion: DiffusionSide | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private listener: (s: GpuShareState) => void = () => {};

  constructor(private readonly deps: GpuShareDeps) {}

  attachDiffusion(side: DiffusionSide): void {
    this.diffusion = side;
  }

  onState(fn: (s: GpuShareState) => void): void {
    this.listener = fn;
  }

  state(): GpuShareState {
    const chat = this.chatState();
    return {
      chat,
      generating: this.job ? { ...this.job } : null,
      queued: this.queued,
      heldTurns: this.waiters.size,
      chatLine: this.waiters.size && this.job ? waitLine(this.job.kind) : null,
    };
  }

  /** Whether running a local model of `diffusionBytes` here pauses the chat model (the Studio hint). */
  pausesChat(diffusionBytes: number | null): boolean {
    const c = this.deps.chat();
    if (!c.wanted) return false;
    return !canCoexist({ budgetBytes: this.budget(), chatBytes: chatResidentBytes(c.fileBytes), diffusionBytes, oneModelPerGpu: c.oneModelPerGpu });
  }

  /**
   * A local generation is about to load its model and run. Yields the chat
   * model when the two do not fit; answers the budget the diffusion load's
   * offload policy is worked out against. Every call is paired with one
   * `diffusionEnd`, whatever happens after.
   */
  diffusionStart(job: { kind: "image" | "video"; model: string; bytes: number | null }): Promise<{ budgetBytes: number | null }> {
    return this.serial(async () => {
      this.clearResumeTimer();
      this.job = { kind: job.kind, model: job.model, jobId: null };
      this.jobBytes = job.bytes;
      let budgetBytes = this.budget();
      for (const a of decideGpuShare("diffusion-start", this.snapshot())) {
        if (a.do === "budget") budgetBytes = a.bytes;
        if (a.do === "yield-chat" && !this.yielded) {
          this.token = await this.deps.yieldChat();
          this.yielded = true;
          this.deps.say?.(`[desktop] studio: the local chat model is paused while ${job.model} runs (they do not fit in memory together)`);
        }
      }
      this.emit();
      return { budgetBytes };
    });
  }

  /** The running generation's Core job id, once Core took it. */
  jobStarted(jobId: string): void {
    if (this.job) { this.job.jobId = jobId; this.emit(); }
  }

  setQueued(n: number): void {
    this.queued = Math.max(0, n);
    this.emit();
  }

  /**
   * The local generation ended (done, failed, cancelled, or it never got to
   * Core). `more`: a queued one starts at once, so the chat model stays
   * yielded. `loaded`: the diffusion model is still in Core.
   */
  diffusionEnd(opts: { more: boolean; loaded: boolean }): Promise<void> {
    return this.serial(async () => {
      const ended = this.job;
      this.job = null;
      this.resident = opts.loaded && ended ? { model: ended.model, bytes: this.jobBytes } : null;
      this.jobBytes = null;
      if (opts.more) { this.emit(); return; }
      for (const a of decideGpuShare("diffusion-end", this.snapshot())) {
        if (a.do === "resume-chat") {
          if (a.when === "now") await this.resumeNow();
          else this.scheduleResume();
        }
        if (a.do === "unload-diffusion") await this.unloadDiffusion();
      }
      this.emit();
    });
  }

  /** The diffusion model left Core (a delete, a load of another): what is resident is no longer known. */
  diffusionGone(): void {
    this.resident = null;
  }

  /**
   * A chat turn that needs the local model is about to go out. Unloads an
   * idle diffusion model that is in the way, or brings the yielded chat model
   * back now; answers a hold while a local generation still runs.
   */
  chatTurn(): Promise<HeldTurn | null> {
    return this.serial(async () => {
      let hold = false;
      for (const a of decideGpuShare("chat-turn", this.snapshot())) {
        if (a.do === "hold-turn") hold = true;
        if (a.do === "unload-diffusion") await this.unloadDiffusion();
        if (a.do === "resume-chat") await this.resumeNow();
      }
      if (!hold) return null;
      let release!: () => void;
      const wait = new Promise<void>((res) => { release = res; });
      const waiter = () => release();
      this.waiters.add(waiter);
      this.emit();
      return {
        wait,
        drop: () => {
          if (this.waiters.delete(waiter)) { release(); this.emit(); }
        },
      };
    });
  }

  dispose(): void {
    this.clearResumeTimer();
  }

  /* ----------------------------------------------------------- inside */

  private chatState(): GpuShareState["chat"] {
    if (this.yielded) return "yielded";
    return this.deps.chat().wanted ? "on" : "off";
  }

  private budget(): number | null {
    return this.deps.profile()?.budgetBytes ?? null;
  }

  private snapshot(): GpuSnapshot {
    const c = this.deps.chat();
    return {
      budgetBytes: this.budget(),
      chatBytes: chatResidentBytes(c.fileBytes),
      diffusionBytes: this.job ? this.jobBytes : this.resident?.bytes ?? null,
      oneModelPerGpu: c.oneModelPerGpu,
      chat: this.yielded ? "yielded" : c.wanted ? "on" : "off",
      diffusion: this.job ? "busy" : this.resident ? "idle" : "none",
      waitingTurns: this.waiters.size,
    };
  }

  private scheduleResume(): void {
    this.clearResumeTimer();
    const timer = setTimeout(() => {
      if (this.resumeTimer !== timer) return;
      this.resumeTimer = null;
      void this.serial(async () => {
        for (const a of decideGpuShare("chat-resume", this.snapshot())) {
          if (a.do === "unload-diffusion") await this.unloadDiffusion();
          if (a.do === "resume-chat") await this.resumeNow();
        }
        this.emit();
      });
    }, this.deps.resumeDelayMs ?? RESUME_DELAY_MS);
    timer.unref?.();
    this.resumeTimer = timer;
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  /** The chat model back, the diffusion model unloaded first when they do not fit, and the held turns let go. */
  private async resumeNow(): Promise<void> {
    this.clearResumeTimer();
    if (!this.yielded || this.job) return;
    const s = this.snapshot();
    if (s.diffusion === "idle" && !canCoexist(s)) await this.unloadDiffusion();
    const token = this.token;
    this.yielded = false;
    this.token = null;
    try {
      this.deps.resumeChat(token);
    } catch (err) {
      this.deps.say?.(`[desktop] studio: the local chat model could not be started again: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  private async unloadDiffusion(): Promise<void> {
    if (!this.resident) return;
    this.resident = null;
    try {
      await this.diffusion?.unload();
    } catch (err) {
      this.deps.say?.(`[desktop] studio: could not unload the image model to make room for chat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private emit(): void {
    try {
      this.listener(this.state());
    } catch { /* a listener never fails the share */ }
  }
}

/** The composer's line while a chat turn waits for a local generation. */
export function waitLine(kind: "image" | "video"): string {
  return `Waiting for Studio to finish the ${kind}, then the chat model loads again`;
}

/** What a local generate answers while another one runs. */
export function queuedLine(kind: "image" | "video"): string {
  return `Queued after the current ${kind}`;
}

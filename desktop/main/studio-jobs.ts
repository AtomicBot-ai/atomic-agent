/**
 * Studio: follows the generations the window started and pushes every
 * change to it, so the window never polls.
 *
 * Two sources, both on Core's control API (atomic-chat-core v0.18.6):
 *   - the event stream `GET /atomic/v1/events`: `diffusion:progress`,
 *     `diffusion:job`, `diffusion:video-progress`, `diffusion:video-job`
 *     (src/diffusion/session.ts `CoreEvents`; payloads in
 *     src/contracts/diffusion.ts). Fine-grained, but best effort;
 *   - a poll of each followed job, `GET /diffusion/jobs/:id` or
 *     `/diffusion/video/jobs/:id`, every 2 s while any is running. It
 *     catches the end of a job whose event was missed, and Core restarts.
 *
 * Every change goes out as one `StudioJob` through `emit`. A job Core no
 * longer knows (it keeps its last 50 in memory) is reported failed with
 * `JOB_NOT_FOUND` after three empty answers in a row.
 */

import type { StudioKind } from "./studio-catalog.js";
import type { CoreEventFrame, StudioCoreClient } from "./studio-core-client.js";
import { normalizeJob, withProgress, type StudioJob } from "./studio-requests.js";

const POLL_MS = 2_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function jobPath(kind: StudioKind, id: string): string {
  return `${kind === "video" ? "/diffusion/video/jobs/" : "/diffusion/jobs/"}${encodeURIComponent(id)}`;
}

/** Which job an event frame is about, and what it says. Null for any other event. */
export function jobFromFrame(frame: CoreEventFrame, last: (id: string) => StudioJob | undefined): StudioJob | null {
  const data = (frame.data && typeof frame.data === "object" ? frame.data : {}) as { job?: unknown; jobId?: unknown; progress?: unknown };
  switch (frame.event) {
    case "diffusion:job":
      return normalizeJob(data.job, "image");
    case "diffusion:video-job":
      return normalizeJob(data.job, "video");
    case "diffusion:progress":
    case "diffusion:video-progress": {
      const prev = typeof data.jobId === "string" ? last(data.jobId) : undefined;
      return prev ? withProgress(prev, data.progress) : null;
    }
    default:
      return null;
  }
}

export class StudioJobWatcher {
  private readonly jobs = new Map<string, { job: StudioJob; misses: number }>();
  private poller: NodeJS.Timeout | null = null;
  private stream: AbortController | null = null;
  private client: StudioCoreClient | null = null;

  constructor(
    private readonly emit: (job: StudioJob) => void,
    /** Called once nothing is followed any more (the owner may release its Core lease). */
    private readonly onIdle: () => void = () => {},
  ) {}

  /** The last state seen of a followed job. */
  get(id: string): StudioJob | undefined {
    return this.jobs.get(id)?.job;
  }

  /** Every generation still followed (for a window that reloaded mid-run). */
  list(): StudioJob[] {
    return [...this.jobs.values()].map((e) => e.job);
  }

  get size(): number {
    return this.jobs.size;
  }

  /** Follow `job` on `client` (a Core restart hands a new client in). */
  follow(client: StudioCoreClient, job: StudioJob): void {
    if (this.client !== client) {
      this.stream?.abort();
      this.stream = null;
      this.client = client;
    }
    this.update(job);
    if (TERMINAL.has(job.state)) return;
    this.openStream();
    this.poller ??= setInterval(() => void this.pollAll(), POLL_MS);
  }

  /** Stop following everything (app quit). */
  stop(): void {
    this.stream?.abort();
    this.stream = null;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.jobs.clear();
  }

  private update(job: StudioJob): void {
    const followed = this.jobs.has(job.id);
    this.emit(job);
    if (TERMINAL.has(job.state)) {
      if (followed) {
        this.jobs.delete(job.id);
        if (this.jobs.size === 0) this.idle();
      }
      return;
    }
    this.jobs.set(job.id, { job, misses: 0 });
  }

  private idle(): void {
    this.stream?.abort();
    this.stream = null;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.onIdle();
  }

  private openStream(): void {
    if (this.stream || !this.client) return;
    const controller = new AbortController();
    this.stream = controller;
    const client = this.client;
    void client
      .events((frame) => {
        const job = jobFromFrame(frame, (id) => this.get(id));
        // Only the generations this window follows: the agent's own image tool shares the table.
        if (job && this.jobs.has(job.id)) this.update(job);
      }, controller.signal)
      .catch(() => { /* the poll carries on */ })
      .finally(() => {
        if (this.stream === controller) this.stream = null;
      });
  }

  private async pollAll(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (!this.stream && this.jobs.size) this.openStream();
    for (const [id, entry] of [...this.jobs]) {
      let answer: { job?: unknown };
      try {
        answer = await client.call<{ job?: unknown }>(jobPath(entry.job.kind, id), undefined, { timeoutMs: 10_000 });
      } catch {
        continue; // Core unreachable for a moment: try again on the next tick.
      }
      const job = normalizeJob(answer.job, entry.job.kind);
      if (job) { this.update(job); continue; }
      const current = this.jobs.get(id);
      if (!current) continue;
      current.misses += 1;
      if (current.misses >= 3) {
        this.update({ ...current.job, state: "failed", error: { code: "JOB_NOT_FOUND", message: "Atomic Core lost track of this generation (it may have restarted)." } });
      }
    }
  }
}

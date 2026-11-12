import type { PersonaResolution } from "../config/agent/persona-resolve.js";

/** Same bound as the compact-prompt latch: one entry per live session. */
const MAX_TRACKED_SESSIONS = 256;

/**
 * Holds each session's persona from its first prompt on (ATO-54).
 *
 * The persona is stable-prefix bytes. Re-reading the config every step
 * would let `/persona use`, a project binding or a hand edit move the
 * prefix in the middle of a session and throw away the KV cache (and,
 * on a shared slot, corrupt the reuse the slot manager counts on). So a
 * session keeps what it started with, and a change applies to the next
 * session, which starts on a fresh prefix. A process restart resolves
 * again; a restart drops the local cache anyway.
 *
 * Owned by the agent loop (`StepDependencies.personaLatch`); no
 * module-level state.
 */
export class PersonaLatch {
  private readonly latched = new Map<string, PersonaResolution>();

  resolve(sessionId: string, decide: () => PersonaResolution): PersonaResolution {
    const held = this.latched.get(sessionId);
    if (held !== undefined) return held;
    const fresh = decide();
    this.latched.set(sessionId, fresh);
    if (this.latched.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.latched.keys().next().value;
      if (oldest !== undefined) this.latched.delete(oldest);
    }
    return fresh;
  }

  /** What `sessionId` runs under, if it has built a prompt yet. */
  peek(sessionId: string): PersonaResolution | undefined {
    return this.latched.get(sessionId);
  }
}

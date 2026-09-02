/**
 * Gate for every probe aimed at the managed/external llama-server text
 * backend (issue #112).
 *
 * A cloud-backed session used to open with `/health` + `/props` against
 * `http://127.0.0.1:8080`, warn that nothing answered, and then run the
 * whole session on a cloud provider that was healthy all along — the
 * warning reads as an active-backend failure on the one screen where the
 * operator has the least context to judge it.
 *
 * Boot skips those probes when the active text provider is not a
 * `llama-server` link. That leaves the local state cold, which is only
 * safe if it can be warmed again before local inference. Two paths reach
 * local inference after a cloud boot and both call {@link
 * LocalBackendGate.ensureProbed} first:
 *
 *  - the operator switching the active text provider to a llama-server
 *    link (the agent loop's turn-start refresh); and
 *  - the fallback chain falling over from a cloud link to a
 *    `llama-server` link mid-turn (`createFallbackCompleter` /
 *    `createFallbackStreamer` prepare each link before the attempt).
 */

export interface LocalBackendGate {
  /** Is the active text provider a `llama-server` link right now? */
  isActive(): boolean;
  /**
   * Run the probes boot skipped — `/health` logging, the `/props`
   * profile + slot refresh, and the context-window advice — exactly
   * once.
   *
   * Returns `true` only for the call that performed them, so a caller
   * whose next act would be its own `/props` refresh can skip it: one
   * just landed. `false` means boot already probed (a local-from-boot
   * run) or another caller got there first, and the caller owns its
   * usual refresh.
   */
  ensureProbed(): Promise<boolean>;
}

export interface LocalBackendGateDeps {
  /** Live predicate — re-read per call so a hot switch is observed. */
  isActive: () => boolean;
  /** The deferred boot probes, in boot order. Must not throw. */
  restore: () => Promise<void>;
}

/**
 * `LocalBackendGate` with a one-shot restore. Not reset when the
 * operator switches back to cloud: the state the restore rebuilds
 * (profile, grammar, slot pool) stays valid and the profile manager
 * keeps it fresh from then on, so re-arming would only buy a second
 * round of the same probes.
 */
export class DeferredLocalBackendProbes implements LocalBackendGate {
  private restored: boolean;
  private inFlight: Promise<void> | null = null;

  /**
   * @param probedAtBoot `true` when bootstrap already ran the probes
   * (the active provider was local at boot), which makes `ensureProbed`
   * a pure no-op for the life of the runtime.
   */
  constructor(
    private readonly deps: LocalBackendGateDeps,
    probedAtBoot: boolean,
  ) {
    this.restored = probedAtBoot;
  }

  isActive(): boolean {
    return this.deps.isActive();
  }

  async ensureProbed(): Promise<boolean> {
    if (this.restored) return false;
    // A concurrent caller (turn start racing a mid-turn fallover) waits
    // on the same restore but reports `false`: it did not produce the
    // fresh `/props` and must not claim the winner's right to skip.
    if (this.inFlight !== null) {
      await this.inFlight;
      return false;
    }
    this.inFlight = this.deps.restore();
    try {
      await this.inFlight;
    } finally {
      // Latched even on failure. `restore` swallows its own errors, but
      // a hard throw must not re-arm the probes on every step — the
      // profile manager's refresh already owns retrying `/props`, and a
      // dead backend fails the completion itself a moment later.
      this.restored = true;
      this.inFlight = null;
    }
    return true;
  }
}

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
 *
 * The second path is not a one-off: a rate-limited or down cloud primary
 * falls over on *every* turn, and `appendLocal` defaults to `true`, so
 * that is the shape of the default config under an outage. Restoring
 * once is not enough there — the operator can still swap the model
 * behind `llama-server` mid-outage, and the active provider stays cloud
 * the whole time, so the loop's own turn-start refresh never re-opens.
 * {@link LocalBackendGate.noteLinkServed} / {@link
 * LocalBackendGate.takeLinkServed} carry that fact from the seam to the
 * loop so the profile keeps tracking the live server for as long as the
 * local link keeps serving — and stops within one turn of it stopping.
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
  /**
   * Record that a `llama-server` link just served — or is about to serve
   * — an attempt while the *active* text provider is something else: a
   * cloud→local fallover.
   *
   * The agent loop's turn-start refresh keys off the active provider,
   * which stays cloud for the whole outage, so without this signal the
   * profile and grammar would stay pinned to whatever the first fallover
   * probed (issue #112 review, F1). Optional so legacy / test wiring that
   * implements only the two original members still type-checks.
   */
  noteLinkServed?(): void;
  /**
   * Take-and-clear the {@link noteLinkServed} flag: `true` when a local
   * link served since the last call. Read once per turn by the agent
   * loop, which then refreshes the profile even though the active
   * provider is cloud. Clearing is what keeps this self-limiting — once
   * the cloud primary recovers, exactly one more turn refreshes and then
   * the local probes go quiet again.
   */
  takeLinkServed?(): boolean;
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
  private linkServed = false;

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
    try {
      // Inside the `try` so a SYNCHRONOUS throw from `restore` latches
      // too. With the call outside it, the throw escaped before
      // `inFlight` was even assigned and `restored` stayed `false` — the
      // probes then re-armed on every single call, contradicting the
      // contract below. Bootstrap's `restore` is `async` with a
      // catch-all, so this was latent there, but the class is exported.
      this.inFlight = this.deps.restore();
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

  noteLinkServed(): void {
    this.linkServed = true;
  }

  takeLinkServed(): boolean {
    const served = this.linkServed;
    this.linkServed = false;
    return served;
  }
}

export interface LocalLinkPreparerDeps {
  gate: LocalBackendGate;
  /** Is `providerId` a `llama-server` link? Live, re-read per attempt. */
  isLocalLink: (providerId: string) => boolean;
  /**
   * `ModelProfileManager.refreshIfStale`, bound. A no-op unless a
   * completion reported a model the manager does not believe is loaded.
   */
  refreshIfStale: () => Promise<unknown>;
}

/**
 * The fallback seam's `prepareLink`, as bootstrap wires it. A named
 * function rather than an inline closure in `buildRuntime` so the three
 * decisions it makes are testable on their own — inline, the only way to
 * reach them was to boot a whole runtime and drive a real fallover.
 *
 * For a `llama-server` link, in order:
 *
 *  1. `noteLinkServed()` — tell the loop a local link is serving, so its
 *     turn-start refresh reopens for the duration of the outage even
 *     though the ACTIVE provider stays cloud.
 *  2. `ensureProbed()` — replay the probes boot deferred. `true` means
 *     they just ran and a fresh `/props` already landed; nothing more to
 *     do for this attempt.
 *  3. otherwise `refreshIfStale()` — on a cloud-active turn the loop's
 *     own between-steps refresh is gated off, which leaves this the only
 *     consumer of the staleness `observeCompletionModelId` flagged, and
 *     it sits closer to the request than the line it replaces.
 *
 * Every other link kind returns on the first line: one predicate call,
 * and no local request on a turn the local backend never serves.
 */
export function createLocalLinkPreparer(
  deps: LocalLinkPreparerDeps,
): (providerId: string) => Promise<void> {
  return async (providerId: string): Promise<void> => {
    if (!deps.isLocalLink(providerId)) return;
    deps.gate.noteLinkServed?.();
    if (await deps.gate.ensureProbed()) return;
    await deps.refreshIfStale();
  };
}

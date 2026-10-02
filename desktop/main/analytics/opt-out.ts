/**
 * The order of an `analytics.enabled` write (`cli:configSet` / `cli:configUnset`):
 *
 *   1. the config write itself;
 *   2. only if it succeeded and the switch is going off: `analytics_disabled`
 *      goes out and is flushed (bounded) while sending is still allowed;
 *   3. then the live switch follows what the files now say.
 *
 * A failed write changes nothing and announces nothing. Pure over its deps,
 * so the unit tests can check the order with fakes.
 */

export type DisabledVia = "settings" | "slash" | "config";

export interface SwitchWriteDeps {
  /** The live switch right now. */
  enabledNow(): boolean;
  /** What the config files say after the write. */
  enabledInFiles(): boolean;
  /** Queue `analytics_disabled`. */
  announceDisabled(via: DisabledVia): void;
  /** Bounded flush of what is queued. */
  flush(): Promise<void>;
  setEnabled(on: boolean): void;
}

export function disabledVia(via: unknown): DisabledVia {
  return via === "slash" || via === "config" ? via : "settings";
}

function succeeded(res: unknown): boolean {
  return !!res && typeof res === "object" && (res as { ok?: unknown }).ok === true;
}

export async function writeAnalyticsSwitch<T>(
  key: string,
  value: string | null,
  via: unknown,
  write: () => Promise<T>,
  deps: SwitchWriteDeps,
): Promise<T> {
  const res = await write();
  if (key !== "analytics.enabled" || !succeeded(res)) return res;
  try {
    const next = deps.enabledInFiles();
    if (!next && deps.enabledNow()) {
      deps.announceDisabled(disabledVia(via));
      await deps.flush();
    }
    deps.setEnabled(next);
  } catch {
    // Whatever went wrong, an opt-out that was written is honoured.
    if (value !== null && value.trim().toLowerCase() === "false") deps.setEnabled(false);
  }
  return res;
}

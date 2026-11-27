import { Text } from "ink";
import { useEffect, useState, type ReactElement } from "react";

import { getConfig } from "../../config/index.js";
import { logbookCapturing, readLogbookSettings, type LogbookSettings } from "../../logbook/logbook-settings.js";
import { theme } from "../theme/theme.js";

/**
 * The always-visible "logbook is on" mark in the top bar (ATO-2363):
 * while screenshots are being taken the person sees `● logbook`, and
 * `◌ logbook paused` during a pause. Re-read from
 * `<stateDir>/logbook/settings.json` every few seconds, so a
 * `logbook stop` from another terminal clears it. Nothing when off.
 */
export const LOGBOOK_CHIP_POLL_MS = 5_000;

export type LogbookChipState = "on" | "paused" | "off";

export function logbookChipState(settings: LogbookSettings, now: number): LogbookChipState {
  if (!settings.enabled) return "off";
  return logbookCapturing(settings, now) ? "on" : "paused";
}

/** The chip's text; `null` draws nothing. */
export function logbookChipLabel(state: LogbookChipState): string | null {
  if (state === "on") return "● logbook";
  if (state === "paused") return "◌ logbook paused";
  return null;
}

/**
 * Read the chip's state. The config getter runs inside the try: the chip
 * renders on every frame of the top bar, so a config with no paths (or a
 * broken settings file) must show nothing, never take the TUI down.
 */
export function readLogbookChipState(
  stateDir: string | undefined,
  configStateDir: () => string = () => getConfig().paths.stateDir,
): LogbookChipState {
  try {
    return logbookChipState(readLogbookSettings(stateDir ?? configStateDir()), Date.now());
  } catch {
    return "off";
  }
}

export function useLogbookChipState(stateDir?: string): LogbookChipState {
  const [state, setState] = useState<LogbookChipState>(() => readLogbookChipState(stateDir));
  useEffect(() => {
    const timer = setInterval(() => setState(readLogbookChipState(stateDir)), LOGBOOK_CHIP_POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [stateDir]);
  return state;
}

export function LogbookChip({ state }: { state: LogbookChipState }): ReactElement | null {
  const label = logbookChipLabel(state);
  if (label === null) return null;
  return (
    <Text color={state === "on" ? theme.colors.accent : theme.colors.muted}>
      {label}
      {"  "}
    </Text>
  );
}

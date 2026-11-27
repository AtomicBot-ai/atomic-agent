import { Text } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { theme } from "../theme/theme.js";
import type { PetState } from "./pet-machine.js";
import { PetTuiDriver, type PetTuiView } from "./pet-inputs.js";
import { PET_FRAME_MS, petAnimates, petChipText } from "./pet-sprite.js";

/**
 * ATO-2513: the terminal pet, a small ASCII face in the top bar that shows
 * what the agent is doing (the desktop pet's states, `pet-machine.ts`).
 * Mounted only while `tui.pet` is on (`/pet`); off by default. It reads
 * the TUI's state and keeps one machine for as long as it is on screen.
 * Display only: it answers nothing, approvals stay in the approval modal.
 */
export function usePetState(view: PetTuiView): PetState {
  const driver = useRef<PetTuiDriver | null>(null);
  const [shown, setShown] = useState<PetState>("idle");
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const now = Date.now();
    driver.current ??= new PetTuiDriver(now);
    const out = driver.current.update(view, now);
    setShown(out.state);
    if (out.nextAt === null) return undefined;
    const timer = setTimeout(() => setWake((n) => n + 1), Math.max(16, out.nextAt - now));
    timer.unref?.();
    return () => clearTimeout(timer);
    // `view` is a fresh object every render; these are the fields it reads.
  }, [view.status, view.pendingApproval, view.streamingToolCalls, view.streamingToolCards, view.runHistory, wake]);
  return shown;
}

/** The frame counter of an animated state; stays 0 (no timer) for a still one. */
export function usePetTick(state: PetState): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    if (!petAnimates(state)) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), PET_FRAME_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [state]);
  return tick;
}

export function petChipColor(state: PetState): string {
  if (state === "waiting") return theme.colors.warn;
  if (state === "error") return theme.colors.error;
  if (state === "done") return theme.colors.toolOk;
  if (state === "working" || state === "thinking") return theme.colors.accent;
  return theme.colors.muted;
}

export function PetChip({ view }: { view: PetTuiView }): ReactElement {
  const state = usePetState(view);
  const tick = usePetTick(state);
  return (
    <Text color={petChipColor(state)}>
      {petChipText(state, tick)}
      {"  "}
    </Text>
  );
}

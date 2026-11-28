import type { PetState } from "./pet-machine.js";

/**
 * ATO-2513: the terminal pet's look. Plain ASCII on purpose: it renders
 * the same on Windows conhost, a Linux console and every font, where box
 * drawing or emoji may not. Each state has a few frames the chip steps
 * through; every frame is padded to one width, so the bar beside it never
 * shifts while it moves.
 */
export const PET_FRAMES: Readonly<Record<PetState, readonly string[]>> = {
  // Still while nothing runs: a moving face at rest would redraw the whole
  // TUI twice a second for nothing.
  idle: ["(o.o)"],
  thinking: ["(o.o).", "(o.o)..", "(o.o)..."],
  working: ["(o.o)/", "(o.o)-", "(o.o)\\", "(o.o)|"],
  waiting: ["(O.O)!", "(O.O) "],
  error: ["(x.x)"],
  done: ["(^.^)", "(^o^)"],
  sleeping: ["(-.-)zZ"],
};

/** The word after the sprite, short enough for an 80-column bar. */
export const PET_WORDS: Readonly<Record<PetState, string>> = {
  waiting: "needs you",
  error: "failed",
  working: "using a tool",
  thinking: "thinking",
  done: "done",
  idle: "idle",
  sleeping: "resting",
};

export const PET_SPRITE_CELLS = Math.max(
  ...Object.values(PET_FRAMES).flatMap((frames) => frames.map((f) => f.length)),
);

/** How often the chip moves to its next frame. */
export const PET_FRAME_MS = 500;

/** True when the state has more than one frame, so the chip needs a timer. */
export function petAnimates(state: PetState): boolean {
  return PET_FRAMES[state].length > 1;
}

/** The sprite for `state` at frame `tick`, padded to {@link PET_SPRITE_CELLS}. */
export function petFrame(state: PetState, tick: number): string {
  const frames = PET_FRAMES[state];
  const i = ((Math.floor(tick) % frames.length) + frames.length) % frames.length;
  return (frames[i] ?? frames[0] ?? "").padEnd(PET_SPRITE_CELLS, " ");
}

/** The chip's whole text: sprite, a space, the word. */
export function petChipText(state: PetState, tick: number): string {
  return `${petFrame(state, tick)} ${PET_WORDS[state]}`;
}

/** Cells the chip may take in the bar, the two-cell gap after it included. */
export const PET_CHIP_MAX_CELLS =
  PET_SPRITE_CELLS + 1 + Math.max(...Object.values(PET_WORDS).map((w) => w.length)) + 2;

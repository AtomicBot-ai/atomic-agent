import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * ATO-2499 "Show once": the two switches on the Record card, kept in the
 * app's own folder (`userData/show-once.json`, beside voice.json) so they
 * survive a restart.
 *
 *   tidy      (on)  one pass of the chat model over the draft before review
 *   snapshots (off) a picture of the window after each step, for the review
 *
 * Pictures are off until the person turns them on: they can show what is
 * on screen, and they need macOS Screen Recording for the app.
 */

export interface ShowOnceOptions {
  tidy: boolean;
  snapshots: boolean;
}

export const SHOW_ONCE_DEFAULT_OPTIONS: Readonly<ShowOnceOptions> = { tidy: true, snapshots: false };

export function showOnceOptionsFile(dir: string): string {
  return join(dir, "show-once.json");
}

/** The saved switches over the defaults; a missing or hand-broken file gives the defaults. */
export function parseShowOnceOptions(text: string | null): ShowOnceOptions {
  const out = { ...SHOW_ONCE_DEFAULT_OPTIONS };
  if (!text) return out;
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o && typeof o === "object") {
      if (typeof o.tidy === "boolean") out.tidy = o.tidy;
      if (typeof o.snapshots === "boolean") out.snapshots = o.snapshots;
    }
  } catch { /* defaults */ }
  return out;
}

export function readShowOnceOptions(dir: string): ShowOnceOptions {
  let text: string | null = null;
  try {
    text = readFileSync(showOnceOptionsFile(dir), "utf8");
  } catch { /* none yet */ }
  return parseShowOnceOptions(text);
}

export async function writeShowOnceOptions(dir: string, options: ShowOnceOptions): Promise<void> {
  const file = showOnceOptionsFile(dir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ tidy: options.tidy, snapshots: options.snapshots }, null, 2)}\n`, "utf8");
}

import { createInterface } from "node:readline/promises";

import { listLogbookDays, readLogbookDay } from "../logbook/index.js";

/**
 * The question before `atomic-agent logbook clear --all` (ATO-2770).
 * Deleting every note cannot be undone, so a person at a terminal is
 * asked first and a script must say `--yes`, as `gh repo delete --yes`
 * and `docker system prune` do. Without a terminal and without `--yes`
 * nothing is deleted: a cron job or a pipe cannot answer the question.
 */
export interface ClearConfirmEnv {
  stateDir: string;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  isTty: boolean;
  confirm: (prompt: string) => Promise<boolean>;
}

/** `null` when the delete may go ahead, else the exit code to return. */
export async function confirmClearAll(env: ClearConfirmEnv): Promise<number | null> {
  const days = listLogbookDays(env.stateDir);
  if (days.length === 0) return null;
  const notes = days.reduce((sum, day) => sum + readLogbookDay(env.stateDir, day).length, 0);
  if (!env.isTty) {
    env.writeErr(
      "clear --all deletes every logbook note and cannot be undone.\n" +
        "Nothing was deleted. To confirm without a question: atomic-agent logbook clear --all --yes\n",
    );
    return 1;
  }
  const what = `${notes} note${notes === 1 ? "" : "s"} (${days.length} day${days.length === 1 ? "" : "s"})`;
  if (await env.confirm(`Delete all ${what}? This cannot be undone. [y/N] `)) return null;
  env.write("Nothing deleted.\n");
  return 0;
}

export async function askYesNo(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

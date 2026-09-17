import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ConversationTurn } from "../../session/conversation-turn.js";

/**
 * The paths the USER named, parsed out of their own messages.
 *
 * A session's reads are confined to its working directory — but
 * "summarize ~/Desktop/report.pdf" has to keep working untouched, so
 * every absolute or `~`-prefixed path the user typed widens the scope:
 * a named file to that file, a named directory to that directory. Only
 * user turns count. A path the model wrote (a reply, a tool argument, a
 * worker's brief) never widens anything, or the scope would be the
 * model's to grow.
 *
 * Recomputed from the transcript on every step rather than stored, so
 * it grows as the conversation grows and there is no second copy to
 * drift. Pure text work: nothing here touches the disk.
 */

export interface UserNamedPathOptions {
  /** The home directory `~` expands to. Defaults to the OS one. */
  home?: string;
}

/** `"…"`, `'…'` or `` `…` ``: a quoted span is one path, spaces and all. */
const QUOTED = /"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g;
/** Brackets a path is wrapped in, and the punctuation a sentence glues on. */
const LEADING = /^[(\[{<]+/;
const TRAILING = /[.,;:!?)\]}>]+$/;
const DRIVE = /^[A-Za-z]:[\\/]/;

/** Whether a bare token is a path the user named, by its first characters. */
export function looksLikeNamedPath(token: string): boolean {
  if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
    return true;
  }
  if (DRIVE.test(token)) return true;
  // `/` alone is the whole disk and `//…` is the tail of a URL: neither
  // is a path the user named.
  return token.startsWith("/") && token.length > 1 && !token.startsWith("//");
}

function expandNamed(token: string, home: string): string {
  if (token === "~") return home;
  if (token.startsWith("~/") || token.startsWith("~\\")) {
    return resolve(home, token.slice(2));
  }
  // A drive path is left as written: `resolve` would rebase it onto the
  // current directory on POSIX, where it cannot mean anything anyway.
  return DRIVE.test(token) ? token : resolve(token);
}

/** The absolute paths named in one message, in order, deduplicated. */
export function pathsNamedIn(
  text: string,
  options: UserNamedPathOptions = {},
): string[] {
  const home = options.home ?? homedir();
  const found: string[] = [];
  const add = (raw: string): void => {
    const token = raw.replace(LEADING, "").replace(TRAILING, "");
    if (token.length === 0 || !looksLikeNamedPath(token)) return;
    const path = expandNamed(token, home);
    if (!found.includes(path)) found.push(path);
  };
  // Quoted spans first and whole, so "~/My Documents/report.pdf" keeps
  // its space; a quoted span that is not itself a path is scanned word
  // by word like the rest.
  const rest = text.replace(
    QUOTED,
    (_match, a?: string, b?: string, c?: string) => {
      const inner = (a ?? b ?? c ?? "").trim();
      if (looksLikeNamedPath(inner)) {
        add(inner);
        return " ";
      }
      return ` ${inner} `;
    },
  );
  for (const token of rest.split(/\s+/)) add(token);
  return found;
}

/**
 * Every path the user named across a session's transcript. Only `user`
 * turns are read; everything the model produced is skipped by design.
 */
export function userNamedPaths(
  turns: readonly ConversationTurn[],
  options: UserNamedPathOptions = {},
): string[] {
  const found: string[] = [];
  for (const turn of turns) {
    if (turn.kind !== "user") continue;
    for (const path of pathsNamedIn(turn.text, options)) {
      if (!found.includes(path)) found.push(path);
    }
  }
  return found;
}

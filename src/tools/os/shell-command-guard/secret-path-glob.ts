import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";

/**
 * Whether a glob below the home folder can reach a credential folder
 * (ATO-2126 review): `cat ~/.s?h/id_rsa` names no folder literally but
 * the shell expands it to `~/.ssh/id_rsa`.
 *
 * Read one path part at a time against each `SECRET_HOME_PATHS` entry.
 * `*`, `?`, `[...]` and `{a,b}` work as in the shell; a part that does
 * not start with a dot does not match a dot folder, the way `*` skips
 * hidden files. A glob that stops above the folder (`~/.c*` against
 * `.config/gcloud`) still reaches it: `tar` and `cp -r` read the tree.
 */

export interface SecretGlobMatch {
  /** The credential entry it reaches, lowercased (`.ssh`). */
  folder: string;
  /** What the glob names below that entry (`/id_rsa`), or `""`. */
  rest: string;
}

/** `rest` is the path below home, lowercased, starting with `/`. */
export function secretPathUnderGlob(rest: string): SecretGlobMatch | null {
  const parts = rest.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return null;
  for (const secret of SECRET_HOME_PATHS) {
    const names = secret.toLowerCase().split("/");
    const shared = Math.min(parts.length, names.length);
    let reaches = true;
    for (let i = 0; i < shared; i += 1) {
      if (!partMatches(parts[i]!, names[i]!)) {
        reaches = false;
        break;
      }
    }
    if (!reaches) continue;
    const below = parts.slice(names.length);
    return { folder: secret.toLowerCase(), rest: below.length > 0 ? `/${below.join("/")}` : "" };
  }
  return null;
}

function partMatches(pattern: string, name: string): boolean {
  if (name.startsWith(".") && !pattern.startsWith(".") && !pattern.startsWith("{")) return false;
  return globRegex(pattern).test(name);
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One path part as an anchored regex. An unreadable class matches anything. */
function globRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      out += ".*";
    } else if (char === "?") {
      out += ".";
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      const body = pattern.slice(i + 1, end).replace(/^[!^]/, "^").replace(/\\/g, "\\\\");
      out += `[${body}]`;
      i = end;
    } else if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        continue;
      }
      out += `(?:${pattern.slice(i + 1, end).split(",").map(escapeRegex).join("|")})`;
      i = end;
    } else {
      out += escapeRegex(char);
    }
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return /^/;
  }
}

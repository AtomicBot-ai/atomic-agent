/**
 * Where a shell command sends data (ATO-2116): a pure scan of the simple
 * commands a call would run (`commandSegments`, so `sudo`, `env`,
 * `bash -c`, `eval` and `find -exec` are already unwrapped) into
 * destinations `{kind, host, direction, label}`. The approval card shows
 * the outbound ones as `sends data to -> host`, the risk reviewer gets
 * them as a fact, and the gate asks the person before data goes to a
 * host nobody has said yes to (`egress-hold.ts`).
 *
 * The patterns are ported from Goose's egress inspector,
 * crates/goose/src/security/egress_inspector.rs (`extract_destinations`
 * and `detect_direction`), Copyright the Goose authors, Apache License
 * 2.0: https://github.com/aaif-goose/goose/blob/9a16d1c5a3c54fc08403f1834e9b4eeabff1bc7a/crates/goose/src/security/egress_inspector.rs#L49-L290
 * Goose only logs what it finds; here it reaches the card and the gate.
 *
 * A best reading, not a sandbox: a script file, a variable or an alias
 * can hide a destination. Where a command clearly sends but its address
 * cannot be read (`curl -d @.env "$URL"`), the destination is listed with
 * `host: null`, and the gate treats it as unknown.
 */
import { scanCurl, scanWget } from "./egress-scan-http.js";
import { scanGit, type GitRemoteResolver } from "./egress-scan-git.js";
import {
  scanBucket,
  scanContainer,
  scanCopy,
  scanInlineScript,
  scanPublish,
  scanSocat,
  scanSocket,
  scanSsh,
} from "./egress-scan-tools.js";

export type { GitRemoteResolver } from "./egress-scan-git.js";

export type EgressDirection = "outbound" | "inbound";

export type EgressKind =
  | "url"
  | "git_remote"
  | "scp"
  | "ssh"
  | "socket"
  | "docker_registry"
  | "s3_bucket"
  | "gcs_bucket"
  | "package_publish"
  | "script";

export interface EgressDestination {
  kind: EgressKind;
  /** Lower-case host, or `null` when the command builds it at run time or it cannot be read. */
  host: string | null;
  /** `outbound`: the command sends data there; `inbound`: it only fetches. */
  direction: EgressDirection;
  /** What a surface shows: the host, or a description when there is none (`git remote "origin"`). */
  label: string;
}

export interface EgressScanOptions {
  /** Reads a git remote's URL (`git-remote-url.ts`); absent: remotes are shown by name. */
  gitRemote?: GitRemoteResolver;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SOCKET_PROGRAMS = new Set(["nc", "ncat", "netcat", "telnet", "ftp", "sftp"]);
const SCRIPT_PROGRAMS = /^(?:python\d*(?:\.\d+)?|node|deno|bun|ruby|perl|php)$/;
const PUBLISH_PROGRAMS = new Set(["npm", "pnpm", "yarn", "cargo", "twine", "poetry", "gem"]);

/** `/usr/bin/curl`, `CURL.EXE` → `curl`. */
function programName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
  return base.toLowerCase().replace(/\.exe$/, "");
}

function scanSegment(words: readonly string[], options: EgressScanOptions): EgressDestination[] {
  let start = 0;
  let gitIndirect = false;
  while (start < words.length && ENV_ASSIGNMENT_RE.test(words[start]!)) {
    if (/^GIT_/.test(words[start]!)) gitIndirect = true;
    start += 1;
  }
  const head = words[start];
  if (head === undefined) return [];
  const program = programName(head);
  const args = words.slice(start + 1);
  if (program === "curl") return scanCurl(args);
  if (program === "wget") return scanWget(args);
  if (program === "git") return scanGit(args, options.gitRemote, gitIndirect);
  if (program === "scp" || program === "rsync") return scanCopy(program, args);
  if (program === "ssh") return scanSsh(args);
  if (SOCKET_PROGRAMS.has(program)) return scanSocket(program, args);
  if (program === "socat") return scanSocat(args);
  if (program === "docker" || program === "podman") return scanContainer(args);
  if (program === "aws" && args[0] === "s3") return scanBucket("s3", args.slice(2));
  if (program === "gsutil") return scanBucket("gs", args.slice(1));
  if (program === "gcloud" && args[0] === "storage") return scanBucket("gs", args.slice(2));
  if (PUBLISH_PROGRAMS.has(program)) return scanPublish(program, args);
  if (SCRIPT_PROGRAMS.test(program)) return scanInlineScript(program, args);
  return [];
}

/**
 * Every destination the commands in `segments` reach, outbound first,
 * one entry per (direction, host or label).
 */
export function scanEgress(
  segments: readonly (readonly string[])[],
  options: EgressScanOptions = {},
): EgressDestination[] {
  const seen = new Set<string>();
  const found: EgressDestination[] = [];
  for (const words of segments) {
    let scanned: EgressDestination[];
    try {
      scanned = scanSegment(words, options);
    } catch {
      // A scan must never fail the call it describes.
      continue;
    }
    for (const destination of scanned) {
      const key = `${destination.direction}\u0000${destination.host ?? `?${destination.label}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(destination);
    }
  }
  return [
    ...found.filter((d) => d.direction === "outbound"),
    ...found.filter((d) => d.direction === "inbound"),
  ];
}

/** The outbound destinations of `egress`. */
export function outboundDestinations(
  egress: readonly EgressDestination[] | undefined,
): EgressDestination[] {
  return (egress ?? []).filter((d) => d.direction === "outbound");
}

/** Most destinations a card line names before `+N more`. */
const EGRESS_LINE_MAX = 4;

/**
 * The card line for `egress`: `sends data to -> x.io, github.com`, or
 * `null` when nothing is sent out. Plain text; each surface escapes it.
 * Shared by the TUI, Telegram and Discord.
 */
export function formatEgressLine(
  egress: readonly EgressDestination[] | undefined,
): string | null {
  const labels = [...new Set(outboundDestinations(egress).map((d) => d.label))];
  if (labels.length === 0) return null;
  const shown = labels.slice(0, EGRESS_LINE_MAX).join(", ");
  const more = labels.length - EGRESS_LINE_MAX;
  return `sends data to -> ${shown}${more > 0 ? ` (+${more} more)` : ""}`;
}

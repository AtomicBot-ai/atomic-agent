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
 * Known programs only, and a best reading, not a sandbox: a program not
 * listed below (`openssl s_client`, `rclone`, a DNS lookup, a script
 * file, a `/dev/tcp` redirect), a variable or an alias can send data
 * without being seen here. Where a command clearly sends but its address
 * cannot be read (`curl -d @.env "$URL"`, a proxy flag, a curl config
 * file), the destination is listed with `host: null`, and the gate
 * treats it as unknown. The shell tool adds one for a script fed to a
 * shell (`shell-egress.ts`).
 */
import { scanCurl, scanWget } from "./egress-scan-http.js";
import { gitSubcommand, scanGit, type GitRemoteResolver } from "./egress-scan-git.js";
import {
  scanBucket,
  scanContainer,
  scanCopy,
  scanInlineScript,
  scanPublish,
  type PublishRegistryResolver,
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
  /**
   * Set by the gate on a request it holds (`ApprovalGate.request`): no
   * one approved this host, so the card lists it first and never folds it.
   */
  unapproved?: true;
}

export interface EgressScanOptions {
  /** Reads a git remote's URL (`git-remote-url.ts`); absent: remotes are shown by name. */
  gitRemote?: GitRemoteResolver;
  /**
   * The call writes into a `.git` folder or a git config file
   * (`shell-egress.ts`), so no remote is resolved: the push may go to
   * the address the call itself just wrote.
   */
  gitStateWritten?: boolean;
  /**
   * The call writes a curl or wget config file (`.curlrc`, `.wgetrc`),
   * which can set a proxy: a send is then to an unknown address.
   */
  httpConfigWritten?: boolean;
  /** Reads the registry a publish goes to from the project's config (`publish-registry.ts`). */
  publishRegistry?: PublishRegistryResolver;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SOCKET_PROGRAMS = new Set(["nc", "ncat", "netcat", "telnet", "ftp", "sftp"]);
const SCRIPT_PROGRAMS = /^(?:python\d*(?:\.\d+)?|node|deno|bun|ruby|perl|php)$/;
const PUBLISH_PROGRAMS = new Set(["npm", "pnpm", "yarn", "cargo", "twine", "poetry", "gem"]);
/** Commands that change the folder later git commands run in. */
const DIR_CHANGERS = new Set(["cd", "pushd", "popd", "source", "."]);
/** git subcommands that can change where a later push goes. */
const GIT_STATE_SUBCOMMANDS = new Set(["remote", "config", "init", "clone", "checkout", "switch"]);
/** Builtins that set or drop a variable for the rest of the call. */
const VARIABLE_SETTERS = new Set(["export", "declare", "typeset", "readonly", "local", "unset"]);
/** Commands that run another command and may set variables for it (`env A=1 curl`, `sudo A=1 git`). */
const WRAPPERS = new Set([
  "env", "sudo", "doas", "nice", "nohup", "time", "timeout", "gtimeout", "stdbuf",
  "ionice", "setsid", "chrt", "taskset", "command", "exec", "builtin", "xargs", "flock",
]);
/** Variables that send curl or wget through another host or another config file. */
const PROXY_VARIABLE_RE =
  /^(?:(?:https?|ftp|all|socks)_proxy|curl_home|wgetrc|system_wgetrc|home|xdg_config_home)$/i;
/** Variables that change which repository or git config a push reads. */
const GIT_VARIABLE_RE = /^(?:GIT_[A-Za-z0-9_]*|HOME|XDG_CONFIG_HOME)$/;

/** `/usr/bin/curl`, `CURL.EXE` → `curl`. */
function programName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** The variable a word assigns or names (`GIT_DIR=x`, `GIT_DIR`), or `""`. */
function variableName(word: string): string {
  return /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(word)?.[1] ?? "";
}

/** What the parts of one call do that changes how another part is read. */
interface CallState {
  /** A part changes the folder, a git remote or a `GIT_*` variable: resolve no remote. */
  gitUnsafe: boolean;
  /** A part sets a proxy variable or a curl / wget config location. */
  rerouted: boolean;
}

/**
 * Reads the whole call first. A `git push` remote is read from the
 * repository config before anything runs, so any part of the same call
 * that can change it (`git remote set-url`, `git config`, `cd`, a
 * `GIT_*` variable) leaves every remote unresolved. Stricter than
 * "earlier parts only": a loop can run a later part first.
 */
function readCallState(segments: readonly (readonly string[])[]): CallState {
  const state: CallState = { gitUnsafe: false, rerouted: false };
  for (const words of segments) {
    let start = 0;
    const names: string[] = [];
    while (start < words.length && ENV_ASSIGNMENT_RE.test(words[start]!)) {
      names.push(variableName(words[start]!));
      start += 1;
    }
    const head = words[start];
    const program = head === undefined ? "" : programName(head);
    // `A=1` alone, `export A=1`, or `A=1 git push` (the same command
    // also appears unwrapped, without its assignment).
    const setter = head === undefined || VARIABLE_SETTERS.has(program);
    if (setter) for (const word of words.slice(start + 1)) names.push(variableName(word));
    // `env A=1 curl`, `sudo A=1 git push`: the unwrapped copy has lost
    // the assignment, so take every assignment word after a wrapper.
    if (WRAPPERS.has(program)) {
      for (const word of words.slice(start + 1)) {
        if (ENV_ASSIGNMENT_RE.test(word)) names.push(variableName(word));
      }
    }
    if (names.some((name) => GIT_VARIABLE_RE.test(name))) state.gitUnsafe = true;
    if (names.some((name) => PROXY_VARIABLE_RE.test(name))) state.rerouted = true;
    if (setter) continue;
    if (DIR_CHANGERS.has(program)) state.gitUnsafe = true;
    // A sourced file can export a proxy.
    if (program === "source" || program === ".") state.rerouted = true;
    if (program === "git") {
      const sub = gitSubcommand(words.slice(start + 1));
      if (sub !== undefined && GIT_STATE_SUBCOMMANDS.has(sub)) state.gitUnsafe = true;
    }
  }
  return state;
}

function scanSegment(
  words: readonly string[],
  options: EgressScanOptions,
  call: CallState,
): EgressDestination[] {
  let start = 0;
  let gitIndirect = false;
  let rerouted = call.rerouted || options.httpConfigWritten === true;
  while (start < words.length && ENV_ASSIGNMENT_RE.test(words[start]!)) {
    const name = variableName(words[start]!);
    if (GIT_VARIABLE_RE.test(name)) gitIndirect = true;
    if (PROXY_VARIABLE_RE.test(name)) rerouted = true;
    start += 1;
  }
  const head = words[start];
  if (head === undefined) return [];
  const program = programName(head);
  const args = words.slice(start + 1);
  if (program === "curl") return scanCurl(args, { rerouted });
  if (program === "wget") return scanWget(args, { rerouted });
  if (program === "git") {
    const unsafe = call.gitUnsafe || options.gitStateWritten === true;
    return scanGit(args, unsafe ? undefined : options.gitRemote, gitIndirect);
  }
  if (program === "scp" || program === "rsync") return scanCopy(program, args);
  if (program === "ssh") return scanSsh(args);
  if (SOCKET_PROGRAMS.has(program)) return scanSocket(program, args);
  if (program === "socat") return scanSocat(args);
  if (program === "docker" || program === "podman") return scanContainer(args);
  if (program === "aws" && args[0] === "s3") return scanBucket("s3", args.slice(2));
  if (program === "gsutil") return scanBucket("gs", args.slice(1));
  if (program === "gcloud" && args[0] === "storage") return scanBucket("gs", args.slice(2));
  if (PUBLISH_PROGRAMS.has(program)) {
    // After a `cd` (or another change of folder) the project config read
    // from `cwd` is not the one the publish uses: unknown, not the public
    // default (review round 1 of ATO-2528).
    const registry =
      call.gitUnsafe && options.publishRegistry !== undefined ? () => null : options.publishRegistry;
    return scanPublish(program, args, registry);
  }
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
  const call = readCallState(segments);
  for (const words of segments) {
    let scanned: EgressDestination[];
    try {
      scanned = scanSegment(words, options, call);
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

/**
 * What a script fed to a shell or interpreter (`printf … | sh`,
 * `ApprovalRequest.commandUnreadable`) stands for: it cannot be read, so
 * it counts as data going to a host nobody knows.
 */
export const UNREADABLE_SCRIPT_EGRESS: Readonly<EgressDestination> = {
  kind: "script",
  host: null,
  direction: "outbound",
  label: "a script fed to a shell or interpreter (cannot be read)",
};

/** `egress` with the unreadable-script destination first when `unreadable`, once. */
export function withUnreadableScript(
  egress: readonly EgressDestination[] | undefined,
  unreadable: boolean,
): EgressDestination[] {
  const list = [...(egress ?? [])];
  if (!unreadable) return list;
  const present = list.some(
    (d) => d.kind === "script" && d.host === null && d.label === UNREADABLE_SCRIPT_EGRESS.label,
  );
  return present ? list : [{ ...UNREADABLE_SCRIPT_EGRESS }, ...list];
}

/** The outbound destinations of `egress`. */
export function outboundDestinations(
  egress: readonly EgressDestination[] | undefined,
): EgressDestination[] {
  return (egress ?? []).filter((d) => d.direction === "outbound");
}

/** Most known destinations a card line names before `+N more`. */
const EGRESS_LINE_MAX = 4;

/** A label as one line of plain text: control characters (a newline) become a space. */
export function cleanEgressLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  return label.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, " ").trim();
}

/** No one approved it: an unreadable host, or one the gate marked held. */
function isUnknown(destination: EgressDestination): boolean {
  return destination.host === null || destination.unapproved === true;
}

/**
 * The card line for `egress`: `sends data to -> x.io, github.com`, or
 * `null` when nothing is sent out. Unknown destinations come first and
 * are always all named; only known ones fold into `+N more`. Plain text
 * on one line; each surface escapes it. Shared by the TUI, Telegram and
 * Discord.
 */
export function formatEgressLine(
  egress: readonly EgressDestination[] | undefined,
): string | null {
  const outbound = outboundDestinations(egress);
  const unknown = [...new Set(outbound.filter(isUnknown).map((d) => cleanEgressLabel(d.label)))];
  const known = [
    ...new Set(outbound.filter((d) => !isUnknown(d)).map((d) => cleanEgressLabel(d.label))),
  ].filter((label) => !unknown.includes(label));
  if (unknown.length === 0 && known.length === 0) return null;
  const room = Math.max(EGRESS_LINE_MAX - unknown.length, 0);
  const shown = [...unknown, ...known.slice(0, room)].join(", ");
  const more = known.length - room;
  return `sends data to -> ${shown}${more > 0 ? ` (+${more} more)` : ""}`;
}

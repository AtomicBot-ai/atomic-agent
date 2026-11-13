/**
 * ATO-556: `atomicagent://` links. A button on a website ("Add to Atomic
 * Agent") opens the app with a link; the app shows what the link asks for
 * and does nothing until the person clicks Install in that card.
 *
 *   atomicagent://mcp/install?name=files&command=npx&arg=-y&arg=@scope/server-files@1.2.0&env=ROOT=/tmp
 *   atomicagent://mcp/install?name=docs&url=https://example.com/mcp
 *   atomicagent://skill/install?slug=@owner/skill-name
 *
 * This file is pure (no electron import, so the Node checks load it):
 *
 *   parseDeeplink           strict scheme / host / path / params, size limits
 *   registerDeeplinkRoute   one route per host ("mcp", "skill", and "recipe"
 *                           from ATO-1071 adds itself with one line)
 *   routeDeeplink           a raw link to the request the window draws, or an error
 *   checkMcpCommand         the stdio command allowlist and its argument rules
 *   shouldRegisterProtocol  never in a test, smoke, dev or unpackaged run, and
 *                           never on another state directory: those must not
 *                           take the person's real handler
 *   wireDeeplinks           the OS side (open-url on macOS, argv on Windows /
 *                           Linux, second-instance), with `app` handed in
 *
 * The routes only describe. The install itself runs through the paths the
 * Settings panes already use (the MCP add write, `atag skill install` with its
 * security scan), from the renderer, on the click.
 */

import { CLAWHUB_OWNER_RE, CLAWHUB_SLUG_RE } from "./clawhub.js";

export const DEEPLINK_SCHEME = "atomicagent";
/** A whole link. Browsers and OS handlers pass far less in practice. */
export const DEEPLINK_MAX_LENGTH = 8192;
export const DEEPLINK_MAX_PARAMS = 64;
export const DEEPLINK_MAX_VALUE = 2048;

const HOST_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SEGMENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface ParsedDeeplink {
  /** `mcp` in atomicagent://mcp/install. */
  host: string;
  /** `["install"]` in atomicagent://mcp/install. */
  path: string[];
  /** Every value of every key, in order (a key may repeat: `arg=-y&arg=pkg`). */
  params: Map<string, string[]>;
  /** The link as received, for the card's "Link" line. */
  raw: string;
}

export type ParseResult = { ok: true; link: ParsedDeeplink } | { ok: false; error: string };

/** A raw string into a checked link. Anything off-shape is an error, never a guess. */
export function parseDeeplink(raw: unknown): ParseResult {
  if (typeof raw !== "string") return { ok: false, error: "The link is not text." };
  const text = raw.trim();
  if (!text) return { ok: false, error: "The link is empty." };
  if (text.length > DEEPLINK_MAX_LENGTH) return { ok: false, error: `The link is too long (over ${DEEPLINK_MAX_LENGTH} characters).` };
  if (!text.toLowerCase().startsWith(`${DEEPLINK_SCHEME}://`)) return { ok: false, error: `Not an ${DEEPLINK_SCHEME}:// link.` };
  if (CONTROL_RE.test(text)) return { ok: false, error: "The link holds control characters." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "The link is not a valid address." };
  }
  if (url.protocol !== `${DEEPLINK_SCHEME}:`) return { ok: false, error: `Not an ${DEEPLINK_SCHEME}:// link.` };
  if (url.username || url.password || url.port) return { ok: false, error: "The link carries a user, password or port, which no Atomic Agent link has." };
  if (url.hash && url.hash !== "#") return { ok: false, error: "The link carries a #fragment, which no Atomic Agent link has." };
  const host = url.hostname.toLowerCase();
  if (!HOST_RE.test(host)) return { ok: false, error: "The link names no known action." };
  // `atomicagent://mcp/install/` (a trailing slash some handlers add) reads as `install`.
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length > 4) return { ok: false, error: "The link's path is too deep." };
  const path: string[] = [];
  for (const s of segments) {
    const seg = s.toLowerCase();
    if (!SEGMENT_RE.test(seg)) return { ok: false, error: "The link's path holds characters no Atomic Agent link uses." };
    path.push(seg);
  }
  const params = new Map<string, string[]>();
  let count = 0;
  // forEach, not for…of: the build's lib has DOM without DOM.Iterable.
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => { pairs.push([key, value]); });
  for (const [key, value] of pairs) {
    count += 1;
    if (count > DEEPLINK_MAX_PARAMS) return { ok: false, error: `The link has more than ${DEEPLINK_MAX_PARAMS} parameters.` };
    if (!KEY_RE.test(key)) return { ok: false, error: `The link has a parameter with an odd name (${JSON.stringify(key.slice(0, 40))}).` };
    if (value.length > DEEPLINK_MAX_VALUE) return { ok: false, error: `The parameter "${key}" is too long.` };
    if (CONTROL_RE.test(value)) return { ok: false, error: `The parameter "${key}" holds control characters.` };
    const list = params.get(key);
    if (list) list.push(value);
    else params.set(key, [value]);
  }
  return { ok: true, link: { host, path, params, raw: text } };
}

/* ---------------- routes ---------------- */

/** What the window draws: `route` names the card; the rest is that card's data. */
export interface DeeplinkRequest {
  route: string;
  /** The link as received, cut for display. */
  link: string;
  [key: string]: unknown;
}

export type RouteResult = { ok: true; request: DeeplinkRequest } | { ok: false; error: string };
export type DeeplinkRoute = (link: ParsedDeeplink) => RouteResult;

const ROUTES = new Map<string, DeeplinkRoute>();

/** One handler per host (`mcp`, `skill`, `recipe`, …). A second registration replaces the first. */
export function registerDeeplinkRoute(host: string, handler: DeeplinkRoute): void {
  if (!HOST_RE.test(host)) throw new Error(`not a deeplink host: ${host}`);
  ROUTES.set(host, handler);
}

/** The hosts with a route, for the error that names them. */
export function deeplinkHosts(): string[] {
  return [...ROUTES.keys()].sort();
}

/** The link as the card shows it: one line, at most 300 characters. */
export function displayLink(raw: string): string {
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length > 300 ? `${one.slice(0, 299)}…` : one;
}

export function routeDeeplink(raw: unknown): RouteResult {
  const parsed = parseDeeplink(raw);
  if (!parsed.ok) return parsed;
  const route = ROUTES.get(parsed.link.host);
  if (!route) return { ok: false, error: `Atomic Agent does not know the "${parsed.link.host}" link.` };
  try {
    return route(parsed.link);
  } catch (err) {
    return { ok: false, error: `The link could not be read (${err instanceof Error ? err.message : String(err)}).` };
  }
}

type ParamSpec = Record<string, { max: number; required?: boolean }>;

/**
 * The link's params against what a route takes: unknown keys and keys given
 * more often than allowed are errors. Answers each key's values ([] when absent).
 */
export function takeParams(link: ParsedDeeplink, spec: ParamSpec): { ok: true; values: Record<string, string[]> } | { ok: false; error: string } {
  for (const key of link.params.keys()) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) return { ok: false, error: `The link has a parameter Atomic Agent does not take here ("${key}").` };
  }
  const values: Record<string, string[]> = {};
  for (const [key, rule] of Object.entries(spec)) {
    const list = link.params.get(key) ?? [];
    if (list.length > rule.max) return { ok: false, error: rule.max === 1 ? `The parameter "${key}" is given more than once.` : `The parameter "${key}" is given more than ${rule.max} times.` };
    if (rule.required && (list.length === 0 || list.every((v) => v.trim() === ""))) return { ok: false, error: `The link has no "${key}".` };
    values[key] = list;
  }
  return { ok: true, values };
}

/* ---------------- mcp/install ---------------- */

/** The same rule as the agent's MCP_SERVER_NAME_RE (src/mcp/mcp-types.ts). */
export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The programs a link may start. Each one fetches and runs a published
 * package or image; nothing else (no shells, no paths, no interpreters with
 * `-e`). Bare names only: on Windows the agent runs a bare name through
 * `cmd.exe /c` for PATHEXT (src/mcp/mcp-client.ts resolveStdioCommand),
 * which is also why the argument rules below refuse cmd's special characters.
 */
export const MCP_COMMAND_ALLOWLIST: readonly string[] = ["npx", "uvx", "bunx", "docker"];
export const MCP_MAX_ARGS = 32;
export const MCP_MAX_ENV = 16;
const ARG_MAX = 1024;
/* cmd.exe's own characters (the Windows route above) and quotes. */
const ARG_FORBIDDEN_RE = /[&|<>^"%`\r\n\u0000]/;

/**
 * Flags a link may put before the package (review F08-9). An allowlist: npx and
 * bunx take `-c`, `--call`, `--registry`, `--userconfig`… in many spellings
 * (`-yc`, `--regi=` as an abbreviation), so anything not named here is refused.
 * Everything after the package goes to the package itself, not to the runner.
 * Flags with a `value` take the next argument (or `=value`): "from" names the
 * package the command comes from (npx -p, uvx --from), "with" an extra package
 * (uvx --with), "python" a Python version.
 */
const RUNNER_FLAGS: Record<"npx" | "bunx" | "uvx", Readonly<Record<string, { value?: "from" | "with" | "python" }>>> = {
  npx: { "-y": {}, "--yes": {}, "-p": { value: "from" }, "--package": { value: "from" } },
  bunx: { "-y": {}, "--yes": {}, "-p": { value: "from" }, "--package": { value: "from" } },
  // uvx: --index/--index-url/--extra-index-url/--default-index/--find-links/-i/-f (another
  // registry), --with-requirements/--with-editable/--config-file (files on this computer)
  // and every other flag are refused by not being here.
  uvx: { "--from": { value: "from" }, "--with": { value: "with" }, "--python": { value: "python" }, "-q": {}, "--quiet": {} },
};

/** docker run flags a link may never pass: they hand the container the host's powers. */
const DOCKER_BLOCKED_FLAGS: readonly string[] = ["--privileged", "--pid", "--ipc", "--uts", "--userns", "--cgroupns", "--cap-add", "--security-opt", "--device",
  // Inherits another container's mounts, which can be the host root or the socket (review follow-up to F08-8).
  "--volumes-from"];

/** Environment names a link may not set: they change what runs, or where packages come from. */
const BLOCKED_ENV = new Set([
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP", "SHELL",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONINSPECT",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "BASH_ENV", "ENV", "SHELLOPTS", "PS4", "PROMPT_COMMAND",
  "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
  "BUN_CONFIG_REGISTRY", "BUN_INSTALL", "UV_DEFAULT_INDEX", "UV_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
]);
const BLOCKED_ENV_PREFIXES = ["DYLD_", "NPM_CONFIG_", "PIP_", "YARN_", "PNPM_"];

export function envNameBlocked(name: string): boolean {
  const up = name.toUpperCase();
  return BLOCKED_ENV.has(up) || BLOCKED_ENV_PREFIXES.some((p) => up.startsWith(p));
}

/* docker run flags that take the next argument as their value. */
const DOCKER_VALUE_FLAGS = new Set(["-v", "--volume", "--mount", "-e", "--env", "--env-file", "--name", "-p", "--publish", "--network", "--net",
  "-w", "--workdir", "-u", "--user", "--entrypoint", "-l", "--label", "--platform", "-m", "--memory", "--cpus", "--add-host", "--tmpfs", "--volumes-from"]);

/** The image of `docker run …`: the first argument that is neither a flag nor a flag's value. */
export function dockerImage(args: readonly string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (!a.includes("=") && DOCKER_VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    return a;
  }
  return null;
}

/** A package given as a file or folder on this computer (`./x`, `~/Downloads/x`, `file:`, `C:\\x`), not a published one. */
export function localPackageSpec(spec: string): boolean {
  return /^(?:\.|\/|~|\\|file:)/i.test(spec) || /^[A-Za-z]:[\\/]/.test(spec);
}

function unpinnedNpm(spec: string): boolean {
  // `@scope/pkg@1.2.3`, `pkg@1.2.3`: a version after the name's own @.
  const at = spec.lastIndexOf("@");
  return at <= 0;
}

/**
 * The runner's own flags, before the package: only those in RUNNER_FLAGS, each
 * spelled whole (`-y`, `--package=x`, `--package x`). Combined short flags
 * (`-yc`), abbreviations (`--regi=`) and `--` are refused.
 */
export function runnerLead(cmd: "npx" | "bunx" | "uvx", list: readonly string[]): { ok: true; from: string[]; with: string[]; next: number } | { ok: false; error: string } {
  const allowed = RUNNER_FLAGS[cmd];
  const from: string[] = [];
  const extra: string[] = [];
  let i = 0;
  for (; i < list.length; i++) {
    const a = list[i]!;
    if (!a.startsWith("-")) break;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const spec = allowed[name];
    const only = Object.keys(allowed).join(", ");
    if (!spec) return { ok: false, error: `A link may not pass ${name.slice(0, 40)} to ${cmd} (only ${only}).` };
    if (!spec.value) {
      if (eq > 0) return { ok: false, error: `${name} takes no value.` };
      continue;
    }
    const value = eq > 0 ? a.slice(eq + 1) : list[++i];
    if (!value || value.startsWith("-")) return { ok: false, error: `${name} needs a value.` };
    if (spec.value === "python") {
      if (!/^(?:(?:cpython|pypy)-?)?\d+(?:\.\d+){0,2}$/i.test(value)) return { ok: false, error: "--python takes a version number." };
    } else (spec.value === "from" ? from : extra).push(value);
  }
  return { ok: true, from, with: extra, next: i };
}

/* docker's one-letter flags that take a value (`-v x`, `-vx`, `-v=x`, `-itv x`). */
const DOCKER_SHORT_VALUE = new Set([...DOCKER_VALUE_FLAGS].filter((f) => /^-[a-z]$/i.test(f)).map((f) => f[1]!));

/**
 * Every flag in docker run's arguments as {name, value}: `--flag=value`,
 * `--flag value`, attached short values (`-v/:/host`, `-v=/:/host`) and
 * combined short flags (`-itv /:/host`) all read the same.
 */
export function dockerFlags(args: readonly string[]): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-" || a === "--") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      out.push({ name, value: eq > 0 ? a.slice(eq + 1) : DOCKER_VALUE_FLAGS.has(name) ? args[i + 1] ?? "" : "" });
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (!DOCKER_SHORT_VALUE.has(c)) { out.push({ name: "-" + c, value: "" }); continue; }
      let rest = a.slice(j + 1);
      if (rest.startsWith("=")) rest = rest.slice(1);
      out.push({ name: "-" + c, value: rest || (args[i + 1] ?? "") });
      break;
    }
  }
  return out;
}

/** The host side of `-v src:dst[:opts]`; a Windows drive (`C:\\x:/data`) keeps its colon. */
export function volumeSource(value: string): string {
  const drive = /^[A-Za-z]:(?=[\\/]|$|:)/.exec(value);
  if (drive) return drive[0] + value.slice(2).split(":")[0];
  const src = value.split(":")[0] ?? "";
  // `-v /data` alone is an anonymous volume at /data in the container, not a host folder.
  return value.includes(":") ? src : "";
}

/** The host side of `--mount type=bind,source=…` (`src=` too). */
export function mountSource(value: string): string {
  for (const part of value.split(",")) {
    const m = /^\s*(?:source|src)\s*=(.*)$/i.exec(part);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

/**
 * A host path in one spelling: `\\` as `/`, `//`, `/./`, `..` and a trailing
 * `/` folded, a Windows drive as `c:` (`C:\\`, `C:/`, `/c/`, `/mnt/c`,
 * `/host_mnt/c` are all the drive's root).
 */
export function normaliseHostPath(raw: string): string {
  let s = raw.replace(/\\/g, "/");
  let drive = "";
  const d = /^([A-Za-z]):/.exec(s);
  if (d) { drive = d[1]!.toLowerCase() + ":"; s = s.slice(2); }
  if (!s.startsWith("/")) s = "/" + s;
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  if (!drive) {
    const wsl = /^(?:mnt|host_mnt|run\/desktop\/mnt\/host)$/i;
    if (parts.length === 1 && /^[A-Za-z]$/.test(parts[0]!)) return parts[0]!.toLowerCase() + ":";
    if (parts.length >= 2 && /^[A-Za-z]$/.test(parts[parts.length - 1]!) && wsl.test(parts.slice(0, -1).join("/"))) return parts[parts.length - 1]!.toLowerCase() + ":";
  }
  return drive + "/" + parts.join("/");
}

/**
 * A mount source a link may never use: the host's root (any drive's root on
 * Windows), the Docker socket or named pipe anywhere in the path, or a folder
 * that holds the socket (/var, /run, /var/run).
 */
export function dockerSourceRefused(src: string): boolean {
  if (!src) return false;
  if (/docker\.sock|docker_engine/i.test(src)) return true;
  // Not a path (`data`, `cache-1`): a named Docker volume, not a host folder.
  if (!/^(?:[\\/.~]|[A-Za-z]:)/.test(src)) return false;
  const p = normaliseHostPath(src);
  return p === "/" || /^[a-z]:(?:\/)?$/.test(p) || p === "/var" || p === "/run" || p === "/var/run";
}

/**
 * A stdio command from a link: allowed or not, and what the card warns about.
 * The allowlist and the argument rules are the only gate before the card;
 * the person's click is the only gate after it.
 */
export function checkMcpCommand(command: unknown, args: readonly unknown[]): { ok: true; warnings: string[] } | { ok: false; error: string } {
  if (typeof command !== "string" || !command.trim()) return { ok: false, error: "The link names no command." };
  const cmd = command.trim();
  if (!MCP_COMMAND_ALLOWLIST.includes(cmd)) {
    return { ok: false, error: `A link may only start ${MCP_COMMAND_ALLOWLIST.join(", ")}; this one asks for "${cmd.slice(0, 60)}". Add it by hand in Settings › MCP if you trust it.` };
  }
  if (args.length > MCP_MAX_ARGS) return { ok: false, error: `The command has more than ${MCP_MAX_ARGS} arguments.` };
  const list: string[] = [];
  for (const a of args) {
    if (typeof a !== "string") return { ok: false, error: "An argument is not text." };
    if (a.length > ARG_MAX) return { ok: false, error: "An argument is too long." };
    if (ARG_FORBIDDEN_RE.test(a)) return { ok: false, error: `The argument ${JSON.stringify(a.slice(0, 60))} holds a character a link may not pass (& | < > ^ " % \` or a line break).` };
    list.push(a);
  }
  const warnings: string[] = [];
  if (cmd === "npx" || cmd === "bunx" || cmd === "uvx") {
    const lead = runnerLead(cmd, list);
    if (!lead.ok) return lead;
    const target = list[lead.next];
    if (target === undefined) return { ok: false, error: `The link gives ${cmd} no package to run.` };
    // With -p/--package (or uvx --from) the first argument after the flags is a command name, and
    // npm exec hands that name to a shell: a bare program name only, so `-p x "echo hi; id"` cannot pass.
    if (lead.from.length && !/^[A-Za-z0-9@_][A-Za-z0-9@._+\/-]*$/.test(target)) {
      return { ok: false, error: `${JSON.stringify(target.slice(0, 60))} is not a program name ${cmd} can run.` };
    }
    const pkgs = [...(lead.from.length ? lead.from : [target]), ...lead.with];
    for (const pkg of pkgs) {
      if (localPackageSpec(pkg)) return { ok: false, error: "A link may only run a published package, not a file on this computer." };
      const pinned = cmd === "uvx" ? /[=@]/.test(pkg) : !unpinnedNpm(pkg);
      if (!pinned) warnings.push(`The package ${pkg} has no version, so whatever is newest is run each time.`);
    }
  } else if (cmd === "docker") {
    if (list[0] !== "run") return { ok: false, error: "A link may only use docker run." };
    // Every flag-shaped argument is checked, also after the image: an unknown value flag would
    // otherwise make the image guess wrong and hide a mount behind it.
    for (const f of dockerFlags(list.slice(1))) {
      if (DOCKER_BLOCKED_FLAGS.includes(f.name)) return { ok: false, error: `A link may not pass ${f.name} to docker.` };
      if ((f.name === "--network" || f.name === "--net") && f.value === "host") return { ok: false, error: "A link may not give the container the host's network." };
      if (f.name === "-v" || f.name === "--volume" || f.name === "--mount") {
        const src = f.name === "--mount" ? mountSource(f.value) : volumeSource(f.value);
        if (dockerSourceRefused(src)) return { ok: false, error: "A link may not mount the whole disk or the Docker socket into the container, not even read-only." };
        const rw = /(?:^|[:,])(?:ro|readonly)(?:$|[,=])/.test(f.value) ? "read" : "read and write";
        if (src && !/^(?:[\\/.~]|[A-Za-z]:)/.test(src)) warnings.push(`The container keeps its data in a Docker volume named ${src}.`);
        else if (src) warnings.push(`The container can ${rw} ${src} on this computer.`);
        else if (f.name !== "--mount") warnings.push("The container gets a folder of its own on this computer.");
      }
    }
    const image = dockerImage(list);
    if (!image) return { ok: false, error: "The link gives docker run no image." };
    const tag = image.slice(image.lastIndexOf("/") + 1);
    if (!image.includes("@sha256:") && (!tag.includes(":") || tag.endsWith(":latest"))) warnings.push(`The image ${image} has no fixed version.`);
  }
  return { ok: true, warnings };
}

export interface McpServerEntry {
  name: string;
  description?: string;
  transport: { kind: "stdio"; command: string; args?: string[] } | { kind: "streamable_http" | "sse"; url: string };
  env?: Record<string, string>;
}

function remoteUrl(raw: string): { ok: true; url: string; host: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "The server address is not a full address." };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { ok: false, error: "The server address must start with https:// (http:// only for this computer)." };
  if (u.username || u.password) return { ok: false, error: "The server address carries a user or password." };
  return { ok: true, url: u.toString(), host: u.host };
}

export const mcpInstallRoute: DeeplinkRoute = (link) => {
  if (link.path.join("/") !== "install") return { ok: false, error: "The MCP link can only install a server (atomicagent://mcp/install)." };
  const p = takeParams(link, {
    name: { max: 1, required: true },
    description: { max: 1 },
    command: { max: 1 },
    arg: { max: MCP_MAX_ARGS },
    args: { max: MCP_MAX_ARGS },
    env: { max: MCP_MAX_ENV },
    url: { max: 1 },
    transport: { max: 1 },
  });
  if (!p.ok) return p;
  const v = p.values;
  const name = v.name![0]!.trim();
  if (!MCP_SERVER_NAME_RE.test(name)) return { ok: false, error: "The server name can use lowercase letters, digits and dashes (2 to 32 characters)." };
  const description = (v.description![0] ?? "").trim();
  if (description.length > 200) return { ok: false, error: "The description is too long." };
  const command = v.command![0];
  const url = v.url![0];
  if ((command === undefined) === (url === undefined)) return { ok: false, error: "The link must give either a command or a url, not both." };
  const base = { route: "mcp-install", link: displayLink(link.raw) };

  if (url !== undefined) {
    if (v.arg!.length || v.args!.length || v.env!.length) return { ok: false, error: "A remote server link takes no arg or env." };
    const r = remoteUrl(url.trim());
    if (!r.ok) return r;
    const t = v.transport![0];
    if (t !== undefined && t !== "http" && t !== "sse") return { ok: false, error: "transport is http or sse." };
    const kind = t === "sse" || (t === undefined && /\/sse\/?$/i.test(new URL(r.url).pathname)) ? "sse" : "streamable_http";
    const server: McpServerEntry = { name, ...(description ? { description } : {}), transport: { kind, url: r.url } };
    return { ok: true, request: { ...base, server, warnings: [`What the agent asks this server, and what it answers, goes through ${r.host}.`] } };
  }

  if (v.transport!.length) return { ok: false, error: "transport is only for a url." };
  const args = [...v.arg!, ...v.args!];
  const check = checkMcpCommand(command, args);
  if (!check.ok) return check;
  const env: Record<string, string> = {};
  for (const pair of v.env!) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq) : pair;
    const value = eq > 0 ? pair.slice(eq + 1) : "";
    if (!ENV_NAME_RE.test(key)) return { ok: false, error: `The setting name ${JSON.stringify(key.slice(0, 40))} is not a valid environment name.` };
    if (envNameBlocked(key)) return { ok: false, error: `A link may not set ${key}.` };
    if (Object.prototype.hasOwnProperty.call(env, key)) return { ok: false, error: `The setting ${key} is given twice.` };
    if (value.length > 1024) return { ok: false, error: `The setting ${key} is too long.` };
    env[key] = value;
  }
  const server: McpServerEntry = {
    name,
    ...(description ? { description } : {}),
    transport: { kind: "stdio", command: command!.trim(), ...(args.length ? { args } : {}) },
    ...(Object.keys(env).length ? { env } : {}),
  };
  const warnings = [`This runs ${command!.trim()} on this computer with your permissions, every time the agent starts the server.`, ...check.warnings];
  const empty = Object.keys(env).filter((k) => env[k] === "");
  if (empty.length) warnings.push(`Empty settings (${empty.join(", ")}): fill them in Settings › MCP if the server needs them.`);
  return { ok: true, request: { ...base, server, warnings } };
};

/* ---------------- skill/install ---------------- */

export const skillInstallRoute: DeeplinkRoute = (link) => {
  if (link.path.join("/") !== "install") return { ok: false, error: "The skill link can only install a skill (atomicagent://skill/install)." };
  const p = takeParams(link, { slug: { max: 1, required: true }, owner: { max: 1 } });
  if (!p.ok) return p;
  let slug = p.values.slug![0]!.trim();
  let owner: string | null = (p.values.owner![0] ?? "").trim().replace(/^@/, "") || null;
  const m = /^@?([^/]+)\/([^/]+)$/.exec(slug);
  if (m) {
    if (owner && owner !== m[1]) return { ok: false, error: "The link names two different owners." };
    owner = m[1]!;
    slug = m[2]!;
  }
  if (!CLAWHUB_SLUG_RE.test(slug)) return { ok: false, error: "The skill name in the link is not a ClawHub skill name." };
  if (owner !== null && !CLAWHUB_OWNER_RE.test(owner)) return { ok: false, error: "The owner in the link is not a ClawHub user name." };
  return {
    ok: true,
    request: {
      route: "skill-install",
      link: displayLink(link.raw),
      slug,
      owner,
      /* `atag skill install` takes `@owner/slug`; without an owner the card asks ClawHub for it. */
      identifier: owner ? `@${owner}/${slug}` : null,
      warnings: ["A skill is instructions the agent follows, and may come with scripts it can run. The security scan runs before anything is installed."],
    },
  };
};

registerDeeplinkRoute("mcp", mcpInstallRoute);
registerDeeplinkRoute("skill", skillInstallRoute);

/* ---------------- the OS side ---------------- */

/**
 * Whether this launch takes the `atomicagent://` handler. Only a packaged,
 * ordinary launch does: a test, smoke, probe, dev or unpackaged run, and a
 * run on another state directory (the drive scenarios, a QA profile), must
 * never make the person's links open in it. ATOMIC_AGENT_NO_DEEPLINKS=1
 * turns it off by hand.
 */
export function shouldRegisterProtocol(opts: {
  packaged: boolean;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** state-dir.ts STATE_DIR_FROM_ENV: latched before state-dir-boot.ts sets ATOMIC_AGENT_STATE_DIR for every run. */
  stateDirFromEnv: boolean;
}): boolean {
  const { packaged, argv, env } = opts;
  if (!packaged || opts.stateDirFromEnv) return false;
  if (env.VITEST !== undefined || env.NODE_ENV === "test" || env.NODE_ENV === "development") return false;
  if (/^(1|true|yes|on)$/i.test((env.ATOMIC_AGENT_NO_DEEPLINKS ?? "").trim())) return false;
  return !argv.some((a) =>
    a === "--smoke" || a.startsWith("--smoke-") || a === "--first-run-probe" || a === "--models" || a === "--dev"
    || a.startsWith("--remote-debugging-port") || a.startsWith("--fake-") || a === "--atomic-boot-probe",
  );
}

/** The link in a launch's argv (Windows and Linux pass it as an argument). */
export function deeplinkFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a === "string" && a.toLowerCase().startsWith(`${DEEPLINK_SCHEME}:`)) return a;
  }
  return null;
}

/** The parts of Electron's `app` this needs, as plain functions, so the Node checks can hand in a fake. */
export interface DeeplinkApp {
  setAsDefaultProtocolClient(protocol: string): boolean;
  requestSingleInstanceLock(): boolean;
  exit(code: number): void;
  /** macOS: app.on("open-url"), with preventDefault already called. */
  onOpenUrl(listener: (url: string) => void): void;
  /** app.on("second-instance"): the second launch's argv. */
  onSecondInstance(listener: (argv: readonly string[]) => void): void;
}

export interface DeeplinkDeps {
  enabled: boolean;
  argv: readonly string[];
  /** Brings the window up (a new one if it was closed). Called only while ready() holds. */
  showWindow: () => void;
  /** Tells the window there is something to take. */
  notify: () => void;
  /** The app is ready and its first window exists. Before that a link waits; the window takes it when it loads. */
  ready: () => boolean;
  log: (line: string) => void;
  now?: () => number;
}

export interface DeeplinkController {
  /** What the window draws, oldest first; taking empties the queue. */
  take(): DeeplinkRequest[];
  /** A link from anywhere (open-url, argv, a test). */
  handle(raw: string): void;
}

const QUEUE_MAX = 5;
const SAME_LINK_MS = 2000;

/** The queue and its dedupe, without the OS. */
export function createDeeplinkQueue(deps: Pick<DeeplinkDeps, "showWindow" | "notify" | "ready" | "log" | "now">): DeeplinkController {
  const now = deps.now ?? Date.now;
  const queue: DeeplinkRequest[] = [];
  let last: { raw: string; at: number } | null = null;
  const handle = (raw: string): void => {
    const t = now();
    if (last && last.raw === raw && t - last.at < SAME_LINK_MS) return;   // a browser that fires the same click twice
    last = { raw, at: t };
    const r = routeDeeplink(raw);
    const request: DeeplinkRequest = r.ok ? r.request : { route: "error", link: displayLink(typeof raw === "string" ? raw : ""), error: r.error };
    deps.log(`[desktop] deeplink: ${request.route}${r.ok ? "" : ` (${r.error})`}`);   // the route only: a link may carry settings
    queue.push(request);
    while (queue.length > QUEUE_MAX) queue.shift();
    if (deps.ready()) {
      deps.showWindow();
      deps.notify();
    }
  };
  return {
    take: () => queue.splice(0, queue.length),
    handle,
  };
}

/**
 * The OS wiring, called at the top of main.ts (macOS sends `open-url` before
 * `ready` on a cold start). On a disabled run nothing is registered and no
 * link is handled. On an enabled run the app takes the single-instance lock:
 * a second launch that carries a link (Windows, Linux) hands it to the
 * first through `second-instance` and exits; a second launch without one
 * keeps today's behaviour.
 */
export function wireDeeplinks(app: DeeplinkApp, deps: DeeplinkDeps): DeeplinkController {
  const q = createDeeplinkQueue(deps);
  if (!deps.enabled) return q;
  try {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME);
  } catch (err) {
    deps.log(`[desktop] deeplink: could not register ${DEEPLINK_SCHEME}:// (${err instanceof Error ? err.message : String(err)})`);
  }
  const firstLink = deeplinkFromArgv(deps.argv);
  const primary = app.requestSingleInstanceLock();
  if (!primary && firstLink) {
    app.exit(0);
    return q;
  }
  app.onOpenUrl((url) => q.handle(url));
  app.onSecondInstance((argv) => {
    const link = deeplinkFromArgv(argv);
    if (link) q.handle(link);
  });
  if (firstLink) q.handle(firstLink);
  return q;
}

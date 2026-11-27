/**
 * The other programs of the egress scan (ATO-2116): file copies to a
 * host (scp, rsync), remote shells and raw sockets (ssh, nc, socat,
 * telnet, sftp, ftp), image pushes (docker, podman), cloud buckets
 * (aws s3, gsutil, gcloud storage), package publishing (npm, pnpm, yarn,
 * cargo, twine, poetry, gem) and inline scripts that post to a URL
 * (`python -c "requests.post(...)"`, `node -e "fetch(..., {method:'POST'})"`).
 * Patterns ported from Goose's egress inspector (Apache-2.0, see
 * egress-scan.ts); destination directions follow its `detect_direction`.
 */
import { hasUrlScheme, hostOfScpTarget, hostOfUrl, normaliseHost } from "./egress-host.js";
import type { EgressDestination, EgressKind } from "./egress-scan.js";

function entry(kind: EgressKind, host: string | null, direction: EgressDestination["direction"], label: string): EgressDestination {
  return { kind, host, direction, label: host ?? label };
}

/** The operands of `args`, skipping each flag in `valueFlags` together with its value. */
function operands(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      found.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (valueFlags.has(arg)) i += 1;
      continue;
    }
    found.push(arg);
  }
  return found;
}

const SCP_VALUE = new Set(["-P", "-i", "-o", "-F", "-c", "-l", "-S", "-J", "-D", "-X"]);
const RSYNC_VALUE = new Set(["-e", "--rsh", "-f", "--filter", "--exclude", "--include", "--port", "-T", "--temp-dir", "--log-file"]);

/**
 * scp and rsync: outbound when the last operand (the destination) is on
 * a host, inbound when only a source is.
 */
export function scanCopy(program: "scp" | "rsync", args: readonly string[]): EgressDestination[] {
  const words = operands(args, program === "scp" ? SCP_VALUE : RSYNC_VALUE);
  if (words.length < 2) return [];
  const remoteHost = (word: string): string | null | undefined => {
    if (/^(?:rsync|scp|sftp):\/\//i.test(word)) return hostOfUrl(word);
    return hostOfScpTarget(word) ?? undefined;
  };
  const destination = words[words.length - 1]!;
  const destHost = remoteHost(destination);
  if (destHost !== undefined) {
    return [entry("scp", destHost, "outbound", `a host in ${program}'s destination`)];
  }
  const found: EgressDestination[] = [];
  for (const source of words.slice(0, -1)) {
    const host = remoteHost(source);
    if (host !== undefined && host !== null) found.push(entry("scp", host, "inbound", host));
  }
  return found;
}

const SSH_VALUE = new Set([..."bcDEeFIiJLlmOopQRSWwB"].map((c) => `-${c}`));

/** ssh runs a command on the host and can carry piped data there: outbound. */
export function scanSsh(args: readonly string[]): EgressDestination[] {
  const target = operands(args, SSH_VALUE)[0];
  if (target === undefined) return [];
  const host = hasUrlScheme(target)
    ? hostOfUrl(target)
    : normaliseHost(target.slice(target.lastIndexOf("@") + 1));
  return [entry("ssh", host, "outbound", "a host ssh reads at run time")];
}

const SOCKET_VALUE = new Set(["-p", "-s", "-w", "-i", "-x", "-X", "-e", "-c", "-o", "-P", "-q"]);

/** nc, ncat, netcat, telnet, ftp, sftp: the first operand that reads as a host. */
export function scanSocket(program: string, args: readonly string[]): EgressDestination[] {
  // `nc -l 8080` listens; it sends nothing anywhere by itself.
  const listens = program === "nc" || program === "ncat" || program === "netcat";
  if (listens && args.some((a) => /^-[a-zA-Z]*l[a-zA-Z]*$/.test(a))) return [];
  for (const word of operands(args, SOCKET_VALUE)) {
    if (/^\d+$/.test(word)) continue;
    const bare = word.slice(word.lastIndexOf("@") + 1).replace(/:.*$/, "");
    const host = hasUrlScheme(word) ? hostOfUrl(word) : normaliseHost(bare);
    return [entry("socket", host, "outbound", `a host ${program} reads at run time`)];
  }
  return [];
}

/** socat: each `TCP:host:port` / `TCP4:` / `OPENSSL:` address. */
export function scanSocat(args: readonly string[]): EgressDestination[] {
  const found: EgressDestination[] = [];
  for (const arg of args) {
    const match = /^(?:tcp[46]?|openssl|udp[46]?|ssl):([^:,]+)/i.exec(arg);
    if (match !== null) found.push(entry("socket", normaliseHost(match[1] ?? ""), "outbound", "a host socat reads at run time"));
  }
  return found;
}

/** `docker push img`, `docker login reg`: the registry is the image's first part when it has a dot, a port or is localhost. */
export function scanContainer(args: readonly string[]): EgressDestination[] {
  const sub = args[0];
  if (sub !== "push" && sub !== "login") return [];
  const target = operands(args.slice(1), new Set(["-u", "--username", "-p", "--password"]))[0];
  if (target === undefined) {
    return sub === "login" ? [entry("docker_registry", "docker.io", "outbound", "docker.io")] : [];
  }
  if (sub === "login") {
    const host = hasUrlScheme(target) ? hostOfUrl(target) : normaliseHost(target.replace(/:\d+$/, ""));
    return [entry("docker_registry", host, "outbound", "a registry the command builds at run time")];
  }
  const slash = target.indexOf("/");
  const first = slash === -1 ? "" : target.slice(0, slash);
  const registry =
    first.includes(".") || first.includes(":") || first === "localhost"
      ? normaliseHost(first.replace(/:\d+$/, ""))
      : /[$`]/.test(target)
        ? null
        : "docker.io";
  return [entry("docker_registry", registry, "outbound", "a registry the command builds at run time")];
}

/** aws s3 / gsutil / gcloud storage: outbound when the last operand is a bucket. */
export function scanBucket(scheme: "s3" | "gs", words: readonly string[]): EgressDestination[] {
  const paths = operands(words, new Set(["--profile", "--region", "--endpoint-url", "-p", "-h"]));
  const bucketHost = (word: string): string | null | undefined => {
    const match = new RegExp(`^${scheme}://([^/]*)`, "i").exec(word);
    if (match === null) return undefined;
    const bucket = normaliseHost(match[1] ?? "");
    if (bucket === null) return null;
    return scheme === "s3" ? `${bucket}.s3.amazonaws.com` : `${bucket}.storage.googleapis.com`;
  };
  const kind: EgressKind = scheme === "s3" ? "s3_bucket" : "gcs_bucket";
  const last = paths[paths.length - 1];
  if (paths.length >= 2 && last !== undefined) {
    const host = bucketHost(last);
    if (host !== undefined) return [entry(kind, host, "outbound", `a bucket the command builds at run time`)];
  }
  const found: EgressDestination[] = [];
  for (const word of paths) {
    const host = bucketHost(word);
    if (host !== undefined && host !== null) found.push(entry(kind, host, "inbound", host));
  }
  return found;
}

/** The value of `--name value` / `--name=value` in `args`. */
function flagValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    for (const name of names) {
      if (arg === name) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function registryHost(value: string | undefined, fallback: string): string | null {
  if (value === undefined) return fallback;
  return hasUrlScheme(value) ? hostOfUrl(value) : normaliseHost(value);
}

/**
 * The registry a project's config sets for `program` (`publish-registry.ts`,
 * ATO-2528): a URL or host, `null` when set but unreadable, `undefined`
 * when nothing is set. `registryName` is cargo's `--registry`.
 */
export type PublishRegistryResolver = (program: string, registryName?: string) => string | null | undefined;

const JS_PUBLISHERS = new Set(["npm", "pnpm", "yarn"]);
/** Flags of `npm|pnpm|yarn publish` whose value is the next word. */
const PUBLISH_VALUE_FLAGS = new Set([
  "--tag", "--access", "--otp", "--registry", "-w", "--workspace", "--provenance-file",
  "--userconfig", "--scope", "--auth-type", "--publish-branch", "--report-summary",
  "--new-version", "--message", "-m", "--filter", "-F",
]);

/**
 * Whether `npm publish <folder|tarball>` names a package other than the
 * one in the current folder (review round 1 of ATO-2528). `.` and `./`
 * are the current folder.
 */
function publishOperand(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return args.slice(i + 1).some((a) => a !== "." && a !== "./");
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && PUBLISH_VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    if (arg !== "." && arg !== "./") return true;
  }
  return false;
}

/** npm/pnpm/yarn/cargo/twine/poetry/gem publishing; `program` is the binary, `args` what follows it. */
export function scanPublish(
  program: string,
  args: readonly string[],
  configured?: PublishRegistryResolver,
): EgressDestination[] {
  const sub = args[0];
  const publish = (fallback: string, flags: readonly string[]): EgressDestination[] => {
    const flag = flagValue(args, flags);
    // A flag wins; then the project's config; then the public default.
    // A folder or tarball named on the line publishes that package, with
    // its own `publishConfig`, which this does not read: unknown.
    const operand = JS_PUBLISHERS.has(program) && publishOperand(args.slice(program === "yarn" && sub === "npm" ? 2 : 1));
    if (flag === undefined && operand && configured !== undefined) {
      return [entry("package_publish", null, "outbound", `the registry ${program} is set to`)];
    }
    const fromConfig = flag === undefined && configured !== undefined ? configured(program) : undefined;
    const host = fromConfig === null ? null : registryHost(flag ?? fromConfig, fallback);
    return [entry("package_publish", host, "outbound", `the registry ${program} is set to`)];
  };
  if ((program === "npm" || program === "pnpm") && sub === "publish") return publish("registry.npmjs.org", ["--registry"]);
  if (program === "yarn" && (sub === "publish" || (sub === "npm" && args[1] === "publish"))) {
    return publish("registry.yarnpkg.com", ["--registry"]);
  }
  // A named cargo registry is set in cargo's config (`[registries.<name>]`).
  if (program === "cargo" && sub === "publish") {
    const name = flagValue(args, ["--registry"]);
    if (name !== undefined) {
      const index = configured?.("cargo", name);
      return [entry("package_publish", typeof index === "string" ? registryHost(index, "") : null, "outbound", "a cargo registry")];
    }
    return publish("crates.io", ["--index"]);
  }
  if (program === "twine" && sub === "upload") return publish("upload.pypi.org", ["--repository-url"]);
  if (program === "poetry" && sub === "publish") {
    return flagValue(args, ["--repository", "-r"]) !== undefined
      ? [entry("package_publish", null, "outbound", "a poetry repository")]
      : publish("upload.pypi.org", []);
  }
  if (program === "gem" && sub === "push") return publish("rubygems.org", ["--host"]);
  return [];
}

const INLINE_FLAG_RE = /^-[A-Za-z]*[cep]$|^--(?:eval|print)$/;
/** Calls in inline code that send a body. */
const SCRIPT_SENDS_RE =
  /\b(?:requests|httpx|session|client|axios|aiohttp|urllib3|ky|got|superagent)\s*\.\s*(?:post|put|patch)\s*\(|\bmethod\s*[:=]\s*["'`](?:post|put|patch)["'`]|\bbody\s*:|\burlopen\s*\([^)]*\bdata\s*=|\bNet::HTTP\.post|\bHTTP\.post|\bLWP::UserAgent\b[\s\S]*->\s*post\b|\.request\s*\(\s*["'`](?:post|put|patch)["'`]/i;
const SCRIPT_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)\]}]+/gi;

/** python/node/deno/bun/ruby/perl/php with code on the line (`-c`, `-e`, `-p`, `--eval`). */
export function scanInlineScript(program: string, args: readonly string[]): EgressDestination[] {
  const index = args.findIndex((a) => INLINE_FLAG_RE.test(a));
  if (index === -1) return [];
  const code = args.slice(index + 1).join(" ");
  const sends = SCRIPT_SENDS_RE.test(code);
  const found: EgressDestination[] = [];
  for (const match of code.matchAll(SCRIPT_URL_RE)) {
    found.push(entry("script", hostOfUrl(match[0]), sends ? "outbound" : "inbound", `an address ${program} builds when it runs`));
  }
  if (sends && found.length === 0) {
    found.push(entry("script", null, "outbound", `an address ${program} builds when it runs`));
  }
  return sends ? found : found.filter((d) => d.host !== null);
}

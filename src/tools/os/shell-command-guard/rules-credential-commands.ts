import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import { PREFIX_COMMANDS, programName, splitCommandSegments } from "./command-segments.js";

/**
 * `dangerous.read_credentials` for commands that print a secret from a
 * credential store rather than a file (ATO-2505): `security
 * find-generic-password -w` (the macOS keychain), `gh auth token`, `aws
 * configure get aws_secret_access_key`, `gcloud auth print-access-token`,
 * `az account get-access-token`, `op read`, `pass show`, `git credential
 * fill`, `git credential-store get`, `gh auth git-credential get`,
 * `kubectl config view --raw`, `secret-tool lookup`,
 * `docker-credential-* get`, `heroku auth:token`. Without a file path
 * on the line the file rules never saw them.
 *
 * Read from each simple command, past wrappers (`sudo`, `env`) and the
 * program's own global options (`aws --profile p`, `git -C dir`). A
 * command that only lists names (`security find-generic-password` without
 * `-w` / `-g`, `gh auth status` without `--show-token`, `op item list`)
 * is not a finding.
 */

const SECRET_CONFIDENCE = 0.9;

type Matcher = (args: readonly string[]) => boolean;

/** One of `flags` is given, also as `--flag=value`. */
const has = (args: readonly string[], ...flags: string[]): boolean =>
  args.some(
    (arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)),
  );
const startsWith = (args: readonly string[], ...words: string[]): boolean =>
  words.every((word, index) => args[index] === word);

/** `aws_secret_access_key`, also `default.aws_secret_access_key`. */
const AWS_SECRET_KEYS = /(?:^|\.)(?:aws_secret_access_key|aws_access_key_id|aws_session_token)$/;
/** `pass` subcommands that print no password. */
const PASS_NON_SECRET = /^(?:ls|list|find|search|init|insert|add|edit|generate|rm|remove|delete|mv|rename|cp|copy|git|help|version|-.*)$/;

const PRINTERS: Readonly<Record<string, Matcher>> = {
  // macOS keychain: `-w` prints the password, `-g` prints it to stderr.
  security: (args) =>
    (/^find-(?:generic|internet)-password$/.test(args[0] ?? "") &&
      args.some((arg) => /^-[a-z]*[wg][a-z]*$/.test(arg))) ||
    (args[0] === "dump-keychain" && args.some((arg) => /^-[a-z]*d[a-z]*$/.test(arg))) ||
    args[0] === "export",
  glab: (args) => startsWith(args, "auth", "status") && has(args, "-t", "--show-token"),
  aws: (args) =>
    (startsWith(args, "configure", "get") && AWS_SECRET_KEYS.test(args[2] ?? "")) ||
    startsWith(args, "configure", "export-credentials") ||
    startsWith(args, "ecr", "get-login-password") ||
    startsWith(args, "codeartifact", "get-authorization-token"),
  gcloud: (args) =>
    args.some((arg) => /^print-(?:access|identity|refresh)-token$/.test(arg)) ||
    startsWith(args, "secrets", "versions", "access"),
  az: (args) =>
    startsWith(args, "account", "get-access-token") || startsWith(args, "keyvault", "secret", "show"),
  op: (args) =>
    args[0] === "read" || (startsWith(args, "item", "get") && has(args, "--reveal", "--fields", "--otp")),
  pass: (args) =>
    args[0] === "show" || args[0] === "grep" || (args.length === 1 && !PASS_NON_SECRET.test(args[0]!)),
  gopass: (args) => args[0] === "show" || args[0] === "cat",
  gh: (args) =>
    startsWith(args, "auth", "token") ||
    (startsWith(args, "auth", "git-credential") && args.includes("get")) ||
    (startsWith(args, "auth", "status") && has(args, "-t", "--show-token")),
  // `git credential fill`, and a helper asked directly: `git
  // credential-store get`, `credential-cache`, `credential-manager`,
  // `credential-osxkeychain`, `credential-libsecret`, `credential-wincred`.
  git: (args) =>
    startsWith(args, "credential", "fill") ||
    (/^credential-[a-z][a-z0-9-]*$/.test(args[0] ?? "") && args[1] === "get"),
  kubectl: (args) => startsWith(args, "config", "view") && has(args, "--raw", "--flatten"),
  "secret-tool": (args) => args[0] === "lookup",
  keyctl: (args) => args[0] === "print" || args[0] === "pipe",
  heroku: (args) => args[0] === "auth:token",
  doctl: (args) => startsWith(args, "auth", "token"),
  vault: (args) => startsWith(args, "print", "token"),
  npm: (args) => startsWith(args, "config", "get") && /(?:^|:)_auth(?:token)?$/i.test(args[2] ?? ""),
};

/**
 * Global options that take a value, per program, so `aws --region r ecr
 * get-login-password` or `git -C . credential fill` is read from its
 * subcommand (review round 1 of ATO-2505). Other leading `-x` words are
 * skipped alone (`git --no-pager`, `aws --debug`); `--flag=value` is one
 * word.
 */
const GLOBAL_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  aws: [
    "--region", "--profile", "--output", "--endpoint-url", "--query", "--ca-bundle",
    "--color", "--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format",
  ],
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"],
  kubectl: [
    "--context", "-n", "--namespace", "--kubeconfig", "--cluster", "--user", "-s", "--server",
    "--token", "--as", "--as-group", "--as-uid", "--request-timeout", "-v", "--v",
    "--certificate-authority", "--client-certificate", "--client-key", "--tls-server-name",
    "--cache-dir", "--profile", "--profile-output",
  ],
  gh: ["-R", "--repo", "--hostname"],
  glab: ["-R", "--repo"],
  op: ["--account", "--config", "--encoding", "--session", "--format"],
  az: ["--subscription", "-o", "--output", "--query"],
  doctl: ["--context", "-t", "--access-token", "--config", "-o", "--output", "-u", "--api-url"],
  npm: ["--prefix", "--userconfig", "--globalconfig", "--registry", "-w", "--workspace"],
  vault: ["-address", "-namespace", "-ca-cert"],
  heroku: ["-a", "--app"],
};

/** `args` past the leading global options of `program`. */
function pastGlobalOptions(program: string, args: readonly string[]): readonly string[] {
  const valueFlags = GLOBAL_VALUE_FLAGS[program];
  if (valueFlags === undefined) return args;
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-") && args[at] !== "-" && args[at] !== "--") {
    at += valueFlags.includes(args[at]!) ? 2 : 1;
  }
  if (args[at] === "--") at += 1;
  return args.slice(at);
}

/** The program word of a simple command, past wrappers and their value flags. */
function commandStart(words: readonly string[]): number {
  let at = 0;
  while (at < words.length) {
    const word = words[at]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      at += 1;
      continue;
    }
    const valueFlags = PREFIX_COMMANDS[programName(word)];
    if (valueFlags === undefined) return at;
    at += 1;
    while (at < words.length && words[at]!.startsWith("-")) {
      at += valueFlags.includes(words[at]!) ? 2 : 1;
    }
  }
  return at;
}

export function matchCredentialCommand(input: NormalisedCommand): ArgScanFinding | null {
  for (const words of splitCommandSegments(input.joined)) {
    const at = commandStart(words);
    const head = words[at];
    if (head === undefined) continue;
    const program = programName(head);
    const args = pastGlobalOptions(program, words.slice(at + 1));
    // A credential helper run as its own binary: `docker-credential-
    // osxkeychain get`, `git-credential-store get`.
    const printer = /^(?:docker|git)-credential-/.test(program)
      ? (rest: readonly string[]) => rest[0] === "get"
      : PRINTERS[program];
    if (printer === undefined || !printer(args)) continue;
    return {
      id: "dangerous.read_credentials",
      reason: `prints a saved credential (${[program, ...args.slice(0, 3)].join(" ")})`,
      confidence: SECRET_CONFIDENCE,
    };
  }
  return null;
}

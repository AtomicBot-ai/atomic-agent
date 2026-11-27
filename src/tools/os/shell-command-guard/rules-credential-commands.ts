import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import { PREFIX_COMMANDS, programName, splitCommandSegments } from "./command-segments.js";

/**
 * `dangerous.read_credentials` for commands that print a secret from a
 * credential store rather than a file (ATO-2505): `security
 * find-generic-password -w` (the macOS keychain), `gh auth token`, `aws
 * configure get aws_secret_access_key`, `gcloud auth print-access-token`,
 * `az account get-access-token`, `op read`, `pass show`, `git credential
 * fill`, `kubectl config view --raw`, `secret-tool lookup`,
 * `docker-credential-* get`, `heroku auth:token`. Without a file path
 * on the line the file rules never saw them.
 *
 * Read from each simple command, past wrappers (`sudo`, `env`). A
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
  gh: (args) =>
    startsWith(args, "auth", "token") ||
    (startsWith(args, "auth", "status") && has(args, "-t", "--show-token")),
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
  git: (args) => startsWith(args, "credential", "fill") || startsWith(args, "credential-osxkeychain", "get"),
  kubectl: (args) => startsWith(args, "config", "view") && has(args, "--raw", "--flatten"),
  "secret-tool": (args) => args[0] === "lookup",
  keyctl: (args) => args[0] === "print" || args[0] === "pipe",
  heroku: (args) => args[0] === "auth:token",
  doctl: (args) => startsWith(args, "auth", "token"),
  vault: (args) => startsWith(args, "print", "token"),
  npm: (args) => startsWith(args, "config", "get") && /(?:^|:)_auth(?:token)?$/i.test(args[2] ?? ""),
};

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
    const args = words.slice(at + 1);
    const printer = /^docker-credential-/.test(program)
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

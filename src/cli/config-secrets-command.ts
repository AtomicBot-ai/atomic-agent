import {
  SecretAccessError,
  moveSecretsToEnv,
  moveSecretsToKeychain,
  readSavedSecret,
  readSecretsStoreState,
  resolveStateDir,
  saveSecret,
  secretNameError,
  type SecretsMigrationResult,
} from "../config/index.js";
import { printSecretRefs } from "./config-secrets-refs.js";
import { isRawModeTerminal, readHiddenLine } from "./hidden-line-prompt.js";

/**
 * `atomic-agent config secrets [status|keychain|env]` (ATO-474): show or
 * switch where saved API keys and tokens live. `.env` stays the
 * default; `keychain` is opt-in and moves the keys both ways. Prints
 * key names only, never values.
 */
export const SECRETS_HELP =
  [
    "atomic-agent config secrets — where saved API keys and tokens live",
    "",
    "  secrets [status]          Print the current store and the keys in the OS keychain",
    "  secrets keychain          Move API keys and tokens from .env to the OS keychain",
    "                            (macOS Keychain, Windows Credential Manager, Linux",
    "                            Secret Service) and save new ones there",
    "  secrets env               Move them back to <stateDir>/.env (the default)",
    "  secrets status --json     The same as JSON: {\"store\", \"keychainKeys\"} (names only)",
    "  secrets set <NAME>        Save one key wherever keys live now. In a terminal it",
    "                            asks for the value and does not show it; piped, it",
    "                            reads one line from stdin. Prints where it went",
    "                            (--json for JSON)",
    "  secrets get <NAME>        Print one saved key's value (for the desktop app);",
    "                            exit 1 when it is not saved",
    "  secrets unset <NAME>      Remove one saved key from .env and the OS keychain",
    "  secrets refs              List saved keys written as references (op://, bw://,",
    "                            cmd://) and the {{secret:NAME}} names tools may use",
    "",
    "NAME must end in _KEY, _TOKEN, _SECRET or _PASSWORD. The value is never",
    "taken as an argument, so it does not show up in the process list.",
    "",
    "If the keychain fails (no Secret Service, access denied, ...), keys stay in",
    ".env and the agent keeps working. A desktop app that saves keys through",
    "`secrets set` (ATO-1639) follows this choice; an older one reads .env only.",
  ].join("\n") + "\n";

export function handleSecrets(
  args: string[],
  stateDir: string = resolveStateDir(),
  stdin: NodeJS.ReadableStream = process.stdin,
): number | Promise<number> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "status":
      return args.includes("--json") ? printStatusJson(stateDir) : printStatus(stateDir);
    case "set":
      return setOne(args.slice(1), stateDir, stdin);
    case "get":
      return getOne(args.slice(1), stateDir);
    case "unset":
      return unsetOne(args.slice(1), stateDir);
    case "refs":
      return printSecretRefs(stateDir);
    case "keychain":
      return report(moveSecretsToKeychain(stateDir), "the OS keychain");
    case "env":
      return report(moveSecretsToEnv(stateDir), ".env");
    case "-h":
    case "--help":
      process.stdout.write(SECRETS_HELP);
      return 0;
    default:
      process.stderr.write(`unknown secrets subcommand: ${sub}\n`);
      process.stderr.write(SECRETS_HELP);
      return 1;
  }
}

function printStatusJson(stateDir: string): number {
  const state = readSecretsStoreState(stateDir);
  process.stdout.write(
    `${JSON.stringify({ store: state.store, keychainKeys: state.keychainKeys })}\n`,
  );
  return 0;
}

/** The one NAME argument of `set|get|unset`, or null after saying why. */
function nameArg(args: string[], verb: string): string | null {
  const names = args.filter((a) => !a.startsWith("--"));
  if (names.length !== 1) {
    process.stderr.write(`usage: atomic-agent config secrets ${verb} <NAME>\n`);
    return null;
  }
  const name = names[0]!;
  const error = secretNameError(name);
  if (error) {
    process.stderr.write(`${error}\n`);
    return null;
  }
  return name;
}

async function readAll(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `secrets set NAME`: in a terminal, a prompt and a hidden read
 * (ATO-2756); from a pipe, one line of stdin, a final newline dropped.
 */
async function setOne(
  args: string[],
  stateDir: string,
  stdin: NodeJS.ReadableStream,
): Promise<number> {
  const name = nameArg(args, "set");
  if (!name) return 1;
  let raw: string;
  if (isRawModeTerminal(stdin)) {
    const typed = await readHiddenLine(
      stdin,
      process.stderr,
      `Paste the value for ${name} and press Enter (it will not be shown): `,
    );
    if (typed === null) {
      process.stderr.write("Cancelled; nothing was saved.\n");
      return 130;
    }
    raw = typed;
  } else {
    raw = await readAll(stdin);
  }
  const value = raw.replace(/\r?\n$/, "").trim();
  try {
    const saved = saveSecret(stateDir, name, value);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ name, store: saved.store })}\n`);
    } else {
      process.stdout.write(
        `Saved ${name} to ${saved.store === "keychain" ? "the OS keychain" : ".env"}\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof SecretAccessError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** `secrets get NAME`: the value alone on stdout, for a program reading the pipe. */
function getOne(args: string[], stateDir: string): number {
  const name = nameArg(args, "get");
  if (!name) return 1;
  const read = readSavedSecret(stateDir, name);
  if (!read.ok) {
    process.stderr.write(`${name} could not be read from the OS keychain\n`);
    return 2;
  }
  if (read.value === null || read.value.length === 0) {
    process.stderr.write(`${name} is not saved\n`);
    return 1;
  }
  process.stdout.write(`${read.value}\n`);
  return 0;
}

function unsetOne(args: string[], stateDir: string): number {
  const name = nameArg(args, "unset");
  if (!name) return 1;
  saveSecret(stateDir, name, null);
  process.stdout.write(`Removed ${name}\n`);
  return 0;
}

function printStatus(stateDir: string): number {
  const state = readSecretsStoreState(stateDir);
  const lines = [
    `Secrets store: ${state.store === "keychain" ? "OS keychain" : ".env"}`,
  ];
  if (state.keychainKeys.length > 0) {
    lines.push(`Keys in the OS keychain: ${state.keychainKeys.join(", ")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function report(result: SecretsMigrationResult, target: string): number {
  const lines: string[] = [];
  if (result.moved.length > 0) {
    lines.push(`Moved to ${target}: ${result.moved.join(", ")}`);
  } else if (result.ok) {
    lines.push(`Nothing to move; new keys are saved to ${target}.`);
  }
  if (result.left.length > 0) {
    lines.push(`Not moved (the OS keychain failed): ${result.left.join(", ")}`);
  }
  if (result.orphaned.length > 0) {
    lines.push(
      `Copied to .env, but still in the OS keychain (delete the "atomic-agent" entries by hand): ${result.orphaned.join(", ")}`,
    );
  }
  if (!result.ok && result.moved.length === 0 && result.left.length === 0) {
    lines.push("The OS keychain is not usable on this machine; keys stay in .env.");
  }
  lines.push(
    `Secrets store: ${result.store === "keychain" ? "OS keychain" : ".env"}`,
  );
  const out = `${lines.join("\n")}\n`;
  if (result.ok) process.stdout.write(out);
  else process.stderr.write(out);
  return result.ok ? 0 : 1;
}

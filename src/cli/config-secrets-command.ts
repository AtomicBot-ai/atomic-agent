import {
  moveSecretsToEnv,
  moveSecretsToKeychain,
  readSecretsStoreState,
  resolveStateDir,
  type SecretsMigrationResult,
} from "../config/index.js";

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
    "",
    "If the keychain fails (no Secret Service, access denied, ...), keys stay in",
    ".env and the agent keeps working. The desktop app still reads keys from .env",
    "directly, so leave this on .env on a machine that also runs the desktop app.",
  ].join("\n") + "\n";

export function handleSecrets(
  args: string[],
  stateDir: string = resolveStateDir(),
): number {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "status":
      return printStatus(stateDir);
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

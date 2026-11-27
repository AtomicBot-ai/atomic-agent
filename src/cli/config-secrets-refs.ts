import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readSavedSecret, readSecretsStoreState } from "../config/index.js";
import { parseDotenvText } from "../config/load-dotenv.js";
import { SECRET_SOURCES_FILE, looksLikeSecretRef, readSecretSources } from "../config/secret-refs.js";

/**
 * `atomic-agent config secrets refs` (ATO-2756): which saved keys are
 * written as secret references (ATO-2339) and which `{{secret:NAME}}`
 * names tools may use (`toolSecrets` of `secret-sources.json`, ATO-476),
 * so the user does not have to open the files to find out. Read-only.
 * Prints references only: a reference names where a value lives
 * (`op://vault/item/field`), never the value, and `secrets get` shows
 * the same text. Nothing is resolved, so `op` / `bw` are not run.
 */

function sourceLabel(ref: string): string {
  if (ref.startsWith("op://")) return "1Password";
  if (ref.startsWith("bw://")) return "Bitwarden";
  return `your command in ${SECRET_SOURCES_FILE}`;
}

function rows(entries: [string, string][]): string[] {
  const width = Math.max(...entries.map(([name]) => name.length));
  return entries.map(([name, ref]) => `  ${name.padEnd(width)}  ${ref}  (${sourceLabel(ref)})`);
}

/** Saved keys, `.env` first then the OS keychain, whose value is a reference. */
function savedRefs(stateDir: string): { refs: [string, string][]; unreadable: string[] } {
  const refs: [string, string][] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  const envPath = join(stateDir, ".env");
  if (existsSync(envPath)) {
    for (const [name, value] of parseDotenvText(readFileSync(envPath, "utf8"))) {
      if (value.length === 0) continue;
      seen.add(name);
      if (looksLikeSecretRef(value)) refs.push([name, value.trim()]);
    }
  }
  const state = readSecretsStoreState(stateDir);
  if (state.store === "keychain") {
    for (const name of state.keychainKeys) {
      if (seen.has(name)) continue;
      const read = readSavedSecret(stateDir, name);
      if (!read.ok) unreadable.push(name);
      else if (read.value !== null && looksLikeSecretRef(read.value)) refs.push([name, read.value.trim()]);
    }
  }
  return { refs, unreadable };
}

export function printSecretRefs(stateDir: string): number {
  const lines: string[] = [];
  const { refs, unreadable } = savedRefs(stateDir);
  if (refs.length > 0) {
    lines.push("Saved keys written as references (resolved when the agent starts):", ...rows(refs));
  } else {
    lines.push(
      "No saved key is written as a reference.",
      "  To keep a key in 1Password: atomic-agent config secrets set NAME, then paste op://vault/item/field",
    );
  }
  if (unreadable.length > 0) {
    lines.push(`Could not be read from the OS keychain: ${unreadable.join(", ")}`);
  }

  const sourcesPath = join(stateDir, SECRET_SOURCES_FILE);
  const warnings: string[] = [];
  const sources = readSecretSources(stateDir, (message) => warnings.push(message));
  const tool = Object.entries(sources.toolSecrets);
  lines.push("");
  if (tool.length > 0) {
    lines.push("Tool secrets (a shell command may use them as {{secret:NAME}}):", ...rows(tool));
  } else if (warnings.length === 0) {
    lines.push("No tool secrets.");
  }
  lines.push(`  Edit "toolSecrets" in ${sourcesPath} to add or remove them.`);
  process.stdout.write(`${lines.join("\n")}\n`);
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
  return warnings.length > 0 ? 1 : 0;
}

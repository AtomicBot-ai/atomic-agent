/**
 * Read / write integration credentials.
 *
 * Values live in `<stateDir>/.env` (0600, atomic writes) via the
 * existing `setDotenvKey`, never in `config.json`. Reads go through
 * `process.env`, which `loadDotenvFromStateDir` has already populated,
 * so a value written here is visible to the next `getConfig()` consumer
 * without a bespoke cache.
 */

import { setDotenvKey } from "../config/dotenv-writer.js";
import type {
  IntegrationDescriptor,
  IntegrationField,
} from "./integration-descriptor.js";

/** Read one field's current value, or `undefined` when unset/blank. */
export function readFieldValue(
  field: IntegrationField,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[field.envVar];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Field keys of `descriptor` that currently hold a value. */
export function presentFieldKeys(
  descriptor: IntegrationDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const present = new Set<string>();
  for (const field of descriptor.fields) {
    if (readFieldValue(field, env) !== undefined) present.add(field.key);
  }
  return present;
}

/**
 * Render a value for display. Secrets become bullets so a shoulder-surf
 * or a screen-share never leaks one; the length is capped so a long key
 * cannot blow out the pane width.
 */
export function displayFieldValue(
  field: IntegrationField,
  value: string | undefined,
): string {
  if (value === undefined) return "—";
  if (!field.secret) return value;
  const masked = "•".repeat(Math.min(value.length, 32));
  return value.length > 32 ? `${masked}+${value.length - 32}` : masked;
}

export class IntegrationSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSecretError";
  }
}

/**
 * Persist a field value, or clear it when `value` is `null`.
 *
 * `process.env` is updated in the same breath so the live process sees
 * the change without a restart — otherwise the hub would report a key
 * as saved while every consumer still read the old one.
 */
export function writeFieldValue(
  stateDir: string,
  field: IntegrationField,
  value: string | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (value === null) {
    setDotenvKey(stateDir, field.envVar, null);
    delete env[field.envVar];
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new IntegrationSecretError(`${field.label} is empty`);
  }
  const invalid = field.validate?.(trimmed);
  if (invalid !== undefined) {
    throw new IntegrationSecretError(invalid);
  }
  setDotenvKey(stateDir, field.envVar, trimmed);
  env[field.envVar] = trimmed;
}

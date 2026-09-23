import { getDefaultArgsJsonSchema } from "../prompt/default-tool-args-schemas.js";
import { nearestKey } from "./argument-error-hint.js";
import { normalizeArgKeys } from "./coerce-tool-args.js";

/**
 * A tool call carrying argument keys the tool's schema does not know is
 * refused before dispatch instead of running with those keys dropped.
 *
 * Seen live (Gemma 4 31B fusion workers, 2026-09-15):
 * `os.shell.run {"cmd":"python3","-e":"<script>"}` and
 * `os.shell.run {"cmd":"python3","-args":["-c","<script>"]}`. `cmd` was
 * valid, the unknown keys were silently ignored, `python3` ran with no
 * arguments (exit 0), and the worker reported the renames as done. A
 * tool reads the keys it knows; a key it does not know is not a spare
 * argument, it is a call the model did not mean — and the rest of the
 * call must not run as if the key were absent. `findUnknownArguments`
 * is what `executeBatch` asks before dispatch, right after F37's
 * control-marker check; a hit turns the call into an error result the
 * model reads on its next step.
 *
 * What is checked: the TOP-LEVEL keys, against the tool's registered
 * args schema (`default-tool-args-schemas.ts`), after F33's key
 * normalisation (`normalizeArgKeys`: a key wrapped in its own quotes, a
 * key fused with a prompt fragment) has had its chance — a key that
 * normalises into the schema is renamed at dispatch and is not unknown.
 * A tool with no registered schema (an MCP tool, an unregistered name)
 * is exempt: there is nothing to check against.
 */
export interface UnknownArgumentReport {
  /** The tool result text: which keys, which the tool accepts, what to do. */
  readonly message: string;
  /** Received keys the schema does not know, in argument order. */
  readonly unknownKeys: readonly string[];
  /** The schema's keys, in schema order. */
  readonly expectedKeys: readonly string[];
  /** Unknown keys with the schema key each most likely meant. */
  readonly nearest: ReadonlyArray<{ received: string; expected: string }>;
}

/**
 * The report for a call whose top-level keys include ones `tool`'s
 * schema does not know, or `null` when the call is clean or the tool
 * has no schema to check against.
 */
export function findUnknownArguments(
  tool: string,
  args: Record<string, unknown>,
): UnknownArgumentReport | null {
  const properties = schemaProperties(tool);
  if (properties === null) return null;
  const expectedKeys = Object.keys(properties);
  const unknownKeys = Object.keys(normalizeArgKeys(args, properties)).filter(
    (key) => !Object.hasOwn(properties, key),
  );
  if (unknownKeys.length === 0) return null;
  const nearest: Array<{ received: string; expected: string }> = [];
  const unsuggested: string[] = [];
  for (const received of unknownKeys) {
    const expected = suggestKey(received, expectedKeys);
    if (expected !== null) nearest.push({ received, expected });
    else unsuggested.push(received);
  }
  const hint =
    tool === "os.shell.run" ? shellScriptHint(args, unsuggested) : null;
  return {
    message: describeUnknownArguments({
      tool,
      unknownKeys,
      expectedKeys,
      nearest,
      hint,
    }),
    unknownKeys,
    expectedKeys,
    nearest,
  };
}

/**
 * The schema key an unknown key most likely meant: its own spelling
 * without leading dashes or underscores (`-args` → `args`, `__path` →
 * `path`), else the key within two edits, case-insensitively (`Path` →
 * `path`, `oldstring` → `oldString`, `patth` → `path`). `null` when
 * neither applies — `-e` is nothing the shell tool accepts.
 */
export function suggestKey(
  received: string,
  expected: readonly string[],
): string | null {
  const stripped = received.replace(/^[-_]+/, "");
  if (stripped.length > 0 && stripped !== received) {
    const needle = stripped.toLowerCase();
    const exact = expected.find((key) => key.toLowerCase() === needle);
    if (exact !== undefined) return exact;
  }
  return nearestKey(received, expected);
}

/**
 * Interpreters whose inline-script flag is not `-c`. `python`, `sh`,
 * `bash`, `zsh` and the rest take `-c`; a model steered to `-c` for
 * `node` would get `--check` instead.
 */
const SCRIPT_FLAG_BY_INTERPRETER: ReadonlyMap<string, string> = new Map([
  ["node", "-e"],
  ["nodejs", "-e"],
  ["perl", "-e"],
  ["ruby", "-e"],
]);

/**
 * For `os.shell.run`: a command-line flag used as a KEY (`"-e": "<script>"`)
 * is the model treating the args object as argv. The fix is the flag and
 * the script as two entries of `args`; said with the flag the named
 * interpreter takes. `null` when no unsuggested key looks like a flag.
 */
function shellScriptHint(
  args: Record<string, unknown>,
  unsuggested: readonly string[],
): string | null {
  if (!unsuggested.some((key) => key.startsWith("-"))) return null;
  const cmd = typeof args.cmd === "string" ? args.cmd.trim() : "";
  const interpreter = (cmd.split(/[\\/]/).pop() ?? "")
    .toLowerCase()
    .replace(/[\d.]+$/, "");
  const flag = SCRIPT_FLAG_BY_INTERPRETER.get(interpreter) ?? "-c";
  return `put the script in args: ["${flag}", "…"]`;
}

/**
 * The tool result an unknown-key call gets instead of running: the keys
 * (never the values — a value can be a whole script), the keys the tool
 * accepts, the likely spelling, and what to do — re-emit the call.
 */
function describeUnknownArguments(input: {
  tool: string;
  unknownKeys: readonly string[];
  expectedKeys: readonly string[];
  nearest: ReadonlyArray<{ received: string; expected: string }>;
  hint: string | null;
}): string {
  const { tool, unknownKeys, expectedKeys, nearest, hint } = input;
  const listed = unknownKeys.map((key) => `\`${key}\``).join(", ");
  const head = `unknown argument${unknownKeys.length > 1 ? "s" : ""} ${listed} for ${tool}`;
  const parts = [
    `expected: ${expectedKeys.length > 0 ? expectedKeys.join(", ") : "(no arguments)"}`,
  ];
  for (const { received, expected } of nearest) {
    parts.push(
      unknownKeys.length === 1
        ? `did you mean \`${expected}\`?`
        : `did you mean \`${expected}\` instead of \`${received}\`?`,
    );
  }
  if (hint !== null) parts.push(hint);
  return (
    `${head} (${parts.join("; ")}) — the call was not run; ` +
    "re-emit it with the right keys"
  );
}

/**
 * The `properties` of `tool`'s registered args schema, or `null` when
 * there is no schema to check against: none registered (MCP tools, an
 * unregistered name), or a top level that admits other keys.
 */
function schemaProperties(tool: string): Record<string, unknown> | null {
  const schema = getDefaultArgsJsonSchema(tool);
  if (schema === undefined || schema.additionalProperties !== false) {
    return null;
  }
  const properties = schema.properties;
  return properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : null;
}

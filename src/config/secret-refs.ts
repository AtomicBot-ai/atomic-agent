import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildCommandEnv } from "../sandbox/command-env.js";

/**
 * Secret references (ATO-2339): a saved secret whose value names where
 * the real value lives instead of holding it, resolved by a command the
 * user already trusts. Precedent: 1Password `op run`, which reads
 * `op://` references and hands the child the values.
 *
 * - `op://vault/item/field` (or `op://vault/item/section/field`): `op read <ref>`.
 * - `bw://item/field`, field one of `password`, `username`, `totp`, `notes`:
 *   `bw get <field> <item>` (Bitwarden CLI).
 * - `vault://mount/path#field` (ATO-2530): HashiCorp Vault KV v2 over HTTP,
 *   `GET $VAULT_ADDR/v1/<mount>/data/<path>` with `VAULT_TOKEN` (or the
 *   `~/.vault-token` that `vault login` writes), no CLI needed
 *   (`vault-secret-ref.ts`).
 * - `cmd://key` (or bare `cmd://`, which means the variable's own name):
 *   the `command` of `<stateDir>/secret-sources.json`, with the key in the
 *   child's environment as `ATOMIC_AGENT_SECRET_KEY`.
 *
 * Every command runs as an argv array with no shell: the reference is one
 * argument, never spliced into a command line. This file only parses and
 * plans; running belongs to `secret-ref-resolver.ts`.
 */
export type SecretRef =
  | { kind: "op"; ref: string }
  | { kind: "bw"; item: string; field: BitwardenField }
  | { kind: "vault"; mount: string; path: string; field: string }
  | { kind: "command"; key: string };

export type BitwardenField = "password" | "username" | "totp" | "notes";
const BITWARDEN_FIELDS: ReadonlySet<string> = new Set(["password", "username", "totp", "notes"]);

/** Env name the `cmd://` key reaches the user's command under. */
export const SECRET_KEY_ENV = "ATOMIC_AGENT_SECRET_KEY";

/** `<stateDir>/secret-sources.json`: beside `secrets-store.json`, read before `config.json`. */
export const SECRET_SOURCES_FILE = "secret-sources.json";

/** How long one resolving command may run unless the sources file says otherwise. */
export const DEFAULT_SECRET_REF_TIMEOUT_MS = 3_000;
/**
 * ATO-2530: `op` and `bw` may wait on a person (Touch ID, Windows Hello,
 * the unlock prompt of the 1Password app), which 3 s cuts off. Their
 * default is 30 s, like the 1Password CLI's own biometric prompt window;
 * a `timeoutMs` in the sources file still wins for every kind.
 */
export const INTERACTIVE_SECRET_REF_TIMEOUT_MS = 30_000;
const MAX_SECRET_REF_TIMEOUT_MS = 60_000;

export interface SecretSources {
  /** argv of the generic helper for `cmd://` references; absent means none. */
  command?: string[];
  /** Secret-looking variables the helper may still see (its own session token). */
  envPassthrough: string[];
  timeoutMs: number;
  /** Whether `timeoutMs` came from the file (then it applies to `op` and `bw` too). */
  timeoutSet?: boolean;
  /**
   * Secrets a tool call may name as `{{secret:NAME}}` (ATO-476), name to
   * reference. Only these names: the agent's own provider keys are never
   * offered to a command unless listed here.
   */
  toolSecrets: Record<string, string>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Path parts of a reference: no whitespace, no control characters.
const PART = "[^/\\s\\x00-\\x1f]+";
const OP_REF = new RegExp(`^op://${PART}/${PART}(?:/${PART}){1,2}$`);
const BW_REF = /^bw:\/\/([^\x00-\x1f]+)\/([a-z]+)$/;
const CMD_REF = /^cmd:\/\/([^\s\x00-\x1f]*)$/;
// mount / one or more path parts # field; no `..` part, so the URL stays under /v1/<mount>/data/.
const VPART = "[^/#?\\s\\x00-\\x1f]+";
const VAULT_REF = new RegExp(`^vault://(${VPART})/(${VPART}(?:/${VPART})*)#([^\\s\\x00-\\x1f#]+)$`);

/** Whether `value` is written as a reference at all (a known scheme). */
export function looksLikeSecretRef(value: string): boolean {
  return /^(?:op|bw|vault|cmd):\/\//.test(value.trim());
}

/**
 * The reference `value` stands for, `null` when it is an ordinary value,
 * or an error string when it uses a reference scheme but is malformed (so
 * a typo fails loudly instead of being sent as a literal key).
 */
export function parseSecretRef(value: string, name: string): SecretRef | null | string {
  const raw = value.trim();
  if (!looksLikeSecretRef(raw)) return null;
  if (raw.startsWith("op://")) {
    return OP_REF.test(raw) ? { kind: "op", ref: raw } : "expected op://vault/item/field";
  }
  if (raw.startsWith("bw://")) {
    const m = BW_REF.exec(raw);
    if (!m || m[1]!.trim().length === 0 || m[1]!.startsWith("-")) return "expected bw://item/field";
    if (!BITWARDEN_FIELDS.has(m[2]!)) return "the bw:// field must be password, username, totp or notes";
    return { kind: "bw", item: m[1]!, field: m[2] as BitwardenField };
  }
  if (raw.startsWith("vault://")) {
    const v = VAULT_REF.exec(raw);
    if (!v || [v[1]!, ...v[2]!.split("/")].some((part) => part === "." || part === "..")) {
      return "expected vault://mount/path#field";
    }
    return { kind: "vault", mount: v[1]!, path: v[2]!, field: v[3]! };
  }
  const m = CMD_REF.exec(raw);
  if (!m) return "expected cmd://key";
  return { kind: "command", key: m[1]!.length > 0 ? m[1]! : name };
}

/** What to run for one reference: argv and the child's whole environment. */
export interface SecretRefPlan {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Names the program in messages (`op`, `bw`, the helper's argv[0]). */
  program: string;
  /** How long it may run (ATO-2530: longer for `op` / `bw`, which may wait on Touch ID). */
  timeoutMs: number;
  /**
   * Windows only: argv[4] is a whole `cmd.exe /d /s /c` line, passed as
   * written (`windowsVerbatimArguments`). Set for `bw`, whose npm install
   * is a `bw.cmd` that Node cannot start without a shell.
   */
  verbatim?: boolean;
  /**
   * Windows `bw` only: the folder cmd.exe starts in. cmd.exe looks in its
   * current folder before PATH, so a `bw.cmd` planted in the project the
   * agent runs in would be picked; the home folder is the user's own.
   */
  cwd?: string;
}

/**
 * What a `cmd.exe` line reads literally inside double quotes: no quote,
 * `%` (variable expansion), `^`, `!`, `&`, `|`, `<`, `>` or control
 * characters. A Bitwarden item id (a GUID) and plain names fit.
 */
const CMD_EXE_SAFE = /^[A-Za-z0-9 _.,:@+=()\[\]{}#$'-]+$/;

/**
 * The command for `ref`, or an error string. The child's environment is
 * the filtered shell environment (`buildCommandEnv`: no provider keys),
 * plus the CLI's own session variables (`OP_*` for `op`, `BW_*` for
 * `bw`, `envPassthrough` for the helper) so a signed-in CLI still works.
 */
export function planSecretRef(
  ref: Exclude<SecretRef, { kind: "vault" }>,
  sources: SecretSources,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SecretRefPlan | string {
  const withPrefix = (prefix: string): string[] =>
    Object.keys(env).filter((k) => k.toUpperCase().startsWith(prefix));
  const interactive = sources.timeoutSet === true ? sources.timeoutMs : INTERACTIVE_SECRET_REF_TIMEOUT_MS;
  if (ref.kind === "op") {
    return {
      argv: ["op", "read", ref.ref],
      env: buildCommandEnv(env, withPrefix("OP_")),
      program: "op",
      timeoutMs: interactive,
    };
  }
  if (ref.kind === "bw") {
    const childEnv = buildCommandEnv(env, withPrefix("BW_"));
    if (platform === "win32") {
      // `bw.cmd` needs cmd.exe (Node refuses a .cmd without a shell since
      // CVE-2024-27980). The item is quoted, and anything cmd.exe would
      // still read as syntax inside quotes is refused, not escaped.
      if (!CMD_EXE_SAFE.test(ref.item)) {
        return "on Windows a bw:// item cannot hold quotes or % ^ ! & | < >; use the item id instead (bw list items)";
      }
      const shell = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
      return {
        argv: [shell, "/d", "/s", "/c", `"bw get ${ref.field} "${ref.item}""`],
        // Also tell cmd.exe not to search its current folder at all.
        env: { ...childEnv, NoDefaultCurrentDirectoryInExePath: "1" },
        program: "bw",
        timeoutMs: interactive,
        verbatim: true,
        cwd: homedir(),
      };
    }
    return { argv: ["bw", "get", ref.field, ref.item], env: childEnv, program: "bw", timeoutMs: interactive };
  }
  const command = sources.command;
  if (command === undefined) {
    return `cmd:// needs "command" in ${SECRET_SOURCES_FILE}`;
  }
  return {
    argv: [...command],
    env: { ...buildCommandEnv(env, sources.envPassthrough), [SECRET_KEY_ENV]: ref.key },
    program: command[0]!,
    timeoutMs: sources.timeoutMs,
  };
}

/** No file, or a file that cannot be used: nothing configured. */
export const EMPTY_SECRET_SOURCES: SecretSources = Object.freeze({
  envPassthrough: [],
  timeoutMs: DEFAULT_SECRET_REF_TIMEOUT_MS,
  toolSecrets: {},
}) as SecretSources;

function warnDefault(message: string): void {
  process.stderr.write(`atomic-agent: ${message}\n`);
}

/**
 * Read `<stateDir>/secret-sources.json`. A missing file is the empty
 * default. A file that cannot be parsed, or a field of the wrong shape,
 * is reported on stderr and treated as empty as a whole: fail closed, so
 * no half-read list offers a secret the user did not mean to.
 */
export function readSecretSources(
  stateDir: string,
  warn: (message: string) => void = warnDefault,
): SecretSources {
  const path = join(stateDir, SECRET_SOURCES_FILE);
  if (!existsSync(path)) return EMPTY_SECRET_SOURCES;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn(`${path} is not valid JSON; secret references and tool secrets are off until it is fixed.`);
    return EMPTY_SECRET_SOURCES;
  }
  const problem = (field: string): SecretSources => {
    warn(`${path}: "${field}" has the wrong shape; secret references and tool secrets are off until it is fixed.`);
    return EMPTY_SECRET_SOURCES;
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return problem("(root)");
  const obj = raw as Record<string, unknown>;
  const out: SecretSources = { envPassthrough: [], timeoutMs: DEFAULT_SECRET_REF_TIMEOUT_MS, toolSecrets: {} };
  if (obj.command !== undefined) {
    const c = obj.command;
    if (!Array.isArray(c) || c.length === 0 || c.some((p) => typeof p !== "string" || p.length === 0)) {
      return problem("command");
    }
    out.command = c as string[];
  }
  if (obj.envPassthrough !== undefined) {
    const e = obj.envPassthrough;
    if (!Array.isArray(e) || e.some((p) => typeof p !== "string" || !NAME.test(p))) return problem("envPassthrough");
    out.envPassthrough = e as string[];
  }
  if (obj.timeoutMs !== undefined) {
    const t = obj.timeoutMs;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 100 || t > MAX_SECRET_REF_TIMEOUT_MS) {
      return problem("timeoutMs");
    }
    out.timeoutMs = t;
    out.timeoutSet = true;
  }
  if (obj.toolSecrets !== undefined) {
    const s = obj.toolSecrets;
    if (s === null || typeof s !== "object" || Array.isArray(s)) return problem("toolSecrets");
    for (const [name, ref] of Object.entries(s as Record<string, unknown>)) {
      if (!NAME.test(name) || typeof ref !== "string") return problem(`toolSecrets.${name}`);
      const parsed = parseSecretRef(ref, name);
      // A tool secret is always a reference: a literal here would be a
      // plaintext secret in a second file.
      if (parsed === null || typeof parsed === "string") return problem(`toolSecrets.${name}`);
      out.toolSecrets[name] = ref.trim();
    }
  }
  return out;
}

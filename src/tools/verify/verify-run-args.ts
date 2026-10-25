/**
 * `verify.run` arguments: one shape for a command, a service or a page.
 *
 * Validation errors name the field, because the model reads them: a
 * bare "invalid args" costs a step and teaches nothing.
 */

export type VerifyRunKind = "command" | "service" | "page";

export interface VerifyRequestSpec {
  readonly method?: string;
  /** Relative to the service's base URL (`ready.url` origin or `127.0.0.1:port`). */
  readonly path?: string;
  readonly url?: string;
  readonly body?: string;
  /** Default: any 2xx. */
  readonly expectStatus?: number;
  /** Substring the response body must contain. */
  readonly expectBody?: string;
}

export interface VerifyScriptStep {
  readonly action: "click" | "key" | "type" | "wait";
  readonly selector?: string;
  readonly key?: string;
  readonly text?: string;
  readonly ms?: number;
}

export interface VerifyProbe {
  readonly name: string;
  /** A JavaScript expression evaluated in the page every 250 ms. */
  readonly expr: string;
}

export interface VerifyRunArgs {
  readonly kind: VerifyRunKind;
  /** Relative to the throwaway copy. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** `false` (default): a soft proxy-based block, not a sandbox. */
  readonly network: boolean;
  // command
  readonly cmd?: string;
  readonly args?: readonly string[];
  // service, and optionally page (a server the page is loaded from)
  readonly start?: { readonly cmd: string; readonly args?: readonly string[] };
  readonly ready?: {
    readonly port?: number;
    readonly url?: string;
    readonly timeoutMs: number;
  };
  readonly requests?: readonly VerifyRequestSpec[];
  // page
  readonly path?: string;
  readonly url?: string;
  readonly script?: readonly VerifyScriptStep[];
  readonly seconds: number;
  readonly probes?: readonly VerifyProbe[];
  // any kind
  readonly checks?: readonly string[];
}

export const VERIFY_RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const VERIFY_RUN_MAX_TIMEOUT_MS = 900_000;
export const VERIFY_READY_DEFAULT_TIMEOUT_MS = 30_000;
export const VERIFY_PAGE_DEFAULT_SECONDS = 5;
export const VERIFY_PAGE_MAX_SECONDS = 120;
const MAX_REQUESTS = 32;
const MAX_SCRIPT_STEPS = 64;
const MAX_PROBES = 16;
const MAX_CHECKS = 32;

const KINDS: ReadonlySet<string> = new Set(["command", "service", "page"]);
const ACTIONS: ReadonlySet<string> = new Set(["click", "key", "type", "wait"]);

function fail(message: string): never {
  throw new Error(`verify.run: ${message}`);
}

function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") fail(`\`${field}\` must be a string`);
  return raw;
}

/**
 * An optional string where `""` means "not given": strict native-tools
 * providers send every unused optional field, so a model choosing `url`
 * also sends `path: ""`. Used for a page's `path`/`url`, which must have
 * exactly one side, and for `ready.url`, which `new URL("")` would throw on.
 */
function optionalNonEmptyString(raw: unknown, field: string): string | undefined {
  const value = optionalString(raw, field);
  return value === "" ? undefined : value;
}

function requiredString(raw: unknown, field: string): string {
  const value = optionalString(raw, field);
  if (value === undefined || value.trim().length === 0) {
    fail(`\`${field}\` must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    fail(`\`${field}\` must be an array of strings`);
  }
  return raw as string[];
}

function clampedNumber(
  raw: unknown,
  field: string,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    fail(`\`${field}\` must be a positive number`);
  }
  return Math.min(raw, max);
}

function optionalInteger(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    fail(`\`${field}\` must be an integer`);
  }
  return raw;
}

/**
 * `ready.port`, where `0` means "not given": a default-filled
 * `{port: 0, url: ""}` would otherwise poll port 0, which never answers,
 * until the readiness timeout. Port 0 is never a real readiness port.
 */
function readyPort(raw: unknown): number | undefined {
  const port = optionalInteger(raw, "ready.port");
  return port === 0 ? undefined : port;
}

/**
 * Whether a page's optional `start` was really given. A default-filled
 * `{cmd: "", args: []}` is not a server to start, so a path-only page
 * that carries one stays a plain page.
 */
function startGiven(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "object" || Array.isArray(raw)) return true;
  const cmd = (raw as Record<string, unknown>).cmd;
  return !(cmd === undefined || cmd === null || (typeof cmd === "string" && cmd.trim() === ""));
}

function record(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`\`${field}\` must be an object`);
  }
  return raw as Record<string, unknown>;
}

function list(raw: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(raw)) fail(`\`${field}\` must be an array`);
  if (raw.length > max) fail(`\`${field}\` has ${raw.length} entries; at most ${max}`);
  return raw;
}

function parseEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const env = record(raw, "env");
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") fail(`\`env.${key}\` must be a string`);
  }
  return env as Record<string, string>;
}

function parseRequests(raw: unknown): VerifyRequestSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return list(raw, "requests", MAX_REQUESTS).map((entry, i) => {
    const r = record(entry, `requests[${i}]`);
    // An empty side is a default-filled field only next to a non-empty
    // other side; a lone `path: ""` still means the service root.
    let path = optionalString(r.path, `requests[${i}].path`);
    let url = optionalString(r.url, `requests[${i}].url`);
    if (path === "" && url) path = undefined;
    if (url === "" && path) url = undefined;
    if ((path === undefined) === (url === undefined)) {
      fail(`requests[${i}] needs exactly one of \`path\` or \`url\``);
    }
    return {
      method: optionalString(r.method, `requests[${i}].method`),
      path,
      url,
      body: typeof r.body === "string" || r.body === undefined || r.body === null
        ? (r.body ?? undefined)
        : JSON.stringify(r.body),
      expectStatus: optionalInteger(r.expectStatus, `requests[${i}].expectStatus`),
      expectBody: optionalString(r.expectBody, `requests[${i}].expectBody`),
    };
  });
}

function parseScript(raw: unknown): VerifyScriptStep[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return list(raw, "script", MAX_SCRIPT_STEPS).map((entry, i) => {
    const s = record(entry, `script[${i}]`);
    const action = requiredString(s.action, `script[${i}].action`);
    if (!ACTIONS.has(action)) {
      fail(`script[${i}].action must be one of click, key, type, wait`);
    }
    const step: VerifyScriptStep = {
      action: action as VerifyScriptStep["action"],
      selector: optionalString(s.selector, `script[${i}].selector`),
      key: optionalString(s.key, `script[${i}].key`),
      text: optionalString(s.text, `script[${i}].text`),
      ms: typeof s.ms === "number" ? s.ms : undefined,
    };
    if (action === "click" && step.selector === undefined) fail(`script[${i}] click needs \`selector\``);
    if (action === "key" && step.key === undefined) fail(`script[${i}] key needs \`key\``);
    if (action === "type" && step.text === undefined) fail(`script[${i}] type needs \`text\``);
    if (action === "wait" && step.ms === undefined) fail(`script[${i}] wait needs \`ms\``);
    return step;
  });
}

function parseProbes(raw: unknown): VerifyProbe[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return list(raw, "probes", MAX_PROBES).map((entry, i) => {
    const p = record(entry, `probes[${i}]`);
    return {
      name: requiredString(p.name, `probes[${i}].name`),
      expr: requiredString(p.expr, `probes[${i}].expr`),
    };
  });
}

export function parseVerifyRunArgs(raw: Record<string, unknown>): VerifyRunArgs {
  const kind = requiredString(raw.kind, "kind");
  if (!KINDS.has(kind)) fail("`kind` must be one of command, service, page");
  const base = {
    kind: kind as VerifyRunKind,
    cwd: optionalString(raw.cwd, "cwd"),
    env: parseEnv(raw.env),
    timeoutMs: clampedNumber(raw.timeoutMs, "timeoutMs", VERIFY_RUN_DEFAULT_TIMEOUT_MS, VERIFY_RUN_MAX_TIMEOUT_MS),
    network: raw.network === true,
    seconds: clampedNumber(raw.seconds, "seconds", VERIFY_PAGE_DEFAULT_SECONDS, VERIFY_PAGE_MAX_SECONDS),
    checks: raw.checks === undefined || raw.checks === null
      ? undefined
      : (list(raw.checks, "checks", MAX_CHECKS).map((c, i) => requiredString(c, `checks[${i}]`))),
  };
  if (kind === "command") {
    return { ...base, cmd: requiredString(raw.cmd, "cmd"), args: optionalStringArray(raw.args, "args") ?? [] };
  }
  if (kind === "service") {
    const start = record(raw.start, "start");
    const ready = raw.ready === undefined || raw.ready === null ? {} : record(raw.ready, "ready");
    const port = readyPort(ready.port);
    const url = optionalNonEmptyString(ready.url, "ready.url");
    if (port === undefined && url === undefined) fail("service needs `ready.port` or `ready.url`");
    return {
      ...base,
      start: { cmd: requiredString(start.cmd, "start.cmd"), args: optionalStringArray(start.args, "start.args") ?? [] },
      ready: { port, url, timeoutMs: clampedNumber(ready.timeoutMs, "ready.timeoutMs", VERIFY_READY_DEFAULT_TIMEOUT_MS, VERIFY_RUN_MAX_TIMEOUT_MS) },
      requests: parseRequests(raw.requests) ?? [],
    };
  }
  const path = optionalNonEmptyString(raw.path, "path");
  const url = optionalNonEmptyString(raw.url, "url");
  if ((path === undefined) === (url === undefined)) fail("page needs exactly one of `path` or `url`");
  const page = { ...base, path, url, script: parseScript(raw.script) ?? [], probes: parseProbes(raw.probes) ?? [] };
  if (!startGiven(raw.start)) return page;
  // A page served by its own server: start it, wait until it is ready,
  // then open `url`. Without a wait the browser races the server and
  // gets ERR_CONNECTION_REFUSED.
  if (url === undefined) fail("page with `start` needs `url` (the address the started server serves), not `path`");
  const start = record(raw.start, "start");
  const ready = raw.ready === undefined || raw.ready === null ? {} : record(raw.ready, "ready");
  const port = readyPort(ready.port);
  const readyUrl = optionalNonEmptyString(ready.url, "ready.url");
  return {
    ...page,
    start: { cmd: requiredString(start.cmd, "start.cmd"), args: optionalStringArray(start.args, "start.args") ?? [] },
    ready: {
      port,
      // Default readiness: the page URL itself answers 2xx.
      url: readyUrl ?? (port === undefined ? url : undefined),
      timeoutMs: clampedNumber(ready.timeoutMs, "ready.timeoutMs", VERIFY_READY_DEFAULT_TIMEOUT_MS, VERIFY_RUN_MAX_TIMEOUT_MS),
    },
  };
}

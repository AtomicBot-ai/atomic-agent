/**
 * The `checks` assertion language of `verify.run`.
 *
 *   exit 0 | exit != 0 | exit == 0
 *   stdout contains "x" | stdout not contains "x"     (stderr likewise)
 *   status 200                    every request answered with that status
 *   no errors                     page: no uncaught errors, no console errors
 *   missing selectors 0           page: that many failed lookups
 *   probe <name> decreases | increases
 *   probe <name> equals <v> | reaches <v> | stays <v>
 *
 * Small on purpose: a check is a sentence the brief's author can write
 * and the model can read back. Anything else fails as `unknown check`
 * rather than passing by accident.
 */

export interface CheckOutcome {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What a check may look at — the union of every runner's outcome. */
export interface CheckSubject {
  readonly kind: "command" | "service" | "page";
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  /** Full captured output (capped), not just the tail in the result. */
  readonly stdout?: string;
  readonly stderr?: string;
  readonly requests?: readonly { readonly status: number | null }[];
  readonly errors?: readonly string[];
  readonly consoleErrors?: readonly string[];
  readonly missingSelectors?: readonly string[];
  readonly probes?: Readonly<Record<string, readonly (readonly [number, unknown])[]>>;
}

const PROBE_OPS: ReadonlySet<string> = new Set(["decreases", "increases", "equals", "reaches", "stays"]);

/** Split on whitespace, keeping double- or single-quoted runs whole. */
export function tokenizeCheck(spec: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  for (const m of spec.matchAll(re)) {
    const quoted = m[1] ?? m[2];
    tokens.push(quoted === undefined ? m[3]! : quoted.replace(/\\(.)/g, "$1"));
  }
  return tokens;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function outcome(check: string, ok: boolean, detail: string): CheckOutcome {
  return { check, ok, detail };
}

function checkExit(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const [, a, b] = tokens;
  const negated = a === "!=";
  const wanted = Number.parseInt((negated || a === "==" ? b : a) ?? "", 10);
  if (!Number.isInteger(wanted)) return outcome(check, false, "unknown check: expected `exit <code>`");
  if (s.exitCode === undefined) return outcome(check, false, `no exit code for a ${s.kind} run`);
  const actual = s.exitCode === null ? (s.timedOut ? "killed (timed out)" : "killed by signal") : `exit ${s.exitCode}`;
  const ok = negated ? s.exitCode !== wanted : s.exitCode === wanted;
  return outcome(check, ok, actual);
}

function checkStream(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const stream = tokens[0] as "stdout" | "stderr";
  const negated = tokens[1] === "not";
  const verb = negated ? tokens[2] : tokens[1];
  const needle = negated ? tokens[3] : tokens[2];
  if (verb !== "contains" || needle === undefined) {
    return outcome(check, false, `unknown check: expected \`${stream} [not] contains "x"\``);
  }
  const text = s[stream];
  if (text === undefined) return outcome(check, false, `no ${stream} for a ${s.kind} run`);
  const found = text.includes(needle);
  return outcome(check, negated ? !found : found, found ? `${stream} contains ${show(needle)}` : `${stream} does not contain ${show(needle)}`);
}

function checkStatus(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const wanted = Number.parseInt(tokens[1] ?? "", 10);
  if (!Number.isInteger(wanted)) return outcome(check, false, "unknown check: expected `status <code>`");
  if (s.requests === undefined || s.requests.length === 0) return outcome(check, false, "no requests were made");
  const statuses = s.requests.map((r) => r.status ?? "no response");
  const ok = statuses.every((st) => st === wanted);
  return outcome(check, ok, `statuses: ${statuses.join(", ")}`);
}

function checkNoErrors(check: string, s: CheckSubject): CheckOutcome {
  if (s.kind !== "page") return outcome(check, false, "`no errors` applies to page runs");
  const errors = s.errors?.length ?? 0;
  const consoleErrors = s.consoleErrors?.length ?? 0;
  return outcome(check, errors === 0 && consoleErrors === 0, `${errors} uncaught error(s), ${consoleErrors} console error(s)`);
}

function checkMissing(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const wanted = Number.parseInt(tokens[2] ?? "", 10);
  if (tokens[1] !== "selectors" || !Number.isInteger(wanted)) {
    return outcome(check, false, "unknown check: expected `missing selectors <n>`");
  }
  if (s.missingSelectors === undefined) return outcome(check, false, "selector lookups are recorded for page runs only");
  const list = s.missingSelectors;
  return outcome(check, list.length === wanted, list.length === 0 ? "no failed lookups" : `${list.length} failed lookup(s): ${list.slice(0, 5).join(", ")}`);
}

function checkProbe(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const [, name, op, rawValue] = tokens;
  if (name === undefined || op === undefined || !PROBE_OPS.has(op)) {
    return outcome(check, false, "unknown check: expected `probe <name> decreases|increases|equals <v>|reaches <v>|stays <v>`");
  }
  const samples = s.probes?.[name];
  if (samples === undefined) return outcome(check, false, `no probe named ${JSON.stringify(name)}`);
  const values = samples.map(([, v]) => v);
  if (values.length === 0) return outcome(check, false, `probe ${name} has no samples`);
  const first = values[0];
  const last = values[values.length - 1];
  const trend = `${name}: ${show(first)} → ${show(last)} over ${values.length} samples`;
  if (op === "decreases" || op === "increases") {
    if (typeof first !== "number" || typeof last !== "number") return outcome(check, false, `${trend} (not numeric)`);
    return outcome(check, op === "decreases" ? last < first : last > first, trend);
  }
  if (rawValue === undefined) return outcome(check, false, `unknown check: \`probe ${name} ${op}\` needs a value`);
  const wanted = parseValue(rawValue);
  if (op === "equals") return outcome(check, same(last, wanted), `${name} ended at ${show(last)}`);
  if (op === "reaches") {
    const hit = values.findIndex((v) => same(v, wanted));
    return outcome(check, hit !== -1, hit === -1 ? `${name} never reached ${show(wanted)} (${trend})` : `${name} reached ${show(wanted)} at sample ${hit}`);
  }
  if (op === "stays") {
    const off = values.findIndex((v) => !same(v, wanted));
    return outcome(check, off === -1, off === -1 ? `${name} stayed ${show(wanted)}` : `${name} was ${show(values[off])} at sample ${off}`);
  }
  return outcome(check, false, `unknown check: probe op ${show(op)}`);
}

export function evaluateCheck(spec: string, subject: CheckSubject): CheckOutcome {
  const check = spec.trim();
  const tokens = tokenizeCheck(check);
  switch (tokens[0]) {
    case "exit":
      return checkExit(check, tokens, subject);
    case "stdout":
    case "stderr":
      return checkStream(check, tokens, subject);
    case "status":
      return checkStatus(check, tokens, subject);
    case "no":
      return tokens[1] === "errors" && tokens.length === 2 ? checkNoErrors(check, subject) : outcome(check, false, "unknown check");
    case "missing":
      return checkMissing(check, tokens, subject);
    case "probe":
      return checkProbe(check, tokens, subject);
    default:
      return outcome(check, false, "unknown check");
  }
}

export function evaluateChecks(
  specs: readonly string[],
  subject: CheckSubject,
): CheckOutcome[] {
  return specs.map((spec) => evaluateCheck(spec, subject));
}

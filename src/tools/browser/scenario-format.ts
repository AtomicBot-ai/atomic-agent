import type { PageActionInput } from "./browser-backend.js";
import { parseAriaNode, splitSnapshotText } from "./compact-aria.js";

/**
 * Browser scenarios (ATO-960): a recorded run of browser steps that
 * `browser.scenario { action: "run" }` replays without the model. This
 * file holds the on-disk format and the element lookup; it is pure (no
 * backend, no file system).
 *
 * Steps name their element by ARIA role and accessible name, never by a
 * ref (refs die with the page), the way Playwright codegen writes
 * `getByRole(role, { name })`. Text typed into a password, one-time-code
 * or card field is never stored: the step names a parameter instead,
 * and the value is supplied at replay.
 */

export const SCENARIO_VERSION = 1;
export const MAX_SCENARIO_STEPS = 200;
const MAX_TEXT_CHARS = 2_000;
const MAX_NAME_CHARS = 500;

/** `check-prices`, `daily_report`: lowercase letters, digits, `-` and `_`. */
const SCENARIO_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The element a step acts on, as the ARIA snapshot names it. */
export interface ScenarioTarget {
  role: string;
  name: string;
}

interface StepBase {
  /**
   * Page the step ran on when it was recorded. On replay a step that acts
   * on a page stops (`origin_changed`) unless the browser is on this URL's
   * origin (scheme, host, port); the path may differ.
   */
  url?: string;
  /** Digest of that page's snapshot when it was recorded (informational, never checked). */
  pageDigest?: string;
}

export interface NavigateStep extends StepBase {
  kind: "navigate";
  url: string;
}

export interface SearchStep extends StepBase {
  kind: "search";
  query: string;
  engine?: "google" | "duckduckgo" | "bing";
}

export interface ClickStep extends StepBase {
  kind: "click";
  target: ScenarioTarget;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
}

/** Exactly one of `text` (typed as is) and `param` (supplied at replay). */
export interface TypeStep extends StepBase {
  kind: "type";
  target: ScenarioTarget;
  text?: string;
  param?: string;
  pressEnter?: boolean;
  clearFirst?: boolean;
}

/** A `browser.act` call without its ref; `target` stands in for the ref when it had one. */
export type ScenarioPageAction = DistributiveOmit<
  Exclude<PageActionInput, { action: "upload" }>,
  "ref"
>;

export interface ActStep extends StepBase {
  kind: "act";
  action: ScenarioPageAction;
  target?: ScenarioTarget;
}

export type ScenarioStep = NavigateStep | SearchStep | ClickStep | TypeStep | ActStep;

export interface ScenarioParam {
  name: string;
  /** Typed into a password / one-time-code / card field: never stored, always asks at replay. */
  secret: boolean;
}

export interface Scenario {
  version: typeof SCENARIO_VERSION;
  name: string;
  createdAt: string;
  params: ScenarioParam[];
  steps: ScenarioStep[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** `"Check prices"` → `check-prices`; `null` when nothing usable is left. */
export function normalizeScenarioName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return SCENARIO_NAME.test(name) ? name : null;
}

export function isParamName(value: unknown): value is string {
  return typeof value === "string" && PARAM_NAME.test(value);
}

/** A parameter name from a field label: `"E-mail address"` → `e_mail_address`. */
export function paramNameFrom(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+$/, "")
      .slice(0, 32) || "value";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}

/** Short label for messages: `click button "Search"`. */
export function describeStep(step: ScenarioStep): string {
  const target = (t: ScenarioTarget | undefined) =>
    t === undefined ? "" : ` ${t.role}${t.name ? ` "${clip(t.name, 60)}"` : ""}`;
  switch (step.kind) {
    case "navigate":
      return `navigate to ${clip(step.url, 120)}`;
    case "search":
      return `search "${clip(step.query, 60)}"`;
    case "click":
      return `click${target(step.target)}`;
    case "type":
      return `type ${step.param !== undefined ? `{{${step.param}}}` : `${step.text?.length ?? 0} chars`} into${target(step.target)}${step.pressEnter ? ", then Enter" : ""}`;
    case "act":
      return `${step.action.action}${target(step.target)}`;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Element lookup ("self-healing lite")

export type TargetMatch =
  | { kind: "found"; ref: string; how: "exact" | "normalized" }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number };

export function normalizeAccessibleName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

interface RefNode {
  ref: string;
  role: string;
  name: string;
}

function refNodes(snapshotText: string): RefNode[] {
  const out: RefNode[] = [];
  splitSnapshotText(snapshotText).body.forEach((line, index) => {
    const node = parseAriaNode(line, index);
    if (node?.ref) out.push({ ref: node.ref, role: node.role, name: node.name ?? "" });
  });
  return out;
}

/** Role and name of `ref` in a snapshot, or `null` when the ref is not in it. */
export function targetOfRef(snapshotText: string, ref: string): ScenarioTarget | null {
  const node = refNodes(snapshotText).find((n) => n.ref === ref);
  return node ? { role: node.role, name: node.name } : null;
}

/**
 * Find the element a step names in the current snapshot: same role and
 * exactly the same name first, then the same role and a name equal after
 * collapsing spaces and case. One match is the element; none or several
 * stop the replay at that step (the model or the user takes over).
 */
export function findTarget(snapshotText: string, target: ScenarioTarget): TargetMatch {
  const sameRole = refNodes(snapshotText).filter((n) => n.role === target.role);
  const exact = sameRole.filter((n) => n.name === target.name);
  if (exact.length === 1) return { kind: "found", ref: exact[0]!.ref, how: "exact" };
  if (exact.length > 1) return { kind: "ambiguous", count: exact.length };
  const wanted = normalizeAccessibleName(target.name);
  const loose = sameRole.filter((n) => normalizeAccessibleName(n.name) === wanted);
  if (loose.length === 1) return { kind: "found", ref: loose[0]!.ref, how: "normalized" };
  if (loose.length > 1) return { kind: "ambiguous", count: loose.length };
  return { kind: "missing" };
}

// ---------------------------------------------------------------------------
// Parsing a stored file (it may have been edited by hand)

function bad(message: string): never {
  throw new Error(`browser scenario file: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) bad(`\`${field}\` must be a string of at most ${max} characters`);
  return value;
}

function optionalStr(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : str(value, field, max);
}

function parseTarget(value: unknown, i: number): ScenarioTarget {
  if (!isRecord(value)) bad(`step ${i + 1}: \`target\` must be { role, name }`);
  const role = str(value.role, `steps[${i}].target.role`, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(role)) bad(`step ${i + 1}: bad role`);
  return { role, name: str(value.name, `steps[${i}].target.name`, MAX_NAME_CHARS) };
}

function base(raw: Record<string, unknown>, i: number): StepBase {
  const url = optionalStr(raw.url, `steps[${i}].url`, 4_000);
  const pageDigest = optionalStr(raw.pageDigest, `steps[${i}].pageDigest`, 200);
  return { ...(url !== undefined ? { url } : {}), ...(pageDigest !== undefined ? { pageDigest } : {}) };
}

const ACT_ACTIONS = new Set(["select", "back", "forward", "key", "hover", "dialog", "wait"]);
const ACT_KEYS = new Set(["action", "values", "key", "accept", "text", "state", "ms", "timeoutMs"]);

function parseStep(raw: unknown, i: number): ScenarioStep {
  if (!isRecord(raw)) bad(`step ${i + 1} must be an object`);
  switch (raw.kind) {
    case "navigate":
      return { ...base(raw, i), kind: "navigate", url: str(raw.url, `steps[${i}].url`, 4_000) };
    case "search": {
      const engine = raw.engine;
      if (engine !== undefined && engine !== "google" && engine !== "duckduckgo" && engine !== "bing") {
        bad(`step ${i + 1}: unknown search engine`);
      }
      return {
        ...base(raw, i),
        kind: "search",
        query: str(raw.query, `steps[${i}].query`, MAX_TEXT_CHARS),
        ...(engine !== undefined ? { engine } : {}),
      };
    }
    case "click": {
      const step: ClickStep = { ...base(raw, i), kind: "click", target: parseTarget(raw.target, i) };
      if (raw.button === "left" || raw.button === "right" || raw.button === "middle") step.button = raw.button;
      if (Array.isArray(raw.modifiers)) {
        const allowed = ["Alt", "Control", "Meta", "Shift"] as const;
        const mods = raw.modifiers.filter((m): m is (typeof allowed)[number] => allowed.includes(m as never));
        if (mods.length > 0) step.modifiers = mods;
      }
      return step;
    }
    case "type": {
      const text = optionalStr(raw.text, `steps[${i}].text`, MAX_TEXT_CHARS);
      const param = raw.param;
      if ((text === undefined) === (param === undefined)) bad(`step ${i + 1}: a type step has either \`text\` or \`param\``);
      if (param !== undefined && !isParamName(param)) bad(`step ${i + 1}: bad parameter name`);
      return {
        ...base(raw, i),
        kind: "type",
        target: parseTarget(raw.target, i),
        ...(text !== undefined ? { text } : {}),
        ...(param !== undefined ? { param } : {}),
        ...(raw.pressEnter === true ? { pressEnter: true } : {}),
        ...(raw.clearFirst === true ? { clearFirst: true } : {}),
      };
    }
    case "act": {
      const action = raw.action;
      if (!isRecord(action) || typeof action.action !== "string" || !ACT_ACTIONS.has(action.action)) {
        bad(`step ${i + 1}: \`action.action\` must be one of ${[...ACT_ACTIONS].join("|")}`);
      }
      for (const key of Object.keys(action)) {
        if (!ACT_KEYS.has(key)) bad(`step ${i + 1}: unexpected \`action.${key}\``);
      }
      // The values themselves are checked again by browser.act on replay.
      return {
        ...base(raw, i),
        kind: "act",
        action: action as unknown as ScenarioPageAction,
        ...(raw.target !== undefined ? { target: parseTarget(raw.target, i) } : {}),
      };
    }
    default:
      return bad(`step ${i + 1}: unknown kind ${JSON.stringify(raw.kind)}`);
  }
}

/** Parse and check a scenario read from disk; throws with the reason. */
export function parseScenario(value: unknown): Scenario {
  if (!isRecord(value)) bad("not a JSON object");
  if (value.version !== SCENARIO_VERSION) bad(`unsupported version ${JSON.stringify(value.version)}`);
  const name = normalizeScenarioName(value.name);
  if (name === null) bad("bad `name`");
  if (!Array.isArray(value.steps) || value.steps.length === 0) bad("`steps` must be a non-empty list");
  if (value.steps.length > MAX_SCENARIO_STEPS) bad(`more than ${MAX_SCENARIO_STEPS} steps`);
  const steps = value.steps.map(parseStep);
  const params = scenarioParams(steps, Array.isArray(value.params) ? value.params : []);
  return {
    version: SCENARIO_VERSION,
    name,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    params,
    steps,
  };
}

/**
 * The parameters the steps use, in first-use order. A parameter is
 * secret when the file says so; the recorder marks the ones it made for
 * secret fields.
 */
export function scenarioParams(steps: readonly ScenarioStep[], declared: readonly unknown[] = []): ScenarioParam[] {
  const secret = new Set<string>();
  for (const entry of declared) {
    if (isRecord(entry) && isParamName(entry.name) && entry.secret === true) secret.add(entry.name);
  }
  const seen = new Set<string>();
  const out: ScenarioParam[] = [];
  for (const step of steps) {
    if (step.kind !== "type" || step.param === undefined || seen.has(step.param)) continue;
    seen.add(step.param);
    out.push({ name: step.param, secret: secret.has(step.param) });
  }
  return out;
}

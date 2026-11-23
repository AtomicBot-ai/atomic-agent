import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import { BROWSER_PAGE_SOURCE } from "../untrusted-tool-output.js";
import type { BrowserBackend } from "./browser-backend.js";
import {
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import type { AriaSnapshotStore } from "./aria-view.js";
import { captureWorldSnapshot } from "./capture-world-snapshot.js";
import {
  SCENARIO_VERSION,
  describeStep,
  findTarget,
  isParamName,
  normalizeScenarioName,
  scenarioParams,
  type Scenario,
  type ScenarioStep,
  type ScenarioTarget,
  type TargetMatch,
} from "./scenario-format.js";
import type { ScenarioRecorder } from "./scenario-recorder.js";
import type { ScenarioStore } from "./scenario-store.js";

export const BROWSER_SCENARIO_TOOL = "browser.scenario";
const TOOL = BROWSER_SCENARIO_TOOL;

export const SCENARIO_ACTIONS = ["start", "stop", "cancel", "run", "list", "delete"] as const;
type ScenarioAction = (typeof SCENARIO_ACTIONS)[number];

/** How long a replay step waits for its element to show up. */
export const DEFAULT_STEP_TIMEOUT_MS = 5_000;
export const MAX_STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

/** The browser tools a replay calls: the same ones the model calls, with all their gates. */
export interface ScenarioReplayTools {
  navigate: ToolDefinition;
  search: ToolDefinition;
  click: ToolDefinition;
  type: ToolDefinition;
  act: ToolDefinition;
}

export interface BrowserScenarioDeps {
  backend: BrowserBackend;
  recorder: ScenarioRecorder;
  store: ScenarioStore;
  tools: ScenarioReplayTools;
  policy?: BrowserDomainPolicy;
  ariaStore?: AriaSnapshotStore;
  /** Test seam for the element wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * `browser.scenario` (ATO-960): record the browser steps of a chat once,
 * replay them later without the model.
 *
 *  - `start` / `stop { name, params? }` / `cancel`: record this chat's
 *    successful navigate / search / click / type / act calls
 *    (`scenario-recorder.ts`) and save them as `<name>`. `params` turns
 *    typed text into a parameter: `{ "query": "running shoes" }` makes
 *    every step that typed "running shoes" type `{{query}}` instead.
 *    Text typed into a secret field is never saved; it becomes a
 *    parameter on its own.
 *  - `run { name, params? }`: replay. Each step's element is looked up by
 *    role and name in the page's ARIA snapshot (exact, then ignoring
 *    case and spaces), waiting up to `timeoutMs` for it to appear. None
 *    or several matches stop the replay at that step with an error that
 *    names it. Every step goes through the real browser tool, so the
 *    approval gates, the domain lists and offline mode apply exactly as
 *    when the model calls them.
 *  - `list`, `delete { name }`.
 */
export function buildBrowserScenarioTool(deps: BrowserScenarioDeps): ToolDefinition {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const policy = deps.policy ?? EMPTY_DOMAIN_POLICY;
  return {
    name: TOOL,
    description:
      "Record browser steps once and replay them without the model: start recording, stop with a name to save, run a saved scenario (params fill {{placeholders}}), list, delete.",
    readonly: false,
    // Step labels carry element names read from pages (ATO-1378).
    untrustedOutput: BROWSER_PAGE_SOURCE,
    async run(rawArgs, ctx) {
      const action = rawArgs.action;
      if (typeof action !== "string" || !(SCENARIO_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`${TOOL}: \`action\` must be one of ${SCENARIO_ACTIONS.join("|")}`);
      }
      switch (action as ScenarioAction) {
        case "start":
          return start(deps, rawArgs, ctx);
        case "stop":
          return stop(deps, rawArgs, ctx);
        case "cancel": {
          const taken = deps.recorder.take(ctx.sessionId);
          return ok(taken ? `recording discarded (${taken.steps.length} steps)` : "no recording was on", { action });
        }
        case "list":
          return list(deps);
        case "delete": {
          const name = requireName(rawArgs.name);
          const removed = await deps.store.delete(name);
          return removed
            ? ok(`deleted scenario "${name}"`, { action, name })
            : error(`no scenario named "${name}"`, { action, name, reason: "not_found" });
        }
        case "run":
          return replay(deps, rawArgs, ctx, { sleep, now, policy });
      }
    },
  };
}

function ok(output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: TOOL, status: "ok", output, details });
}

function error(output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: TOOL, status: "error", output, details });
}

function requireName(raw: unknown): string {
  const name = normalizeScenarioName(raw);
  if (name === null) {
    throw new Error(`${TOOL}: \`name\` must be 1-64 letters, digits, "-" or "_" (e.g. "check-prices")`);
  }
  return name;
}

function readParams(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${TOOL}: \`params\` must be an object of parameter name to text`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isParamName(key)) {
      throw new Error(`${TOOL}: parameter names are lowercase letters, digits and "_", starting with a letter (got "${key}")`);
    }
    if (typeof value !== "string") throw new Error(`${TOOL}: parameter "${key}" must be a string`);
    out[key] = value;
  }
  return out;
}

function start(
  deps: BrowserScenarioDeps,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "sessionId">,
): CompressedToolResult {
  const name = args.name === undefined || args.name === null || args.name === "" ? undefined : requireName(args.name);
  const { restarted } = deps.recorder.start(ctx.sessionId, name);
  return ok(
    `${restarted ? "previous recording discarded; " : ""}recording this chat's browser steps (navigate, search, click, type, act). Do the task once, then call browser.scenario stop${name ? "" : " with a name"} to save it.`,
    { action: "start", ...(name !== undefined ? { name } : {}) },
  );
}

async function stop(
  deps: BrowserScenarioDeps,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "sessionId">,
): Promise<CompressedToolResult> {
  const recording = deps.recorder.active(ctx.sessionId);
  if (recording === undefined) {
    return error("no recording is on; call browser.scenario start first", { action: "stop", reason: "not_recording" });
  }
  const name = args.name === undefined || args.name === null || args.name === "" ? recording.name : requireName(args.name);
  if (name === undefined) throw new Error(`${TOOL}: stop needs \`name\` to save the recording under`);
  const literals = readParams(args.params);
  deps.recorder.take(ctx.sessionId);
  if (recording.steps.length === 0) {
    return error("nothing was recorded; the recording is discarded", { action: "stop", name, reason: "empty" });
  }
  const steps = recording.steps.map((step): ScenarioStep => {
    if (step.kind !== "type" || step.text === undefined) return step;
    const param = Object.entries(literals).find(([, literal]) => literal === step.text)?.[0];
    if (param === undefined) return step;
    const { text: _text, ...rest } = step;
    return { ...rest, param };
  });
  const scenario: Scenario = {
    version: SCENARIO_VERSION,
    name,
    createdAt: new Date().toISOString(),
    params: scenarioParams(
      steps,
      [...recording.secretParams].map((param) => ({ name: param, secret: true })),
    ),
    steps,
  };
  const { replaced } = await deps.store.save(scenario);
  const params = scenario.params.map((p) => (p.secret ? `${p.name} (secret)` : p.name));
  const lines = [
    `${replaced ? "replaced" : "saved"} scenario "${name}": ${steps.length} step${steps.length === 1 ? "" : "s"}`,
    ...(params.length > 0 ? [`params: ${params.join(", ")}`] : []),
    ...steps.map((step, i) => `${i + 1}. ${describeStep(step)}`),
    ...recording.notes,
  ];
  return ok(lines.join("\n"), {
    action: "stop",
    name,
    steps: steps.length,
    params: scenario.params,
    replaced,
    ...(recording.notes.length > 0 ? { notes: recording.notes } : {}),
  });
}

async function list(deps: BrowserScenarioDeps): Promise<CompressedToolResult> {
  const entries = await deps.store.list();
  if (entries.length === 0) return ok("no saved browser scenarios", { action: "list", scenarios: [] });
  const lines = entries.map((entry) => {
    if (entry.scenario === undefined) return `${entry.name}: unreadable (${entry.error ?? "unknown error"})`;
    const s = entry.scenario;
    const params = s.params.length > 0 ? `, params: ${s.params.map((p) => p.name).join(", ")}` : "";
    const first = s.steps[0];
    return `${s.name}: ${s.steps.length} steps${params}${first ? `, starts with ${describeStep(first)}` : ""}`;
  });
  return ok(lines.join("\n"), {
    action: "list",
    scenarios: entries.map((entry) => ({
      name: entry.name,
      ...(entry.scenario ? { steps: entry.scenario.steps.length, params: entry.scenario.params } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    })),
  });
}

interface ReplayEnv {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  policy: BrowserDomainPolicy;
}

function readTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_STEP_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`${TOOL}: \`timeoutMs\` must be a number of milliseconds`);
  }
  return Math.min(Math.trunc(raw), MAX_STEP_TIMEOUT_MS);
}

async function waitForTarget(
  backend: BrowserBackend,
  target: ScenarioTarget,
  timeoutMs: number,
  env: ReplayEnv,
  signal: AbortSignal,
): Promise<TargetMatch> {
  const deadline = env.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const snapshot = await backend.snapshot({ full: true });
    const match = findTarget(snapshot.text, target);
    // Several matches will not sort themselves out by waiting.
    if (match.kind !== "missing" || env.now() >= deadline) return match;
    await env.sleep(POLL_MS);
  }
}

function callFor(
  step: ScenarioStep,
  ref: string | undefined,
  params: Record<string, string>,
): { tool: keyof ScenarioReplayTools; args: Record<string, unknown> } {
  switch (step.kind) {
    case "navigate":
      return { tool: "navigate", args: { url: step.url } };
    case "search":
      return { tool: "search", args: { query: step.query, ...(step.engine ? { engine: step.engine } : {}) } };
    case "click":
      return {
        tool: "click",
        args: {
          ref,
          ...(step.button ? { button: step.button } : {}),
          ...(step.modifiers ? { modifiers: step.modifiers } : {}),
        },
      };
    case "type":
      return {
        tool: "type",
        args: {
          ref,
          text: step.param !== undefined ? params[step.param] : step.text,
          ...(step.pressEnter ? { pressEnter: true } : {}),
          ...(step.clearFirst ? { clearFirst: true } : {}),
        },
      };
    case "act":
      return { tool: "act", args: { ...step.action, ...(ref !== undefined ? { ref } : {}) } };
  }
}

/** `scheme://host:port` of a web URL, or `null` for anything else (`about:blank`, junk). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

async function replay(
  deps: BrowserScenarioDeps,
  args: Record<string, unknown>,
  ctx: ToolContext,
  env: ReplayEnv,
): Promise<CompressedToolResult> {
  const name = requireName(args.name);
  const params = readParams(args.params);
  const timeoutMs = readTimeout(args.timeoutMs);
  let scenario: Scenario | null;
  try {
    scenario = await deps.store.load(name);
  } catch (e) {
    return error(`scenario "${name}" cannot be read: ${e instanceof Error ? e.message : String(e)}`, {
      action: "run",
      name,
      reason: "unreadable",
    });
  }
  if (scenario === null) return error(`no scenario named "${name}"; browser.scenario list shows the saved ones`, { action: "run", name, reason: "not_found" });
  const missing = scenario.params.filter((p) => params[p.name] === undefined).map((p) => p.name);
  if (missing.length > 0) {
    return error(`scenario "${name}" needs params: ${missing.join(", ")}`, { action: "run", name, reason: "missing_params", missing });
  }
  await deps.backend.ensureReady();
  const total = scenario.steps.length;
  const healed: number[] = [];
  for (let i = 0; i < total; i += 1) {
    const step = scenario.steps[i]!;
    const label = `step ${i + 1} of ${total} (${describeStep(step)})`;
    const stopped = (why: string, reason: string, extra: Record<string, unknown> = {}) =>
      error(`scenario "${name}" stopped at ${label}: ${why}. Steps before it ran; continue by hand from here.`, {
        action: "run",
        name,
        failedStep: i + 1,
        completedSteps: i,
        reason,
        ...extra,
      });
    // Without a model watching, nothing else notices that a redirect or a
    // changed site put the replay on another site: a plain text step would
    // type the recorded text (an email, an address) into that site's page.
    // So a step that acts on a page must be on the site it was recorded on.
    if (step.kind !== "navigate" && step.kind !== "search" && step.url !== undefined) {
      const recorded = originOf(step.url);
      if (recorded !== null) {
        let here: string | null = null;
        try {
          here = originOf(await deps.backend.currentUrl());
        } catch {
          here = null;
        }
        if (here !== recorded) {
          return stopped(`the page is on ${here ?? "an unknown page"}, the step was recorded on ${recorded}`, "origin_changed", {
            recordedOrigin: recorded,
            ...(here !== null ? { origin: here } : {}),
          });
        }
      }
    }
    let ref: string | undefined;
    const target = "target" in step ? step.target : undefined;
    if (target !== undefined) {
      const match = await waitForTarget(deps.backend, target, timeoutMs, env, ctx.signal);
      if (match.kind === "missing") {
        return stopped(`no ${target.role} named "${target.name}" on the page after ${timeoutMs} ms`, "target_missing");
      }
      if (match.kind === "ambiguous") {
        return stopped(`${match.count} elements are ${target.role} "${target.name}"; cannot tell which one`, "target_ambiguous", { matches: match.count });
      }
      ref = match.ref;
      if (match.how === "normalized") healed.push(i + 1);
    }
    const call = callFor(step, ref, params);
    let result: CompressedToolResult;
    try {
      result = await deps.tools[call.tool].run(call.args, ctx);
    } catch (e) {
      // A "no" at an approval prompt, or a cancelled turn, ends the run
      // the way it ends a model's call.
      if (e instanceof ApprovalDeniedError || ctx.signal.aborted) throw e;
      return stopped(e instanceof Error ? e.message : String(e), "step_threw");
    }
    if (result.status !== "ok") {
      return stopped(`${result.tool} said: ${result.summary}`, "step_failed", {
        ...(typeof result.details.reason === "string" ? { stepReason: result.details.reason } : {}),
      });
    }
  }
  const worldSnapshot = await captureWorldSnapshot(deps.backend, ctx, env.policy, deps.ariaStore);
  let url: string | undefined;
  try {
    url = await deps.backend.currentUrl();
  } catch {
    url = undefined;
  }
  return ok(
    `ran scenario "${name}": ${total} step${total === 1 ? "" : "s"}${url ? `, now on ${url}` : ""}${healed.length > 0 ? ` (found by a looser name match at step ${healed.join(", ")})` : ""}`,
    {
      action: "run",
      name,
      completedSteps: total,
      ...(url ? { url } : {}),
      ...(healed.length > 0 ? { looseMatches: healed } : {}),
      ...(worldSnapshot ? { worldSnapshot } : {}),
    },
  );
}

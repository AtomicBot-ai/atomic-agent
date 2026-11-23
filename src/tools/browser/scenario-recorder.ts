import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import { classifyBrowserAction } from "./classify-browser-action.js";
import { parsePageAction } from "./page-action-args.js";
import {
  MAX_SCENARIO_STEPS,
  findTarget,
  paramNameFrom,
  targetOfRef,
  type ClickStep,
  type ScenarioPageAction,
  type ScenarioStep,
  type ScenarioTarget,
} from "./scenario-format.js";

/** The browser tools whose successful calls become scenario steps. */
export const RECORDED_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "browser.navigate",
  "browser.search",
  "browser.click",
  "browser.type",
  "browser.act",
]);

export interface Recording {
  name?: string;
  steps: ScenarioStep[];
  /** Parameters made for secret fields while recording. */
  secretParams: Set<string>;
  /** Calls that were not recorded, or steps that may not replay, said at stop. */
  notes: string[];
}

type Prepared = { step: ScenarioStep; secretParam?: string; note?: string } | { skip: string };

/**
 * Records a session's browser steps while `browser.scenario start` is on
 * (ATO-960). It wraps the browser tools: before a call it reads what the
 * call's `ref` is (role and name from the page's ARIA snapshot; for
 * `type`, whether the field is a secret one), lets the tool run with all
 * its own gates, and keeps the step only when the call came back ok.
 * Sessions that are not recording pay nothing.
 */
export class ScenarioRecorder {
  private readonly recordings = new Map<string, Recording>();

  constructor(private readonly backend: BrowserBackend) {}

  start(sessionId: string, name?: string): { restarted: boolean } {
    const restarted = this.recordings.has(sessionId);
    this.recordings.set(sessionId, {
      ...(name !== undefined ? { name } : {}),
      steps: [],
      secretParams: new Set(),
      notes: [],
    });
    return { restarted };
  }

  active(sessionId: string): Recording | undefined {
    return this.recordings.get(sessionId);
  }

  /** Ends the recording and hands it over; `undefined` when none was on. */
  take(sessionId: string): Recording | undefined {
    const recording = this.recordings.get(sessionId);
    this.recordings.delete(sessionId);
    return recording;
  }

  wrap(tool: ToolDefinition): ToolDefinition {
    if (!RECORDED_BROWSER_TOOLS.has(tool.name)) return tool;
    return {
      ...tool,
      run: async (args, ctx) => {
        const recording = this.recordings.get(ctx.sessionId);
        if (recording === undefined) return tool.run(args, ctx);
        const prepared = await this.prepare(tool.name, args, recording).catch(
          (error: unknown): Prepared => ({
            skip: `a ${tool.name} call (${error instanceof Error ? error.message : String(error)})`,
          }),
        );
        const result = await tool.run(args, ctx);
        if (result.status !== "ok" || this.recordings.get(ctx.sessionId) !== recording) return result;
        if ("skip" in prepared) {
          recording.notes.push(`not recorded: ${prepared.skip}`);
        } else if (recording.steps.length >= MAX_SCENARIO_STEPS) {
          recording.notes.push(`not recorded: more than ${MAX_SCENARIO_STEPS} steps`);
        } else {
          recording.steps.push(prepared.step);
          if (prepared.secretParam !== undefined) recording.secretParams.add(prepared.secretParam);
          if (prepared.note !== undefined) recording.notes.push(`step ${recording.steps.length}: ${prepared.note}`);
        }
        return result;
      },
    };
  }

  private async prepare(
    tool: string,
    args: Record<string, unknown>,
    recording: Recording,
  ): Promise<Prepared> {
    switch (tool) {
      case "browser.navigate":
        return typeof args.url === "string" ? { step: { kind: "navigate", url: args.url } } : { skip: "a navigate without a url" };
      case "browser.search": {
        if (typeof args.query !== "string") return { skip: "a search without a query" };
        const engine = args.engine;
        return {
          step: {
            kind: "search",
            query: args.query,
            ...(engine === "google" || engine === "duckduckgo" || engine === "bing" ? { engine } : {}),
          },
        };
      }
      case "browser.click": {
        const at = await this.locate(args.ref);
        if ("skip" in at) return at;
        const step: ClickStep = { ...at.base, kind: "click", target: at.target };
        if (args.button === "left" || args.button === "right" || args.button === "middle") step.button = args.button;
        if (Array.isArray(args.modifiers)) {
          const allowed = ["Alt", "Control", "Meta", "Shift"] as const;
          const mods = args.modifiers.filter((m): m is (typeof allowed)[number] => allowed.includes(m as never));
          if (mods.length > 0) step.modifiers = mods;
        }
        return { step, ...(at.note !== undefined ? { note: at.note } : {}) };
      }
      case "browser.type": {
        if (typeof args.text !== "string") return { skip: "a type without text" };
        const at = await this.locate(args.ref);
        if ("skip" in at) return at;
        const element = await this.backend.describeRef(at.ref).catch(() => null);
        // Same rule as the approval gate: a password, one-time-code or
        // card field, or one that could not be read, is a secret. Its
        // text is never kept; the step asks for a parameter at replay.
        const secret = classifyBrowserAction("type", element).category === "browser_secret";
        const taken = new Set([...recording.secretParams]);
        const param = secret ? paramNameFrom(at.target.name || "secret", taken) : undefined;
        return {
          step: {
            ...at.base,
            kind: "type",
            target: at.target,
            ...(param !== undefined ? { param } : { text: args.text }),
            ...(args.pressEnter === true ? { pressEnter: true } : {}),
            ...(args.clearFirst === true ? { clearFirst: true } : {}),
          },
          ...(param !== undefined ? { secretParam: param } : {}),
          ...(at.note !== undefined ? { note: at.note } : {}),
        };
      }
      case "browser.act": {
        const input = parsePageAction(args);
        if (input.action === "upload") return { skip: "an upload (local files are never kept in a scenario)" };
        const { ref, ...rest } = input as typeof input & { ref?: string };
        const action = rest as unknown as ScenarioPageAction;
        if (ref === undefined) return { step: { kind: "act", action } };
        const at = await this.locate(ref);
        if ("skip" in at) return at;
        return {
          step: { ...at.base, kind: "act", action, target: at.target },
          ...(at.note !== undefined ? { note: at.note } : {}),
        };
      }
      default:
        return { skip: tool };
    }
  }

  /** Role and name of `ref` on the page as it is now, before the action changes it. */
  private async locate(
    ref: unknown,
  ): Promise<
    | { ref: string; target: ScenarioTarget; base: { url: string; pageDigest: string }; note?: string }
    | { skip: string }
  > {
    if (typeof ref !== "string") return { skip: "a call without a ref" };
    await this.backend.ensureReady();
    const snapshot = await this.backend.snapshot({ full: true });
    const target = targetOfRef(snapshot.text, ref);
    if (target === null) return { skip: `a step on ref ${ref}, which is not in the page's snapshot` };
    const match = findTarget(snapshot.text, target);
    const note =
      match.kind === "ambiguous"
        ? `${match.count} elements are ${target.role} "${target.name}" on this page; the replay will stop here`
        : undefined;
    return {
      ref,
      target,
      base: { url: snapshot.url, pageDigest: snapshot.digest },
      ...(note !== undefined ? { note } : {}),
    };
  }
}

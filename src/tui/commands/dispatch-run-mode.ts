import {
  FUSION_WORKERS_MAX,
  FUSION_WORKERS_MIN,
  RUN_MODE_NAMES,
  type RunModeName,
} from "../../config/index.js";
import type { FusionRolePin } from "../../config/fusion-role-pin.js";
import { FUSION_ROLES, type FusionRole } from "../../config/llm-run-mode-config.js";

export interface RunModeCommand {
  /** Bare `/runmode`: open the composer's "Where it runs" switch. */
  readonly openSwitch: boolean;
  /** `/runmode local|cloud|fusion`. */
  readonly mode?: RunModeName;
  /** `/runmode status`. */
  readonly status?: boolean;
  /** `/runmode swap`: trade the orchestrator leg for the worker leg. */
  readonly swap?: boolean;
  /** `/runmode workers N`. */
  readonly workers?: number;
  /**
   * `/runmode role <role> <provider> [model]` or `/runmode role <role> off`:
   * set one Fusion role, several roles may share one provider with a
   * model each. `/runmode roles` lists them (`listRoles`).
   */
  readonly role?: { role: FusionRole; pin: FusionRolePin };
  readonly listRoles?: boolean;
  /** Usage line for anything else. */
  readonly error?: string;
}

export const RUN_MODE_USAGE =
  "usage: /runmode (opens the switch) · /runmode local|cloud|fusion · /runmode swap · /runmode workers N · /runmode roles · /runmode role <role> <provider> [model] | off · /runmode status";

const ROLE_USAGE = `usage: /runmode role <${FUSION_ROLES.join("|")}> <provider> [model], or /runmode role <role> off`;

/**
 * Parse the arguments of `/runmode`. Split out of
 * `slash-command-handler.ts`, which is far past its line budget, and
 * kept pure so the three routes to a run mode — this command, the
 * popup row and the `ctrl+g 1/2/3` chords — can be pinned to the same
 * outcome without a renderer.
 */
export function parseRunModeCommand(rawArgs: string): RunModeCommand {
  const args = rawArgs.trim().toLowerCase();
  if (args.length === 0) return { openSwitch: true };
  if (args === "status") return { openSwitch: false, status: true };
  if (args === "swap") return { openSwitch: false, swap: true };
  if (args === "roles") return { openSwitch: false, listRoles: true };
  if (args === "role" || args.startsWith("role ")) return parseRoleArgs(rawArgs.trim());
  const workers = /^workers\s+(\d+)$/.exec(args);
  if (workers) {
    const n = Number(workers[1]);
    if (n < FUSION_WORKERS_MIN || n > FUSION_WORKERS_MAX) {
      return {
        openSwitch: false,
        error: `workers must be ${FUSION_WORKERS_MIN}-${FUSION_WORKERS_MAX} — ${RUN_MODE_USAGE}`,
      };
    }
    return { openSwitch: false, workers: n };
  }
  if (RUN_MODE_NAMES.includes(args as RunModeName)) {
    return { openSwitch: false, mode: args as RunModeName };
  }
  return {
    openSwitch: false,
    error: `unknown run mode "${rawArgs.trim()}" — ${RUN_MODE_USAGE}`,
  };
}

/**
 * `role <role> <provider> [model]`, case kept for the provider id and the
 * model name (`anthropic/claude-opus-5.5` is not `Anthropic/...`). The
 * model is the rest of the line, so a name with spaces still fits.
 */
function parseRoleArgs(raw: string): RunModeCommand {
  const [, roleWord, providerId, ...modelWords] = raw.split(/\s+/);
  const role = roleWord?.toLowerCase();
  if (role === undefined || !FUSION_ROLES.includes(role as FusionRole) || providerId === undefined) {
    return { openSwitch: false, error: ROLE_USAGE };
  }
  if (providerId.toLowerCase() === "off" && modelWords.length === 0) {
    return { openSwitch: false, role: { role: role as FusionRole, pin: null } };
  }
  const model = modelWords.join(" ");
  return {
    openSwitch: false,
    role: {
      role: role as FusionRole,
      pin: { providerId, ...(model.length > 0 ? { model } : {}) },
    },
  };
}

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  UserLlmRouterConditions,
  UserLlmRouterConfig,
  UserLlmRouterRule,
} from "../../config/llm-router-config.js";
import type { RunModeName } from "../../config/llm-run-mode-config.js";

/**
 * Rule-based model router, step 1 (ATO-483).
 *
 * Once per turn, before it starts, the `llm.router` rules are read
 * against what the request looks like; the first rule whose conditions
 * all hold names the provider the turn starts on. The caller puts it
 * first in the turn's fallback chain (`ProviderFallbackChain.setTurnPrimary`):
 * every step starts there, and when it fails the next link of
 * `llm.fallback` answers, as for a failed primary. No step re-routes.
 *
 * It stays out of the way of every other way the provider is chosen:
 *  - off unless `llm.router.enabled` is true and a rule exists;
 *  - does nothing under the `local` run mode or Fusion: those own the
 *    choice of provider, and two mechanisms picking the model would
 *    fight. Under the `cloud` run mode it routes between cloud providers
 *    only (a rule naming a local one is passed over);
 *  - does nothing for a turn that is already pinned (a Fusion worker, a
 *    caller's explicit `providerId`);
 *  - a rule that names the active provider, a provider that is not
 *    configured, or one that cannot do what the turn needs (tools,
 *    images) is passed over.
 *
 * Pure: no I/O apart from `os.homedir()` for a `~` in `workingDir`.
 */

export interface RouterRequest {
  /** The person's message for this turn. */
  message: string;
  /** The session's working folder. */
  workingDir: string;
  /** Whether the turn offers tools. */
  needsTools: boolean;
}

/** What the router needs to know about a configured provider. */
export interface RouterProvider {
  id: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  /** A `llama-server` provider: on this machine. */
  local?: boolean;
}

export interface RouteTurnInput {
  router: UserLlmRouterConfig | undefined;
  request: RouterRequest;
  runMode: { stored: RunModeName | null; effective: RunModeName };
  activeProviderId: string;
  /** Set when the caller already pinned the turn. */
  pinnedProviderId?: string;
  providers: readonly RouterProvider[];
  /** Test seam for `~` expansion. */
  homeDir?: string;
}

export type RouteDecision =
  | { routed: true; providerId: string; rule: string }
  | {
      routed: false;
      reason: "disabled" | "run-mode" | "fusion" | "pinned" | "no-match" | "active";
    };

/** The request features the rules read. */
export interface RouteFeatures {
  tokens: number;
  hasImage: boolean;
}

/**
 * About four characters per token, the usual rough figure for English
 * and code. The rules compare against thresholds an operator picks by
 * feel ("short question", "long paste"), so a cheap estimate is enough
 * and the same message always gets the same answer.
 */
export function estimateMessageTokens(message: string): number {
  return Math.ceil(message.length / 4);
}

/**
 * Whether the message carries an image: a file name or path with an
 * image extension (how the TUI, the desktop and the channels hand the
 * agent an attachment), or an inline `data:image/` URL.
 */
const IMAGE_REFERENCE = /(?:\.(?:png|jpe?g|webp|gif)(?![A-Za-z0-9])|data:image\/)/i;

export function extractRouteFeatures(message: string): RouteFeatures {
  return {
    tokens: estimateMessageTokens(message),
    hasImage: IMAGE_REFERENCE.test(message),
  };
}

export function routeTurn(input: RouteTurnInput): RouteDecision {
  const { router } = input;
  if (!router?.enabled || router.rules.length === 0) {
    return { routed: false, reason: "disabled" };
  }
  if (input.runMode.effective === "fusion") return { routed: false, reason: "fusion" };
  const stored = input.runMode.stored;
  if (stored !== null && stored !== "cloud") return { routed: false, reason: "run-mode" };
  if (input.pinnedProviderId !== undefined) return { routed: false, reason: "pinned" };
  const features = extractRouteFeatures(input.request.message);
  const home = input.homeDir ?? homedir();
  for (const [index, rule] of router.rules.entries()) {
    const target = input.providers.find((p) => p.id === rule.provider);
    if (target === undefined) continue;
    if (!ruleMatches(rule.when, features, input.request, home)) continue;
    if (!canServe(target, features, input.request)) continue;
    // The cloud run mode keeps every turn in the cloud.
    if (stored === "cloud" && target.local === true) continue;
    if (target.id === input.activeProviderId) return { routed: false, reason: "active" };
    return { routed: true, providerId: target.id, rule: ruleLabel(rule, index) };
  }
  return { routed: false, reason: "no-match" };
}

export function ruleMatches(
  when: UserLlmRouterConditions | undefined,
  features: RouteFeatures,
  request: RouterRequest,
  homeDir: string,
): boolean {
  if (when === undefined) return true;
  if (when.minTokens !== undefined && features.tokens < when.minTokens) return false;
  if (when.maxTokens !== undefined && features.tokens > when.maxTokens) return false;
  if (when.hasImage !== undefined && features.hasImage !== when.hasImage) return false;
  if (when.needsTools !== undefined && request.needsTools !== when.needsTools) return false;
  if (when.contains !== undefined) {
    const text = request.message.toLowerCase();
    if (!when.contains.some((word) => text.includes(word.toLowerCase()))) return false;
  }
  if (when.matches !== undefined && !compiled(when.matches).test(request.message)) {
    return false;
  }
  if (
    when.workingDir !== undefined &&
    !isInside(request.workingDir, expandHome(when.workingDir, homeDir))
  ) {
    return false;
  }
  return true;
}

/** A provider that says it cannot call tools or see images is not sent such a turn. */
function canServe(
  target: RouterProvider,
  features: RouteFeatures,
  request: RouterRequest,
): boolean {
  if (request.needsTools && target.supportsTools === false) return false;
  if (features.hasImage && target.supportsVision === false) return false;
  return true;
}

function ruleLabel(rule: UserLlmRouterRule, index: number): string {
  return rule.name ?? `rule ${index + 1}`;
}

const regexCache = new Map<string, RegExp>();

function compiled(source: string): RegExp {
  let re = regexCache.get(source);
  if (re === undefined) {
    re = new RegExp(source, "i");
    regexCache.set(source, re);
  }
  return re;
}

function expandHome(path: string, homeDir: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return join(homeDir, trimmed.slice(2));
  return trimmed;
}

/** `dir` is `root` or a folder inside it. Both made absolute first. */
function isInside(dir: string, root: string): boolean {
  if (!isAbsolute(root)) return false;
  const a = resolve(dir);
  const b = resolve(root);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

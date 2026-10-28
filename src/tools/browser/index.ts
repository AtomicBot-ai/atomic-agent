import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { buildBrowserNavigateTool } from "./navigate.js";
import { buildBrowserClickTool } from "./click.js";
import { buildBrowserTypeTool } from "./type.js";
import { buildBrowserReadAriaTool } from "./read-aria.js";
import { buildBrowserSearchTool } from "./search.js";
import { buildBrowserTabsTool } from "./tabs.js";
import { buildBrowserScrollTool } from "./scroll.js";
import {
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { AriaSnapshotStore } from "./aria-view.js";

export type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  RefDescription,
  ScrollDirection,
  ScrollInput,
  ScrollResult,
  SearchInput,
  TabInfo,
  TabsInput,
  TypeInput,
} from "./browser-backend.js";
export { PlaywrightBackend } from "./playwright-backend.js";
export type { PlaywrightBackendOptions } from "./playwright-backend.js";
export { buildChromeLaunchArgs } from "./build-chrome-launch-args.js";
export type { BuildChromeLaunchArgsInput } from "./build-chrome-launch-args.js";
export {
  decorateChromeProfile,
  markChromeProfileCleanExit,
} from "./decorate-chrome-profile.js";
export type { DecorateChromeProfileOptions } from "./decorate-chrome-profile.js";
export {
  CHROME_LOCK_BASENAMES,
  clearStaleChromeLocks,
  readChromeSingletonLockPid,
} from "./clear-stale-chrome-locks.js";
export type { ClearStaleChromeLocksResult } from "./clear-stale-chrome-locks.js";
export { findChromeExecutable } from "./find-chrome-executable.js";
export type {
  BrowserExecutable,
  FindChromeOptions,
} from "./find-chrome-executable.js";
export {
  pickAvailableLoopbackPort,
  spawnChrome,
  stopChrome,
} from "./spawn-chrome.js";
export type { RunningChrome, SpawnChromeInput } from "./spawn-chrome.js";
export {
  DEFAULT_ARIA_MAX_CHARS,
  packLinesToCharBudget,
  summariseAriaSnapshot,
} from "./aria-compressor.js";
export type {
  AriaCompressionOptions,
  AriaSnapshotSummary,
} from "./aria-compressor.js";
export {
  EMPTY_DOMAIN_POLICY,
  blockedHostOfPage,
  checkBrowserHost,
  checkBrowserUrl,
  hostMatchesAny,
  hostMatchesDomain,
  normalizeDomainEntry,
  webHostOf,
} from "./browser-domain-policy.js";
export type { BrowserDomainPolicy, DomainVerdict } from "./browser-domain-policy.js";
export {
  classifyBrowserAction,
  isPaymentPage,
  PAYMENT_HOSTS,
} from "./classify-browser-action.js";
export type {
  BrowserActionCategory,
  BrowserActionKind,
  BrowserActionVerdict,
} from "./classify-browser-action.js";
export {
  ARIA_VIEW_MODES,
  AriaSnapshotStore,
  ariaCharBudget,
  defaultAriaViewMode,
  readAriaView,
  renderAriaView,
} from "./aria-view.js";
export type { AriaViewMode, AriaViewContext, RenderedAriaView } from "./aria-view.js";
export { buildBrowserNavigateTool, isSafeUrl } from "./navigate.js";
export { buildBrowserClickTool } from "./click.js";
export { buildBrowserTypeTool } from "./type.js";
export { buildBrowserReadAriaTool } from "./read-aria.js";
export { requireUserSite, userSiteCleared, UserSiteApprovals } from "./user-profile-sites.js";
export { buildBrowserSearchTool } from "./search.js";
export { buildBrowserTabsTool } from "./tabs.js";
export { buildBrowserScrollTool } from "./scroll.js";

/**
 * Build the complete set of browser tools for the registry. The caller is
 * responsible for `backend.shutdown()` on process exit. `dangerous` gates
 * non-http(s) navigation, clicks / Enter that commit something, password
 * and payment input, and hosts outside the allow-list; `policy` carries
 * `browser.blockedDomains` / `browser.allowedDomains`.
 */
export function buildBrowserTools(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
): ToolDefinition[] {
  // One per tool set: the last snapshot of each tab, for read_aria's diff view.
  const store = new AriaSnapshotStore();
  return [
    buildBrowserNavigateTool(backend, dangerous, policy, store),
    buildBrowserClickTool(backend, dangerous, policy),
    buildBrowserTypeTool(backend, dangerous, policy),
    buildBrowserReadAriaTool(backend, policy, store, dangerous),
    buildBrowserSearchTool(backend, dangerous, policy, store),
    buildBrowserTabsTool(backend, dangerous, policy),
    buildBrowserScrollTool(backend),
  ];
}

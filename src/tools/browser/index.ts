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

export type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
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
export { buildBrowserNavigateTool, isSafeUrl } from "./navigate.js";
export { buildBrowserClickTool } from "./click.js";
export { buildBrowserTypeTool } from "./type.js";
export { buildBrowserReadAriaTool } from "./read-aria.js";
export { buildBrowserSearchTool } from "./search.js";
export { buildBrowserTabsTool } from "./tabs.js";
export { buildBrowserScrollTool } from "./scroll.js";

/**
 * Build the complete set of browser tools for the registry. The caller is
 * responsible for `backend.shutdown()` on process exit. `dangerous` is
 * used by `browser.navigate` to gate non-http(s) schemes.
 */
export function buildBrowserTools(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
): ToolDefinition[] {
  return [
    buildBrowserNavigateTool(backend, dangerous),
    buildBrowserClickTool(backend),
    buildBrowserTypeTool(backend),
    buildBrowserReadAriaTool(backend),
    buildBrowserSearchTool(backend),
    buildBrowserTabsTool(backend, dangerous),
    buildBrowserScrollTool(backend),
  ];
}

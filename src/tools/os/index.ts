import type { ToolRegistry } from "../tool-registry.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { buildOsShellTool } from "./shell.js";
import { osFsReadTool } from "./fs-read.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { osFsListTool } from "./fs-list.js";
import { osClipboardReadTool, osClipboardWriteTool } from "./clipboard.js";
import { osWindowListTool, osWindowFocusTool } from "./window.js";
import { osNotifyTool } from "./notify.js";

export { buildOsShellTool } from "./shell.js";
export { osFsReadTool } from "./fs-read.js";
export { buildOsFsWriteTool } from "./fs-write.js";
export { osFsListTool } from "./fs-list.js";
export { osClipboardReadTool, osClipboardWriteTool } from "./clipboard.js";
export { osWindowListTool, osWindowFocusTool } from "./window.js";
export { osNotifyTool } from "./notify.js";

export function registerOsTools(
  registry: ToolRegistry,
  options: DangerousToolOptions,
): void {
  registry.register(buildOsShellTool(options));
  registry.register(osFsReadTool);
  registry.register(buildOsFsWriteTool(options));
  registry.register(osFsListTool);
  registry.register(osClipboardReadTool);
  registry.register(osClipboardWriteTool);
  registry.register(osWindowListTool);
  registry.register(osWindowFocusTool);
  registry.register(osNotifyTool);
}

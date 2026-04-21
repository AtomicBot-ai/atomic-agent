import type { ToolRegistry } from "../tool-registry.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { buildOsShellTool } from "./shell.js";
import { osFsReadTool } from "./fs-read.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { osFsListTool } from "./fs-list.js";
import { osFsGlobTool } from "./fs-glob.js";
import { buildOsFsGrepTool } from "./fs-grep.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { buildOsFsReadDocumentTool } from "./read-document/index.js";
import {
  buildOsFsArchiveListTool,
  buildOsFsArchiveReadEntryTool,
  buildOsFsArchiveExtractTool,
} from "./archive/index.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import { osClipboardReadTool, osClipboardWriteTool } from "./clipboard.js";
import { osWindowListTool, osWindowFocusTool } from "./window.js";
import { osNotifyTool } from "./notify.js";

export { buildOsShellTool } from "./shell.js";
export { osFsReadTool } from "./fs-read.js";
export { buildOsFsWriteTool } from "./fs-write.js";
export { osFsListTool } from "./fs-list.js";
export { osFsGlobTool } from "./fs-glob.js";
export { buildOsFsGrepTool } from "./fs-grep.js";
export { buildOsFsEditTool } from "./fs-edit.js";
export { buildOsFsReadDocumentTool } from "./read-document/index.js";
export {
  buildOsFsArchiveListTool,
  buildOsFsArchiveReadEntryTool,
  buildOsFsArchiveExtractTool,
} from "./archive/index.js";
export { buildOsHttpRequestTool } from "./http-request.js";
export { osClipboardReadTool, osClipboardWriteTool } from "./clipboard.js";
export { osWindowListTool, osWindowFocusTool } from "./window.js";
export { osNotifyTool } from "./notify.js";

export interface RegisterOsToolsOptions extends DangerousToolOptions {
  config: Pick<AtomicAgentConfig, "http">;
}

export function registerOsTools(
  registry: ToolRegistry,
  options: RegisterOsToolsOptions,
): void {
  registry.register(buildOsShellTool(options));
  registry.register(osFsReadTool);
  registry.register(buildOsFsWriteTool(options));
  registry.register(osFsListTool);
  registry.register(osFsGlobTool);
  registry.register(buildOsFsGrepTool());
  registry.register(buildOsFsEditTool(options));
  registry.register(buildOsFsReadDocumentTool());
  registry.register(buildOsFsArchiveListTool());
  registry.register(buildOsFsArchiveReadEntryTool());
  registry.register(
    buildOsFsArchiveExtractTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
    }),
  );
  registry.register(
    buildOsHttpRequestTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
      config: options.config,
    }),
  );
  registry.register(osClipboardReadTool);
  registry.register(osClipboardWriteTool);
  registry.register(osWindowListTool);
  registry.register(osWindowFocusTool);
  registry.register(osNotifyTool);
}

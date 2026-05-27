import type { ToolRegistry } from "../tool-registry.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { buildOsShellTool } from "./shell.js";
import { osFsReadTool } from "./fs-read.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { buildOsFsTrashTool } from "./fs-trash.js";
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
import { osFsHashTool } from "./fs-hash.js";
import { osFsDiffTool } from "./fs-diff.js";
import { buildOsFsPatchTool } from "./fs-patch.js";
import { osFsWatchTool } from "./fs-watch.js";
import {
  osGitStatusTool,
  osGitLogTool,
  osGitDiffTool,
  osGitShowTool,
  osGitBlameTool,
  osGitBranchTool,
} from "./git/index.js";
import { osProcListTool, buildOsProcKillTool } from "./proc/index.js";

export { buildOsShellTool } from "./shell.js";
export { osFsReadTool } from "./fs-read.js";
export { buildOsFsWriteTool } from "./fs-write.js";
export { buildOsFsTrashTool } from "./fs-trash.js";
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
export { osFsHashTool } from "./fs-hash.js";
export { osFsDiffTool } from "./fs-diff.js";
export { buildOsFsPatchTool } from "./fs-patch.js";
export { osFsWatchTool } from "./fs-watch.js";
export {
  osGitStatusTool,
  osGitLogTool,
  osGitDiffTool,
  osGitShowTool,
  osGitBlameTool,
  osGitBranchTool,
} from "./git/index.js";
export { osProcListTool, buildOsProcKillTool } from "./proc/index.js";
export { isGogCommand } from "./shell-command-guard/index.js";

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
  registry.register(buildOsFsTrashTool(options));
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
  registry.register(osFsHashTool);
  registry.register(osFsDiffTool);
  registry.register(
    buildOsFsPatchTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
    }),
  );
  registry.register(osFsWatchTool);
  registry.register(osGitStatusTool);
  registry.register(osGitLogTool);
  registry.register(osGitDiffTool);
  registry.register(osGitShowTool);
  registry.register(osGitBlameTool);
  registry.register(osGitBranchTool);
  registry.register(osProcListTool);
  registry.register(
    buildOsProcKillTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
    }),
  );
}

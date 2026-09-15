export {
  READ_TOOL_TARGETS,
  SHELL_TOOL,
  URL_LIKE,
} from "./read-scope-targets.js";
export type { ReadTargetsOf } from "./read-scope-targets.js";
export {
  canonical,
  checkWorkerRead,
  findSessionReadOutside,
  isOutsideReadRoots,
  isScratchPath,
  isUnderAny,
  READ_REFUSAL_REASON,
  scratchDirs,
  sessionReadRefusal,
  sessionReadRoots,
  WORKER_READ_REFUSAL_REASON,
  workerReadRefusal,
} from "./read-scope.js";
export {
  looksLikeNamedPath,
  pathsNamedIn,
  userNamedPaths,
} from "./read-scope-roots.js";
export type { UserNamedPathOptions } from "./read-scope-roots.js";
export {
  defaultShellScopeEnv,
  findShellPathOutsideScope,
  shellCommandLine,
  shellTokens,
} from "./read-scope-shell.js";
export type { ShellScopeEnv } from "./read-scope-shell.js";
export {
  ReadOutsideApprover,
  readOutsidePrompt,
  shellReadOutsidePrompt,
  widenedReadRoot,
} from "./read-scope-approval.js";
export type { ReadOutsidePrompt } from "./read-scope-approval.js";
export { confineReads, confineWorkerReads } from "./confine-reads.js";
export type { ConfineReadsOptions } from "./confine-reads.js";
// The worker-era name of the targets map, kept so fusion code reads the same.
export { READ_TOOL_TARGETS as WORKER_READ_TOOL_TARGETS } from "./read-scope-targets.js";

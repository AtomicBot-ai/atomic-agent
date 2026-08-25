export {
  planUninstallTargets,
  installDirFor,
  isInstalledBinary,
  isSafeToRemove,
  type UninstallTarget,
  type UninstallTargetGroup,
  type UninstallPlanInput,
} from "./uninstall-targets.js";
export {
  measureUninstallPlan,
  formatBytes,
  type MeasuredPlan,
  type MeasuredTarget,
} from "./measure-uninstall-plan.js";
export {
  stripInstallerPathLine,
  INSTALLER_PATH_MARKER,
  type StripResult,
} from "./strip-installer-path-line.js";
export {
  runUninstall,
  installerRcCandidates,
  type RunUninstallOptions,
  type UninstallResult,
  type RemovalOutcome,
} from "./run-uninstall.js";
export {
  resolveUninstallPlan,
  type ResolvedUninstallPlan,
  type ResolveUninstallPlanOptions,
} from "./resolve-uninstall-plan.js";

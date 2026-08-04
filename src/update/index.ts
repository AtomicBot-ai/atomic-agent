export {
  checkForAppUpdate,
  resetAppReleaseCache,
  AppUpdateCheckError,
  type AppUpdateCheckResult,
} from "./check-app-update.js";
export {
  runAppUpdate,
  canSelfUpdate,
  formatInstallFailure,
  AppUpdateError,
  type RunAppUpdateOptions,
  type RunAppUpdateResult,
} from "./run-app-update.js";
export {
  compareSemver,
  isNewerVersion,
  parseSemver,
} from "./compare-semver.js";

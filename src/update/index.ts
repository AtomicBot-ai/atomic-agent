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
  parseUpdatePolicy,
  requiredUpdateReason,
  requiredUpdateText,
  EMPTY_UPDATE_POLICY,
  type UpdatePolicy,
  type RequiredUpdateReason,
} from "./update-policy.js";
export {
  compareSemver,
  isNewerVersion,
  parseSemver,
} from "./compare-semver.js";
export {
  detectInstallSource,
  readInstallSource,
  detectShadowedPackage,
  readShadowedPackage,
  shadowedPackageNotice,
  parseInstallSource,
  installSourceLabel,
  packageUpgradeHint,
  packageRemoveHint,
  packagedUpdateRefusal,
  INSTALL_SOURCES,
  PACKAGE_DIR,
  PACKAGE_MARKER,
  PACKAGED_BINARY,
  type InstallSource,
  type ReadInstallSourceInput,
} from "./install-source.js";

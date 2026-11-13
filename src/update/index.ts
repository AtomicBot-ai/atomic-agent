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
  verifySha256Sums,
  parseSha256Sums,
  resolveSignedArchiveSha256,
  ReleaseSignatureError,
  RELEASE_SIGNING_PUBLIC_KEY,
  FIRST_SIGNED_VERSION,
  signatureRequired,
  type SumsVerification,
} from "./release-signature.js";
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
  LINUX_PACKAGE_SOURCES,
  MANAGER_SOURCES,
  managerForPath,
  PACKAGE_DIR,
  PACKAGE_MARKER,
  PACKAGED_BINARY,
  type InstallSource,
  type ReadInstallSourceInput,
} from "./install-source.js";

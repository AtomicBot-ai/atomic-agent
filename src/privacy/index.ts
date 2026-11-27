export {
  acceptableModelValue,
  findPrivateSpans,
  findSecretSpans,
  MODEL_PRIVATE_KINDS,
  PRIVATE_KINDS,
  SHIELD_KINDS,
  type ModelFoundValue,
  type ModelPrivateKind,
  type PrivateKind,
  type PrivateSpan,
  type ShieldKind,
} from "./detect-private-data.js";
export {
  createLocalNameDetector,
  splitParagraphs,
  type LocalNameDetector,
  type LocalNameDetectorOptions,
  type LocalNameModel,
} from "./local-name-detector.js";
export {
  PLACEHOLDER,
  PrivacyVault,
  type PrivacyVaultStats,
  type UnmaskOptions,
} from "./privacy-vault.js";
export { createStreamUnmasker, partialPlaceholderStart, type StreamUnmasker } from "./stream-unmasker.js";
export {
  forgetPrivacyVault,
  isPrivacyShieldEnabled,
  linkPrivacyVault,
  privacyShieldTotals,
  privacyNameDetector,
  privacyVaultFor,
  resetPrivacyVaults,
  setPrivacyKnownSecrets,
  setPrivacyNameDetector,
  setPrivacyShieldEnabled,
  SHARED_VAULT_KEY,
  type PrivacyShieldTotals,
} from "./privacy-vault-registry.js";

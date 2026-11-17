export {
  findPrivateSpans,
  findSecretSpans,
  PRIVATE_KINDS,
  type PrivateKind,
  type PrivateSpan,
} from "./detect-private-data.js";
export {
  PLACEHOLDER,
  PrivacyVault,
  type PrivacyVaultStats,
  type UnmaskOptions,
} from "./privacy-vault.js";
export { createStreamUnmasker, partialPlaceholderStart, type StreamUnmasker } from "./stream-unmasker.js";
export {
  forgetPrivacyVault,
  privacyShieldTotals,
  privacyVaultFor,
  resetPrivacyVaults,
  setPrivacyKnownSecrets,
  SHARED_VAULT_KEY,
  type PrivacyShieldTotals,
} from "./privacy-vault-registry.js";

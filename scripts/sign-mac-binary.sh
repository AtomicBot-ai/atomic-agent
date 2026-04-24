#!/usr/bin/env bash
# Signs a single Mach-O binary (Node SEA) with a Developer ID certificate.
# Env (openclaw-compatible):
#   MACOS_CSC_LINK (or CSC_LINK)  — base64-encoded PKCS#12 (.p12) certificate
#   MACOS_CSC_KEY_PASSWORD (or CSC_KEY_PASSWORD) — p12 password
#   MACOS_CSC_NAME (or CSC_NAME)  — optional explicit "Developer ID Application: ..." name
# If MACOS_CSC_LINK is unset, skips with a non-fatal message (unsigned output).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENTITLEMENTS="${REPO_ROOT}/scripts/entitlements.mac.plist"
LINK="${MACOS_CSC_LINK:-${CSC_LINK:-}}"
PASS="${MACOS_CSC_KEY_PASSWORD:-${CSC_KEY_PASSWORD:-}}"

if [[ -z "$LINK" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "warn: MACOS_CSC_LINK / CSC_LINK is empty — skipping codesign (unsigned binary)." >&2
  else
    echo "note: set MACOS_CSC_LINK to a base64-encoded p12 to sign; skipping codesign." >&2
  fi
  exit 0
fi

BIN="${1:-}"
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "Usage: $0 <path-to-mach-o-binary>" >&2
  exit 1
fi
if ! command -v /usr/bin/codesign &>/dev/null; then
  echo "Error: /usr/bin/codesign not found; run on macOS." >&2
  exit 1
fi
if ! command -v /usr/bin/security &>/dev/null; then
  echo "Error: /usr/bin/security not found; run on macOS." >&2
  exit 1
fi

if [[ -z "$PASS" ]]; then
  echo "Error: MACOS_CSC_KEY_PASSWORD (or CSC_KEY_PASSWORD) is required when MACOS_CSC_LINK is set." >&2
  exit 1
fi
if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "Error: entitlements not found: $ENTITLEMENTS" >&2
  exit 1
fi

TMP_P12="${RUNNER_TEMP:-/tmp}/macos-atomic-$(openssl rand -hex 8 2>/dev/null || date +%s).p12"
# Strip whitespace/newlines and decode base64 (GitHub usually stores a single line).
if ! printf '%s' "$LINK" | tr -d ' \n\r' | /usr/bin/base64 -D -o "$TMP_P12" 2>/dev/null; then
  if ! command -v openssl &>/dev/null; then
    echo "Error: could not base64-decode MACOS_CSC_LINK" >&2
    exit 1
  fi
  printf '%s' "$LINK" | tr -d ' \n\r' | openssl base64 -d -A -out "$TMP_P12"
fi
if [[ ! -s "$TMP_P12" ]]; then
  echo "Error: decoded p12 is empty" >&2
  exit 1
fi
trap 'rm -f "$TMP_P12"' EXIT

KEYCHAIN_NAME="atomic-codesign-$(date +%s).keychain-db"
KEYCHAIN_PATH="${RUNNER_TEMP:-/tmp}/${KEYCHAIN_NAME}"
KEYCHAIN_PASS="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"

# shellcheck disable=SC2034
{ security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN_PATH" &&
  security set-keychain-settings -lut 3600 "$KEYCHAIN_PATH" &&
  security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN_PATH" &&
  security import "$TMP_P12" -k "$KEYCHAIN_PATH" -P "$PASS" -T /usr/bin/codesign -T /usr/bin/security &&
  security set-key-partition-list -S "apple-tool:,apple:,codesign:" -s -k "$KEYCHAIN_PASS" "$KEYCHAIN_PATH" &&
  security list-keychain -d user -s "$KEYCHAIN_PATH" "${HOME}/Library/Keychains/login.keychain-db" 2>/dev/null || \
  security list-keychain -d user -s "$KEYCHAIN_PATH"; } \
  || { security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true; echo "Error: keychain import failed." >&2; exit 1; }

delete_keychain() {
  security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true
}
trap 'delete_keychain; rm -f "$TMP_P12"' EXIT

IDENTITY="${MACOS_CSC_NAME:-${CSC_NAME:-}}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(
    security find-identity -p codesigning -v "$KEYCHAIN_PATH" 2>/dev/null | awk -F'\"' '/Developer ID Application/ { print $2; exit }'
  )"
  if [[ -z "$IDENTITY" ]]; then
    IDENTITY="$(
      security find-identity -p codesigning -v "$KEYCHAIN_PATH" 2>/dev/null | awk -F'\"' '/(Apple Development|Developer ID|Apple Distribution)/ { print $2; exit }'
    )"
  fi
  if [[ -z "$IDENTITY" ]]; then
    echo "Error: no valid codesigning identity in imported p12" >&2
    exit 1
  fi
fi

echo "signing: $BIN"
echo "identity: $IDENTITY"
TIMESTAMP=()
if [[ "$IDENTITY" == *"Developer ID Application"* ]]; then
  TIMESTAMP=(--timestamp)
else
  TIMESTAMP=(--timestamp=none)
fi

# Clear quarantine and stale xattrs (best-effort).
/usr/bin/xattr -cr "$BIN" 2>/dev/null || true

/usr/bin/codesign --force --options runtime --sign "$IDENTITY" --entitlements "$ENTITLEMENTS" "${TIMESTAMP[@]}" \
  "$BIN"

/usr/bin/codesign --verify --strict --verbose=2 "$BIN"

echo "codesign: ok"

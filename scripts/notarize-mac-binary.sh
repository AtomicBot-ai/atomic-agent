#!/usr/bin/env bash
# Zips a signed Mach-O binary, submits to Apple notary service, waits.
# No stapler for raw executables; Gatekeeper does an online check on first run.
# Auth: NOTARYTOOL_PROFILE, or NOTARYTOOL_KEY (path to .p8) + NOTARYTOOL_KEY_ID + NOTARYTOOL_ISSUER.
# Env:
#   NOTARIZE=1 — required to run; otherwise no-op
#   NOTARYTOOL_KEY — after CI writes the .p8 to a file path, same as openclaw
set -euo pipefail

if [[ $(uname -s) != "Darwin" ]]; then
  echo "notarize-mac-binary: macOS only; skipping" >&2
  exit 0
fi
if [[ "${NOTARIZE:-}" != "1" ]]; then
  echo "notarize-mac-binary: NOTARIZE=1 not set; skipping" >&2
  exit 0
fi

BIN="${1:-}"
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "Usage: $0 <path-to-signed-mach-o-binary>" >&2
  exit 1
fi

if ! command -v xcrun &>/dev/null; then
  echo "Error: xcrun not found" >&2
  exit 1
fi

auth_args=()
if [[ -n "${NOTARYTOOL_PROFILE:-}" && -n $(echo "${NOTARYTOOL_PROFILE}" | tr -d ' \t\n') ]]; then
  auth_args+=(--keychain-profile "$NOTARYTOOL_PROFILE")
elif [[ -n "${NOTARYTOOL_KEY:-}" && -n "${NOTARYTOOL_KEY_ID:-}" && -n "${NOTARYTOOL_ISSUER:-}" ]]; then
  auth_args+=(--key "$NOTARYTOOL_KEY" --key-id "$NOTARYTOOL_KEY_ID" --issuer "$NOTARYTOOL_ISSUER")
else
  echo "Error: notary auth missing. Set NOTARYTOOL_PROFILE OR NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atomic-notary-XXXXXX")"
ZIP_PATH="${TMP_DIR}/$(basename "$BIN").notary.zip"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "creating zip for notary: $ZIP_PATH"
# ditto preserves resource forks; single file is still fine for Mach-O CLI.
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$BIN" "$ZIP_PATH"

echo "submitting to Apple notarization (notarytool --wait)…"
xcrun notarytool submit "$ZIP_PATH" "${auth_args[@]}" --wait

echo "notarization complete (binary not stapled; online Gatekeeper on first run)"

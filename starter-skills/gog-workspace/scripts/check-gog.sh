#!/usr/bin/env bash
set -u

# GUI apps and bundled runtimes often launch non-login shells with a reduced PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"

log() {
  printf '%s\n' "$*"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

print_install_help() {
  log "status: install_required"
  log "gog is not installed or is not visible on PATH."
  log "Run the platform setup script from a real terminal:"
  log "  bash ~/.atomic-agent/skills/gog-workspace/scripts/setup-gog.sh"
  log "Or install manually:"
  log "  brew install openclaw/tap/gogcli"
  log "  Download a release: https://github.com/openclaw/gogcli/releases"
}

print_auth_help() {
  log "status: auth_required"
  log "gog is installed but no healthy Google account is available."
  log "Auth setup is incomplete. Complete these steps in a real terminal:"
  log "  gog auth credentials <credentials.json>"
  log "  gog auth add <email>"
  log "Or run the platform setup script:"
  log "  bash ~/.atomic-agent/skills/gog-workspace/scripts/setup-gog.sh"
  log "If multiple accounts exist, pass --account <email>, set GOG_ACCOUNT=<email>, or run gog auth manage."
  log "For headless runs, configure gog's file keyring and make sure the agent process inherits:"
  log "  GOG_KEYRING_BACKEND=file"
  log "  GOG_KEYRING_PASSWORD=<secret>"
}

print_account_hint() {
  AUTH_LIST="$(gog auth list 2>/dev/null || true)"
  if [ -z "$AUTH_LIST" ]; then
    return
  fi
  log "Accounts:"
  log "$AUTH_LIST"
  ACCOUNT_COUNT="$(printf '%s\n' "$AUTH_LIST" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  if [ "${ACCOUNT_COUNT:-0}" -gt 1 ]; then
    log "Multiple accounts are configured. Use --account <email> on gog reads, set GOG_ACCOUNT=<email>, or run gog auth manage."
  fi
}

if ! has_cmd gog; then
  print_install_help
  exit 0
fi

log "Detected: $(gog --version 2>&1 | head -n 1)"

AUTH_OUTPUT="$(gog auth doctor --check --no-input 2>&1)"
AUTH_STATUS=$?
if [ "$AUTH_STATUS" -eq 0 ]; then
  log "gog auth doctor succeeded."
  log "$AUTH_OUTPUT"
  if printf '%s' "$AUTH_OUTPUT" | grep -Eiq 'no OAuth tokens stored|run .*gog auth add'; then
    print_auth_help
    exit 0
  fi
  if printf '%s' "$AUTH_OUTPUT" | grep -Eiq 'readable OAuth token|refresh.*succeeded'; then
    log "status: healthy"
    print_account_hint
    exit 0
  fi
  if printf '%s' "$AUTH_OUTPUT" | grep -Eiq 'config\.path.*missing|credentials.*missing|run .*gog auth credentials|client_secret.*false'; then
    print_auth_help
    exit 0
  fi
  log "status: healthy"
  print_account_hint
  exit 0
fi

if printf '%s' "$AUTH_OUTPUT" | grep -Eiq 'not authenticated|no account|no credentials|keyring|login|auth add|credentials'; then
  print_auth_help
  exit 0
fi

if printf '%s' "$AUTH_OUTPUT" | grep -Eiq 'accessNotConfigured|API has not been used|enable.+API|disabled'; then
  log "status: api_required"
  log "$AUTH_OUTPUT"
  log "A required Google API appears to be disabled. Enable it in the OAuth client's Cloud project, wait a few seconds, then rerun this check."
  exit 0
fi

log "$AUTH_OUTPUT"
log "gog auth doctor failed for an unclassified reason."
exit "$AUTH_STATUS"

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

prompt() {
  printf '%s' "$1"
  IFS= read -r REPLY
}

install_gog() {
  if has_cmd brew; then
    log "Installing gog with Homebrew..."
    brew install openclaw/tap/gogcli
    return $?
  fi

  log "gog is not installed and Homebrew is not available."
  log "Install manually from:"
  log "  https://github.com/openclaw/gogcli/releases"
  return 10
}

if ! has_cmd gog; then
  install_gog || exit $?
fi

log "Detected: $(gog --version 2>&1 | head -n 1)"

if gog auth doctor --check --no-input >/dev/null 2>&1; then
  log "gog auth doctor succeeded."
  exit 0
fi

log "A Desktop OAuth client JSON is required."
log "Create one in Google Cloud Console, enable the APIs you need, then download the JSON."
log "Common services for a local agent: gmail,calendar,drive,docs,sheets,contacts"
log "Never commit OAuth client JSON files or tokens."

prompt "Path to Desktop OAuth client JSON: "
CLIENT_JSON="$REPLY"
if [ -z "$CLIENT_JSON" ] || [ ! -f "$CLIENT_JSON" ]; then
  log "Credential file not found: $CLIENT_JSON"
  exit 20
fi

prompt "Google account email to add: "
ACCOUNT="$REPLY"
if [ -z "$ACCOUNT" ]; then
  log "Account email is required."
  exit 21
fi

prompt "Services [gmail,calendar,drive,docs,sheets,contacts]: "
SERVICES="$REPLY"
if [ -z "$SERVICES" ]; then
  SERVICES="gmail,calendar,drive,docs,sheets,contacts"
fi

log "Storing OAuth client in gog..."
gog auth credentials "$CLIENT_JSON" || exit 22

log "Adding account. Browser consent may open."
gog auth add "$ACCOUNT" --services "$SERVICES" || exit 23

log "Verifying auth..."
gog auth doctor --check --no-input || exit 24

log "gog setup is healthy."

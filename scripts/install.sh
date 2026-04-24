#!/usr/bin/env sh
# Install a released atomic-agent CLI (Node SEA) from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OWNER/atomic-agent/BRANCH/scripts/install.sh | sh
#
# Environment:
#   ATOMIC_AGENT_REPO=owner/atomic-agent   (default: atomicbot/atomic-agent)
#   ATOMIC_AGENT_VERSION=v0.1.0            (optional: pin a tag; default: latest)
#   ATOMIC_AGENT_INSTALL_DIR=path         (default: $HOME/.local/bin)

set -eu

# shellcheck disable=SC3043
# POSIX sh: local may not exist; we avoid local for dash compatibility.

REPO_DEFAULT="atomicbot/atomic-agent"
REPO="${ATOMIC_AGENT_REPO:-$REPO_DEFAULT}"
VERSION="${ATOMIC_AGENT_VERSION:-}"
INSTALL_DIR="${ATOMIC_AGENT_INSTALL_DIR:-$HOME/.local/bin}"

if command -v uname >/dev/null 2>&1; then
  OS_NAME="$(uname -s)"
  MACHINE="$(uname -m)"
else
  echo "this installer requires uname" >&2
  exit 1
fi

case "$OS_NAME" in
  Darwin) ;;
  Linux) ;;
  *)
    echo "unsupported OS: $OS_NAME (this script supports macOS and Linux)" >&2
    echo "on Windows, download the zip from GitHub Releases for this repo." >&2
    exit 1
    ;;
esac

case "$MACHINE" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "unsupported arch: $MACHINE" >&2; exit 1 ;;
esac

if [ "$OS_NAME" = "Darwin" ]; then
  SLUG="darwin-${ARCH}"
  ARCHIVE_EXT="tar.gz"
elif [ "$OS_NAME" = "Linux" ]; then
  SLUG="linux-${ARCH}"
  ARCHIVE_EXT="tar.gz"
fi

download() {
  _url="$1"
  _out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$_out" "$_url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$_out" "$_url"
  else
    echo "install curl or wget" >&2
    exit 1
  fi
}

BASE="https://github.com/${REPO}"
if [ -n "$VERSION" ]; then
  TAR_NAME="atomic-agent-${SLUG}.${ARCHIVE_EXT}"
  TAR_URL="${BASE}/releases/download/${VERSION}/${TAR_NAME}"
  SHA_URL="${BASE}/releases/download/${VERSION}/${TAR_NAME}.sha256"
else
  TAR_NAME="atomic-agent-${SLUG}.${ARCHIVE_EXT}"
  TAR_URL="${BASE}/releases/latest/download/${TAR_NAME}"
  SHA_URL="${BASE}/releases/latest/download/${TAR_NAME}.sha256"
fi

echo "downloading ${TAR_NAME} from ${REPO} …"

TMPDIR="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "$TMPDIR/atomic-agent-install.XXXXXX")"
# shellcheck disable=SC2064
trap 'rm -rf "$WORK"' EXIT

download "$TAR_URL" "$WORK/${TAR_NAME}"
download "$SHA_URL" "$WORK/${TAR_NAME}.sha256"

if command -v shasum >/dev/null 2>&1; then
  (cd "$WORK" && shasum -a 256 -c "${TAR_NAME}.sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$WORK" && sha256sum -c "${TAR_NAME}.sha256")
else
  echo "warning: shasum/sha256sum not found; skipping checksum verify" >&2
fi

(cd "$WORK" && tar -xzf "${TAR_NAME}")

# Archive root is a single directory: <slug>/
STAGE="$WORK/${SLUG}"
if [ ! -d "$STAGE" ]; then
  echo "unexpected archive layout (expected top-level $SLUG/); contents:" >&2
  ls -la "$WORK" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

# Install binary, grammars, native prebuilds, and vendor/ next to the binary
if [ -f "$STAGE/atomic-agent" ]; then
  cp -f "$STAGE/atomic-agent" "$INSTALL_DIR/atomic-agent"
  chmod 755 "$INSTALL_DIR/atomic-agent" 2>/dev/null || true
elif [ -f "$STAGE/atomic-agent.exe" ]; then
  cp -f "$STAGE/atomic-agent.exe" "$INSTALL_DIR/atomic-agent.exe"
else
  echo "binary not found in archive under $STAGE" >&2
  exit 1
fi

if [ -d "$STAGE/grammars" ]; then
  cp -R "$STAGE/grammars" "$INSTALL_DIR/"
fi
if [ -d "$STAGE/vendor" ]; then
  cp -R "$STAGE/vendor" "$INSTALL_DIR/"
fi
if [ -d "$STAGE/prebuilds" ]; then
  cp -R "$STAGE/prebuilds" "$INSTALL_DIR/"
fi

case ":${PATH:-}:" in
  *":${INSTALL_DIR}:"*) ;; 
  *) echo "add to PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac

if [ "$OS_NAME" = "Darwin" ]; then
  echo
  echo "on first launch, macOS may verify the notarized binary (network). grant Accessibility and Screen"
  echo "Recording if prompted for full os.window/keyboard support."
fi

echo
echo "installed atomic-agent to ${INSTALL_DIR}/atomic-agent"
echo "try: ${INSTALL_DIR}/atomic-agent tui --cwd /path/to/work"

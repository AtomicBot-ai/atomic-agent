#!/usr/bin/env sh
# Install a released atomic-agent CLI (Node SEA) from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AtomicBot-ai/atomic-agent/main/scripts/install.sh | sh
#
# Environment:
#   ATOMIC_AGENT_REPO=owner/atomic-agent   (default: AtomicBot-ai/atomic-agent)
#   ATOMIC_AGENT_VERSION=v0.1.0            (optional: pin a tag; default: latest)
#   ATOMIC_AGENT_INSTALL_DIR=path         (default: $HOME/.local/bin)
#   ATOMIC_AGENT_NO_PATH=1                 (optional: skip rc-file PATH update)

set -eu

# shellcheck disable=SC3043
# POSIX sh: local may not exist; we avoid local for dash compatibility.

REPO_DEFAULT="AtomicBot-ai/atomic-agent"
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

# Atomically replace a directory next to the binary. Copies the fresh tree
# into a temp sibling, removes the old tree (unlinked inodes survive for any
# running process that still maps them), then rename(2)s the new tree in.
# Never overwrites individual files in place under a live process.
replace_dir() {
  _rd_src="$1"
  _rd_dst="$2"
  [ -d "$_rd_src" ] || return 0
  _rd_tmp="${_rd_dst}.tmp.$$"
  rm -rf "$_rd_tmp"
  cp -R "$_rd_src" "$_rd_tmp"
  rm -rf "$_rd_dst"
  mv -f "$_rd_tmp" "$_rd_dst"
}

# Install binary, grammars, native prebuilds, and vendor/ next to the binary.
#
# The binary is written atomically: copy into a temp sibling, then rename(2)
# the new inode over the old name. An in-place `cp -f` would truncate and
# rewrite the SAME inode the running process is still executing from, which
# corrupts the mmap'd code pages — the kernel then faults a page whose content
# no longer matches the (valid) code signature and kills the process with
# SIGKILL in the CODESIGNING namespace ("invalid signature (code or signature
# have been modified)" / "Invalid Page"). A self-update never restarts the
# process, so the live binary MUST keep its own inode.
if [ -f "$STAGE/atomic-agent" ]; then
  _tmp_bin="$INSTALL_DIR/.atomic-agent.tmp.$$"
  cp -f "$STAGE/atomic-agent" "$_tmp_bin"
  chmod 755 "$_tmp_bin" 2>/dev/null || true
  # Verify the signed binary before swapping it in (macOS). A failed --strict
  # check means the downloaded bytes do not match the embedded signature, so
  # launching it would SIGKILL anyway — abort instead of installing it.
  if [ "$OS_NAME" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
    if ! codesign --verify --strict "$_tmp_bin" 2>/dev/null; then
      echo "error: downloaded binary failed 'codesign --verify --strict'; aborting" >&2
      rm -f "$_tmp_bin"
      exit 1
    fi
  fi
  mv -f "$_tmp_bin" "$INSTALL_DIR/atomic-agent"
elif [ -f "$STAGE/atomic-agent.exe" ]; then
  _tmp_bin="$INSTALL_DIR/.atomic-agent.exe.tmp.$$"
  cp -f "$STAGE/atomic-agent.exe" "$_tmp_bin"
  mv -f "$_tmp_bin" "$INSTALL_DIR/atomic-agent.exe"
else
  echo "binary not found in archive under $STAGE" >&2
  exit 1
fi

replace_dir "$STAGE/grammars" "$INSTALL_DIR/grammars"
# Built-in starter skills. The runtime resolves them next to the binary
# (see resolveStarterSkillsSourceDir / seedStarterSkillsIfMissing) and
# copies them into the stateDir on each boot. Without this the skills
# folder is never created on first launch.
replace_dir "$STAGE/starter-skills" "$INSTALL_DIR/starter-skills"
replace_dir "$STAGE/assets" "$INSTALL_DIR/assets"
replace_dir "$STAGE/vendor" "$INSTALL_DIR/vendor"
replace_dir "$STAGE/prebuilds" "$INSTALL_DIR/prebuilds"
# better-sqlite3 (+ bindings + file-uri-to-path) runtime tree. The SEA
# binary's `createRequire` resolver (see src/native/load-better-sqlite3.ts)
# looks these up under `node_modules/` next to the binary.
replace_dir "$STAGE/node_modules" "$INSTALL_DIR/node_modules"

add_to_path() {
  _dir="$1"

  case ":${PATH:-}:" in
    *":${_dir}:"*)
      return 0
      ;;
  esac

  if [ "${ATOMIC_AGENT_NO_PATH:-0}" = "1" ]; then
    echo "add to PATH: export PATH=\"${_dir}:\$PATH\""
    return 0
  fi

  _shell_name=""
  if [ -n "${SHELL:-}" ]; then
    _shell_name="$(basename "$SHELL")"
  fi

  # Prefer literal $HOME in the rc line for portability when using the default dir.
  if [ "$_dir" = "$HOME/.local/bin" ]; then
    _path_expr='$HOME/.local/bin'
  else
    _path_expr="$_dir"
  fi

  case "$_shell_name" in
    zsh)
      _rc="$HOME/.zshrc"
      _line="export PATH=\"${_path_expr}:\$PATH\""
      ;;
    bash)
      if [ "$OS_NAME" = "Darwin" ]; then
        _rc="$HOME/.bash_profile"
      else
        _rc="$HOME/.bashrc"
      fi
      _line="export PATH=\"${_path_expr}:\$PATH\""
      ;;
    fish)
      _rc="$HOME/.config/fish/config.fish"
      _line="set -gx PATH ${_path_expr} \$PATH"
      ;;
    *)
      _rc="$HOME/.profile"
      _line="export PATH=\"${_path_expr}:\$PATH\""
      ;;
  esac

  _marker="# added by atomic-agent installer"

  mkdir -p "$(dirname "$_rc")"
  [ -f "$_rc" ] || : > "$_rc"

  if grep -qsF "$_marker" "$_rc" 2>/dev/null; then
    echo "PATH entry already present in $_rc"
    return 0
  fi

  {
    printf '\n%s\n%s\n' "$_marker" "$_line"
  } >> "$_rc"

  echo "added ${_dir} to PATH via ${_rc}"
  echo "run: source \"${_rc}\"   (or open a new shell)"
}

add_to_path "$INSTALL_DIR"

if [ "$OS_NAME" = "Darwin" ]; then
  echo
  echo "on first launch, macOS may verify the notarized binary (network). grant Accessibility and Screen"
  echo "Recording if prompted for full os.window/keyboard support."
fi

echo
echo "installed atomic-agent to ${INSTALL_DIR}/atomic-agent"
echo "to run:"
echo "atomic-agent"

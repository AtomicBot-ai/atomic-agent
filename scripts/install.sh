#!/usr/bin/env sh
# Install a released atomic-agent CLI (Node SEA) from GitHub Releases.
#
# Usage:
#   curl -fsSL https://atomicagent.io/install | sh
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

have() {
  command -v "$1" >/dev/null 2>&1
}

# Progress UI ---------------------------------------------------------------
#
# curl's default meter paints a three-line table (two header rows plus the
# data row) per transfer, so a plain install scrolls six lines of numbers.
# Both fetchers are silenced below and progress is drawn here instead: a
# single line, redrawn in place, terminated by exactly one newline.
#
# Degrades in this order: no TTY (CI logs, `| tee`) prints one plain line and
# no bar; NO_COLOR or TERM=dumb keeps the bar but drops the colour; a
# non-UTF-8 locale swaps the block glyphs for ASCII.

UI_TTY=0
UI_COLOUR=0
[ -t 1 ] && UI_TTY=1

# Keep a handle on the real stdout. Inside a command substitution fd 1 is the
# capture pipe, so terminal queries made there must go through this instead.
exec 3>&1
if [ "$UI_TTY" = "1" ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  UI_COLOUR=1
fi

if [ "$UI_COLOUR" = "1" ]; then
  # Atomic blue (#0b63f6), 24-bit where the terminal advertises it.
  case "${COLORTERM:-}" in
    truecolor|24bit) C_ACCENT="$(printf '\033[38;2;11;99;246m')" ;;
    *) C_ACCENT="$(printf '\033[38;5;33m')" ;;
  esac
  C_TRACK="$(printf '\033[38;5;239m')"
  C_DIM="$(printf '\033[2m')"
  C_OFF="$(printf '\033[0m')"
else
  C_ACCENT=""
  C_TRACK=""
  C_DIM=""
  C_OFF=""
fi

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]8* | *[Uu][Tt][Ff]-8*)
    BAR_FULL="█"
    BAR_EMPTY="░"
    ;;
  *)
    BAR_FULL="#"
    BAR_EMPTY="-"
    ;;
esac

# Terminal width. Both obvious approaches are wrong inside the command
# substitution that captures this value: fd 1 is the pipe, not the terminal,
# so `stty size` sees nothing, and `tput cols` falls back to the terminfo
# default of 80 regardless of the real window. fd 3 (duped from stdout above)
# still refers to the terminal, so ask through that.
term_cols() {
  _tc="${COLUMNS:-}"
  case "$_tc" in
    '' | *[!0-9]*) _tc="" ;;
  esac
  if [ -z "$_tc" ] && have stty; then
    _tc="$(stty size <&3 2>/dev/null | awk '{ print $2 }')"
    case "$_tc" in
      '' | *[!0-9]*) _tc="" ;;
    esac
  fi
  if [ -z "$_tc" ] && have tput; then
    _tc="$(tput cols 2>/dev/null || echo '')"
    case "$_tc" in
      '' | *[!0-9]*) _tc="" ;;
    esac
  fi
  [ -n "$_tc" ] || _tc=80
  printf '%s' "$_tc"
}

# Line budget: the label, percentage and byte counter take ~52 columns; the
# bar gets what is left, so a narrow window still renders on one line.
BAR_WIDTH=16
if [ "$UI_TTY" = "1" ]; then
  _cols="$(term_cols)"
  if [ "$_cols" -ge 100 ]; then
    BAR_WIDTH=24
  elif [ "$_cols" -lt 78 ]; then
    BAR_WIDTH=8
  fi
fi

file_size() {
  _fs=0
  if [ -f "$1" ]; then
    _fs="$(wc -c < "$1" 2>/dev/null | tr -d ' \t' || echo 0)"
  fi
  case "$_fs" in
    '' | *[!0-9]*) _fs=0 ;;
  esac
  printf '%s' "$_fs"
}

# Total transfer size, or 0 when the server does not say. Redirects are
# followed so this reports the length of the object, not of the 302.
content_length() {
  have curl || { printf '0'; return 0; }
  curl -fsIL --retry 2 "$1" 2>/dev/null | awk '
    { if (tolower($1) == "content-length:") { v = $2; gsub(/\r/, "", v) } }
    END { print (v == "" ? 0 : v) }
  '
}

render_progress() {
  # $1 label, $2 bytes so far, $3 total bytes (0 when unknown)
  _bar="$(awk -v label="$1" -v got="$2" -v total="$3" -v w="$BAR_WIDTH" \
    -v full="$BAR_FULL" -v empty="$BAR_EMPTY" \
    -v a="$C_ACCENT" -v t="$C_TRACK" -v d="$C_DIM" -v o="$C_OFF" '
    function human(b) {
      if (b < 1024) return sprintf("%d B", b)
      if (b < 1048576) return sprintf("%.0f KB", b / 1024)
      return sprintf("%.1f MB", b / 1048576)
    }
    BEGIN {
      if (total <= 0) {
        printf "%s  %s%s%s", label, d, human(got), o
        exit
      }
      frac = got / total
      if (frac > 1) frac = 1
      n = int(frac * w + 0.5)
      done = ""; left = ""
      for (i = 0; i < n; i++) done = done full
      for (i = n; i < w; i++) left = left empty
      printf "%s  %s%s%s%s%s%s  %3d%%  %s%s of %s%s", \
        label, a, done, o, t, left, o, int(frac * 100 + 0.5), d, human(got), human(total), o
    }
  ')"
  printf '\r%s\033[K' "$_bar"
}

fetch() {
  # Silent transfer; the caller owns all output.
  if have curl; then
    curl -fsS -L --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

download() {
  # $1 url, $2 destination, $3 label (omit for a silent transfer)
  _url="$1"
  _out="$2"
  _label="${3:-}"

  if ! have curl && ! have wget; then
    echo "install curl or wget" >&2
    exit 1
  fi

  # Small side files (checksums) and non-interactive runs get no bar.
  if [ -z "$_label" ]; then
    fetch "$_url" "$_out"
    return 0
  fi
  if [ "$UI_TTY" != "1" ]; then
    printf '%s\n' "$_label"
    fetch "$_url" "$_out"
    return 0
  fi

  _total="$(content_length "$_url")"
  : > "$_out"

  fetch "$_url" "$_out" &
  _dl_pid=$!

  while kill -0 "$_dl_pid" 2>/dev/null; do
    render_progress "$_label" "$(file_size "$_out")" "$_total"
    sleep 0.2
  done

  if wait "$_dl_pid"; then
    render_progress "$_label" "$(file_size "$_out")" "$_total"
    printf '\n'
  else
    _rc=$?
    printf '\r\033[K'
    echo "download failed: $_url" >&2
    exit "$_rc"
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

TMPDIR="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "$TMPDIR/atomic-agent-install.XXXXXX")"
# shellcheck disable=SC2064
trap 'rm -rf "$WORK"' EXIT

download "$TAR_URL" "$WORK/${TAR_NAME}" "downloading atomic-agent"
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

  PATH_STATUS="added"
  RC_FILE=""

  case ":${PATH:-}:" in
    *":${_dir}:"*)
      PATH_STATUS="present"
      return 0
      ;;
  esac

  if [ "${ATOMIC_AGENT_NO_PATH:-0}" = "1" ]; then
    PATH_STATUS="manual"
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
  RC_FILE="$_rc"

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
}

add_to_path "$INSTALL_DIR"

if [ "$OS_NAME" = "Darwin" ]; then
  echo
  echo "on first launch, macOS may verify the notarized binary (network). grant Accessibility and Screen"
  echo "Recording if prompted for full os.window/keyboard support."
fi

echo
echo "installed atomic-agent to ${INSTALL_DIR}/atomic-agent"
case "${PATH_STATUS:-added}" in
  present)
    echo "to run:"
    echo "  atomic-agent"
    ;;
  manual)
    echo "atomic-agent is NOT on your PATH yet."
    echo "add ${INSTALL_DIR} to your PATH, then run:"
    echo "  atomic-agent"
    ;;
  *)
    echo "atomic-agent was added to your PATH."
    echo "open a NEW terminal, then run:"
    echo "  atomic-agent"
    if [ -n "${RC_FILE:-}" ]; then
      echo "(to use it in THIS terminal, first reload your shell config: ${RC_FILE})"
    fi
    ;;
esac

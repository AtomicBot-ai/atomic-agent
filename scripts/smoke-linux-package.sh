#!/bin/sh
# Install atomic-agent in a clean container the way README.md tells users to, then check what a
# packaged install promises: the version, /usr/bin symlinks into the tree under /usr/lib, the
# install-source marker, `atomic-agent update` deferring to the package manager, `uninstall
# --dry-run` listing data only and naming the package manager, and a removal that takes the tree
# with it. The release workflow runs it on the draft's repository served from loopback (before
# publishing) and linux-repo.yml on the published repository (after).
#
#   smoke-linux-package.sh apt|dnf <version> <file with the README's install commands>
#   smoke-linux-package.sh pacman <version> <directory with the PKGBUILD>
set -eu

manager=$1
version=$2
input=$3

fail() {
  echo "smoke: $*" >&2
  exit 1
}

# The README's commands use sudo; a container runs as root without it.
sudo_shim() {
  command -v sudo >/dev/null 2>&1 && return 0
  cat >/usr/local/bin/sudo <<'EOF'
#!/bin/sh
exec "$@"
EOF
  chmod +x /usr/local/bin/sudo
}

case $manager in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    echo 'APT::Get::Assume-Yes "true";' >/etc/apt/apt.conf.d/90-smoke
    apt-get update -qq
    apt-get install -qq curl ca-certificates >/dev/null
    sudo_shim
    sh -eux "$input"
    marker=deb
    hint=apt
    pkg=atomic-agent
    ;;
  dnf)
    echo 'assumeyes=True' >>/etc/dnf/dnf.conf
    command -v curl >/dev/null 2>&1 || dnf install -q curl
    sudo_shim
    sh -eux "$input"
    marker=rpm
    hint=dnf
    pkg=atomic-agent
    ;;
  pacman)
    # pacman's download sandbox needs syscalls a container may not grant; the container is the sandbox.
    sed -i -e 's/^#DisableSandboxSyscalls/DisableSandboxSyscalls/' \
      -e 's/^#DisableSandboxFilesystem/DisableSandboxFilesystem/' /etc/pacman.conf
    pacman -Syu --noconfirm --needed base-devel sudo namcap >/dev/null
    useradd -m builder
    echo 'builder ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/builder
    cp -r "$input" /home/builder/pkg
    chown -R builder /home/builder/pkg
    su builder -c 'cd ~/pkg && makepkg -si --noconfirm'
    # namcap is advice, not a gate: it flags things a -bin package does on purpose.
    namcap /home/builder/pkg/PKGBUILD /home/builder/pkg/*.pkg.tar.* || true
    marker=aur
    hint=atomic-agent-bin
    pkg=atomic-agent-bin
    ;;
  *) fail "unknown package manager $manager" ;;
esac

tree=/usr/lib/atomic-agent
test "$(atomic-agent --version)" = "atomic-agent $version" \
  || fail "atomic-agent --version is '$(atomic-agent --version)', expected 'atomic-agent $version'"
test "$(atag --version)" = "atomic-agent $version" || fail "the atag alias does not run the same binary"
test "$(readlink -f /usr/bin/atomic-agent)" = "$tree/atomic-agent" || fail "/usr/bin/atomic-agent is not a symlink into $tree"
test "$(cat "$tree/install-source")" = "$marker" || fail "the install-source marker is not $marker"
# The directories the runtime resolves next to the binary (scripts/package-bundle.ts).
for d in grammars starter-skills node_modules/better-sqlite3 node_modules/playwright-core; do
  test -d "$tree/$d" || fail "$tree/$d is missing"
done
test -x "$tree/vendor/rg" || fail "$tree/vendor/rg is missing or not executable"

if out=$(atomic-agent update 2>&1); then fail "atomic-agent update did not refuse on a packaged install"; fi
echo "$out" | grep -q "$hint" || fail "atomic-agent update did not name the package manager: $out"

# The plan lists data only and names the package manager; the config it creates lives in $HOME.
plan=$(atomic-agent uninstall --dry-run 2>&1) || fail "uninstall --dry-run failed: $plan"
echo "$plan" | grep -q "$hint" || fail "uninstall --dry-run did not name the package manager: $plan"
if echo "$plan" | grep -q "$tree"; then fail "uninstall --dry-run would remove the package's files: $plan"; fi

case $manager in
  apt) apt-get remove -qq "$pkg" >/dev/null ;;
  dnf) dnf remove -q "$pkg" ;;
  pacman) pacman -R --noconfirm "$pkg" >/dev/null ;;
esac
test ! -e /usr/bin/atomic-agent || fail "/usr/bin/atomic-agent is still there after removing the package"
test ! -e /usr/bin/atag || fail "/usr/bin/atag is still there after removing the package"
test ! -e "$tree/atomic-agent" || fail "$tree/atomic-agent is still there after removing the package"
echo "smoke: atomic-agent $version from $manager: ok"

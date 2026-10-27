#!/bin/sh
# Install the desktop app (atomic-agent-desktop) from the repository in a clean container, the way
# README.md tells users to add the repository, then check what the package promises: the version,
# the app under /opt/Atomic Agent with every shared library it loads present (that is what the
# package's dependency list is for), the command on PATH, the bundled agent able to run, and a
# removal that takes it all away. No window is opened: the container has no display.
# linux-repo.yml runs it on the published repository after a desktop release.
#
#   smoke-linux-desktop-package.sh apt|dnf <version> <file with the README's install commands>
set -eu

manager=$1
version=$2
input=$3

pkg=atomic-agent-desktop
app='/opt/Atomic Agent'

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
    # Adds the repository (and installs the CLI, which is fine: the two never share a file).
    sh -eux "$input"
    apt-get install -qq "$pkg" >/dev/null
    installed=$(dpkg-query -W -f '${Version}' "$pkg")
    ;;
  dnf)
    echo 'assumeyes=True' >>/etc/dnf/dnf.conf
    command -v curl >/dev/null 2>&1 || dnf install -q curl
    sudo_shim
    sh -eux "$input"
    dnf install -q "$pkg"
    installed=$(rpm -q --qf '%{VERSION}' "$pkg")
    ;;
  *) fail "unknown package manager $manager" ;;
esac

test "$installed" = "$version" || fail "$pkg is at version '$installed', expected '$version'"
test -x "$app/atomic-agent-desktop" || fail "$app/atomic-agent-desktop is missing or not executable"
test "$(readlink -f /usr/bin/atomic-agent-desktop)" = "$app/atomic-agent-desktop" \
  || fail "/usr/bin/atomic-agent-desktop does not point at $app"
test -f /usr/share/applications/atomic-agent-desktop.desktop || fail "the .desktop file is missing"

# Every shared library the app loads must come with the package's dependencies.
missing=$(ldd "$app/atomic-agent-desktop" | grep 'not found' || true)
test -z "$missing" || fail "the app lacks libraries the package should depend on:
$missing"

# The agent inside the app is the same SEA binary the CLI ships; it must start here.
agent="$app/resources/agent/atomic-agent"
test -x "$agent" || fail "$agent is missing or not executable"
"$agent" --version | grep -q '^atomic-agent ' || fail "the bundled agent does not run: $("$agent" --version 2>&1)"

case $manager in
  apt) apt-get remove -qq "$pkg" >/dev/null ;;
  dnf) dnf remove -q "$pkg" ;;
esac
test ! -e /usr/bin/atomic-agent-desktop || fail "/usr/bin/atomic-agent-desktop is still there after removing the package"
test ! -e "$app/atomic-agent-desktop" || fail "$app/atomic-agent-desktop is still there after removing the package"
echo "smoke: $pkg $version from $manager: ok"

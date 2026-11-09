#!/bin/bash
# Atomic Agent desktop .deb: after install (ATO-1229).
#
# electron-builder renders this file (deb.afterInstall in electron-builder.cjs)
# and replaces the two macros in it: the app's install folder under /opt and
# its executable. Every other variable here is written $NAME or "$NAME",
# never with braces around a plain name, because electron-builder would take
# that for a macro and stop the build.
#
# It is electron-builder 26's own after-install script with two changes:
#
# 1. It never fails the install. electron-builder's ends with an unguarded
#    `apparmor_parser --replace`, so a parser error left dpkg with a
#    half-configured package. Every step here is guarded and the script
#    exits 0.
# 2. chrome-sandbox is root:root and setuid (4755) whenever the app cannot
#    use unprivileged user namespaces: no user namespaces in the kernel, or
#    Ubuntu 23.10+ restricting them (kernel.apparmor_restrict_unprivileged_userns=1)
#    while the AppArmor profile below did not load. electron-builder's
#    script only tests `unshare --user` as root, which always works, so on
#    Ubuntu 24.04 with no loaded profile Electron had no usable sandbox and
#    did not start. With the profile loaded, chrome-sandbox stays 0755 and
#    Electron uses its namespace sandbox, as before.
#
# The AppArmor profile is electron-builder's (resources/apparmor-profile:
# `userns,` for this executable, unconfined otherwise). It needs AppArmor 4
# (abi/4.0, Ubuntu 24.04); older AppArmor (Debian 12, Ubuntu 22.04) does not
# restrict user namespaces and skips it.

APP_DIR='/opt/${sanitizedProductName}'
EXE_NAME='${executable}'
BIN="$APP_DIR/$EXE_NAME"
SANDBOX="$APP_DIR/chrome-sandbox"
PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
PROFILE_TARGET="/etc/apparmor.d/$EXE_NAME"

# /usr/bin link (as electron-builder's script).
if type update-alternatives >/dev/null 2>&1; then
    # Remove a previous link that does not use update-alternatives.
    if [ -L "/usr/bin/$EXE_NAME" ] && [ -e "/usr/bin/$EXE_NAME" ] && [ "$(readlink "/usr/bin/$EXE_NAME")" != "/etc/alternatives/$EXE_NAME" ]; then
        rm -f "/usr/bin/$EXE_NAME" || true
    fi
    update-alternatives --install "/usr/bin/$EXE_NAME" "$EXE_NAME" "$BIN" 100 || ln -sf "$BIN" "/usr/bin/$EXE_NAME" || true
else
    ln -sf "$BIN" "/usr/bin/$EXE_NAME" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# AppArmor profile (Ubuntu 24.04+). The dry run (--skip-kernel-load --debug)
# tells whether this AppArmor understands the profile at all.
profile_loaded=0
if [ -f "$PROFILE_SOURCE" ] && hash apparmor_parser 2>/dev/null && apparmor_status --enabled >/dev/null 2>&1; then
    if apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" >/dev/null 2>&1; then
        if cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET" 2>/dev/null; then
            # In a chroot (image builds) the profile is only installed; it loads at boot.
            if [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then
                :
            elif apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE_TARGET" >/dev/null 2>&1; then
                profile_loaded=1
            else
                echo "Atomic Agent: could not load the AppArmor profile $PROFILE_TARGET; using the setuid sandbox helper instead."
            fi
        fi
    else
        echo "Atomic Agent: this AppArmor does not support the bundled profile (it needs AppArmor 4); skipping it."
    fi
fi

# Can the app create a user namespace without root? If not, chrome-sandbox
# must be the setuid helper or Electron has no sandbox and will not start.
userns_blocked=0
[ -L /proc/self/ns/user ] || userns_blocked=1
[ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ] && userns_blocked=1
[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] && userns_blocked=1
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] && [ "$profile_loaded" -eq 0 ]; then
    userns_blocked=1
fi

if [ -f "$SANDBOX" ]; then
    chown root:root "$SANDBOX" 2>/dev/null || true
    if [ "$userns_blocked" -eq 1 ]; then
        chmod 4755 "$SANDBOX" || true
    else
        chmod 0755 "$SANDBOX" || true
    fi
fi

exit 0

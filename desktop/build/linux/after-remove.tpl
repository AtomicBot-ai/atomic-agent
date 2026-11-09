#!/bin/bash
# Atomic Agent desktop .deb: after remove (ATO-1229). The counterpart of
# after-install.tpl: electron-builder 26's own script, guarded so it never
# fails a removal. Variables are written $NAME, never with braces around a
# plain name (electron-builder would read that as a macro).

APP_DIR='/opt/${sanitizedProductName}'
EXE_NAME='${executable}'
BIN="$APP_DIR/$EXE_NAME"
PROFILE_TARGET="/etc/apparmor.d/$EXE_NAME"

# The /usr/bin link. update-alternatives --remove takes the registered binary,
# not the /usr/bin link.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove "$EXE_NAME" "$BIN" >/dev/null 2>&1 || true
else
    rm -f "/usr/bin/$EXE_NAME" || true
fi

# Unload the AppArmor profile before deleting it, so it is not left enforced
# until the next reboot. Not in a chroot, where nothing is loaded live.
if [ -f "$PROFILE_TARGET" ]; then
    if apparmor_status --enabled >/dev/null 2>&1 && hash apparmor_parser 2>/dev/null; then
        if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
            apparmor_parser --remove "$PROFILE_TARGET" >/dev/null 2>&1 || true
        fi
    fi
    rm -f "$PROFILE_TARGET" || true
fi

exit 0

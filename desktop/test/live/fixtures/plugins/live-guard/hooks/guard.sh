# Records every call it sees, then refuses a write to any file named forbidden-*.
input=$(cat)
mkdir -p "$CLAUDE_PROJECT_DIR/.hook-marks"
printf '%s\n' "$input" >> "$CLAUDE_PROJECT_DIR/.hook-marks/pre.log"
case "$input" in
  *forbidden-*)
    echo "live-guard refuses this file, rule tern-gate-5521" >&2
    exit 2
    ;;
esac
exit 0

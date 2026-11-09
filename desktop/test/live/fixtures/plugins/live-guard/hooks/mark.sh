# Leaves one line per finished tool call.
input=$(cat)
mkdir -p "$CLAUDE_PROJECT_DIR/.hook-marks"
printf '%s\n' "$input" >> "$CLAUDE_PROJECT_DIR/.hook-marks/post.log"
exit 0

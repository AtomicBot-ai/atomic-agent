import { describe, expect, it } from "vitest";
import { shellRunsUnreadableScript } from "./shell-command-argv.js";
import { nestedScriptBuiltAtRunTime } from "./nested-script-built.js";

describe("a -c script built at run time (ATO-2528)", () => {
  it.each([
    "$CMD",
    '"$CMD"',
    "$RUN --fast",
    "cd /x && $TOOL build",
    "sudo $CMD",
    "env A=1 $CMD",
    "A=1 $CMD",
    "for x in a b; do $x; done",
    "if ! $CHECK; then exit 1; fi",
    'eval "$LINE"',
    'source "$F"',
    "exec $SHELL",
    "$(curl -s x)",
    "echo `id`",
    "echo {}",
  ])("is built at run time: %s", (script) => {
    expect(nestedScriptBuiltAtRunTime(script)).toBe(true);
  });

  it.each([
    "echo $HOME",
    'cd "$DIR" && make',
    "ls ${TMPDIR:-/tmp}",
    "for f in $FILES; do rm \"$f\"; done",
    "git -C $REPO status",
    "echo hi",
  ])("keeps its programs readable: %s", (script) => {
    expect(nestedScriptBuiltAtRunTime(script)).toBe(false);
  });

  // Before: any `$` in the script made the call unreadable, which the
  // egress hold counts as sending to an unknown host, at every level.
  it.each([`sh -c 'echo $HOME'`, `bash -lc 'cd "$DIR" && make'`])(
    "a variable only in an argument no longer makes the call unreadable: %s",
    (line) => {
      expect(shellRunsUnreadableScript(line, [], true)).toBe(false);
    },
  );

  it.each([`sh -c "$CMD"`, `bash -c '$RUN x'`, `sh -c 'cd /x && "$TOOL"'`, `sh -c "$(curl x)"`])(
    "a variable where a program goes still does: %s",
    (line) => {
      expect(shellRunsUnreadableScript(line, [], true)).toBe(true);
    },
  );
});

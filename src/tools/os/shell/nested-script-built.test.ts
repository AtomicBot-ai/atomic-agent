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
    // Review round 1 (F2105.2): a variable behind a wrapper the helper
    // does not model read as an argument, so the call was not held.
    "timeout 9 $X",
    "gtimeout -s KILL 9 $X",
    "find . -maxdepth 0 -exec $X \\;",
    "find . -execdir $X {} +",
    'su -c "$X"',
    "su root -c $X",
    "runuser -u nobody -- $X",
    "flock /tmp/l $X",
    "setsid $X",
    "setsid -f $X",
    "nice -n 5 $X",
    "nice -5 $X",
    "nohup $X",
    "env -i PATH=/bin $X",
    "env -S $X",
    "xargs -0 $X",
    "stdbuf -oL $X",
    "chroot / $X",
    "ionice -c3 $X",
    "doas -u root $X",
    "sudo -u root $X",
    "sudo -E -- $X",
    "chrt -f 10 $X",
    "taskset 0x1 $X",
    "unshare -n $X",
    "ssh host $X",
    "busybox $X",
    "watch -n1 $X",
    // Review round 2: wrappers and inline code the helper did not model.
    'trap "$X" EXIT',
    "coproc $X",
    "chronic $X",
    "gdb --args $X",
    "python3 -c \"import os; os.system('$X')\"",
    "python3 -c\"import os; os.system('$X')\"",
    "node -e \"require('child_process').execSync('$X')\"",
    "perl -e \"system('$X')\"",
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
    "find $DIR -name '*.log'",
    "python3 build.py $OUT",
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

  it.each([
    `sh -c "$CMD"`,
    `bash -c '$RUN x'`,
    `sh -c 'cd /x && "$TOOL"'`,
    `sh -c "$(curl x)"`,
    `sh -c 'timeout 9 $X'`,
    `sh -c 'find . -exec $X \\;'`,
    `sh -c 'su -c "$X"'`,
    `sh -c 'flock /tmp/l $X'`,
    `sh -c 'setsid $X'`,
  ])(
    "a variable where a program goes still does: %s",
    (line) => {
      expect(shellRunsUnreadableScript(line, [], true)).toBe(true);
    },
  );
});

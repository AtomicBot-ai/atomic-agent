#!/usr/bin/env python3
"""Session-swap paint regression for Ink incremental rendering (ATO-648).

Under Ink 7, `incrementalRendering: true` lost the session rail's fill
after `ctrl+g n`: driven over a PTY at 120x34 into a pyte grid, the rows
carrying a non-default background in the left 40 columns went from 33 to
1. `src/tui/ink-render-options.ts` keeps incremental rendering off until
this script passes on the current Ink.

It runs the built TUI (`dist/cli/index.js tui`) twice in a real PTY, once
with incremental rendering forced on (ATOMIC_AGENT_INK_INCREMENTAL=1) and
once with the default full-frame repaint as the control, and for each run
counts the painted rows before and after `ctrl+g n`. It passes when every
run paints the same rows before and after the swap, and that count is the
expected one (33 by default).

Usage, from the repo root, after `npm run build`:

    python3 -m venv /tmp/aa-pyte && /tmp/aa-pyte/bin/pip install pyte
    /tmp/aa-pyte/bin/python scripts/tui-session-swap-paint.py

Options: --mode on|off|both (default both), --expect N (default 33, or
`any` to only require before == after), --node PATH, --keep (leave the
temporary state dir and the raw .ansi capture for inspection).

Needs Node 25 on PATH (or --node). No model, network or credentials: the
TUI starts with --skip-llama-setup on a throwaway ATOMIC_AGENT_STATE_DIR.
"""
import argparse
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time

try:
    import pyte
except ImportError:
    sys.stderr.write("pyte is not installed: python3 -m pip install pyte (or use a venv)\n")
    sys.exit(2)

COLS, ROWS = 120, 34
PROBE_COLS = 40  # the rail's width; the 33 -> 1 measurement counted these
REPO = pathlib.Path(__file__).resolve().parent.parent
CLI = REPO / "dist" / "cli" / "index.js"
# `ctrl+g` and its chord key must be two writes: one write arrives as one
# Ink input event and the leader never sees a second key. The leader
# window is 1500 ms (MENU_LEADER_WINDOW_MS), so stay well inside it.
CHORD_GAP_S = 0.3
STARTUP_TIMEOUT_S = 90
SETTLE_S = 3.0
SAMPLE_EVERY_S = 0.5


class Tty:
    def __init__(self, node, incremental, state_dir):
        env = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "TMPDIR") if k in os.environ}
        env.update({
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "LANG": "en_US.UTF-8",
            "ATOMIC_AGENT_STATE_DIR": str(state_dir),
            "ATOMIC_AGENT_TUI_SKIP_LLAMA_SETUP": "1",
            "ATOMIC_AGENT_ANALYTICS": "off",
            "ATOMIC_AGENT_UPDATE_CHECK_ON_STARTUP": "false",
            "ATOMIC_AGENT_BROWSER_ENABLED": "false",
            "ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED": "false",
            "ATOMIC_AGENT_GRAMMARS_DIR": str(REPO / "grammars"),
        })
        if incremental:
            env["ATOMIC_AGENT_INK_INCREMENTAL"] = "1"
        self.raw = bytearray()
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(REPO)  # grammars and other assets resolve against cwd
            args = [node, str(CLI), "tui", "--skip-llama-setup", "--cwd", str(REPO)]
            os.execve(node, args, env)
        self.pid, self.fd = pid, fd
        # Size the PTY after the fork, before the app reads it.
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    def pump(self, seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    part = os.read(self.fd, 65536)
                except OSError:
                    return
                if not part:
                    return
                self.raw.extend(part)
                self.stream.feed(part)

    def send(self, data, then=0.2):
        os.write(self.fd, data)
        self.pump(then)

    def painted_rows(self):
        rows = []
        for y in range(ROWS):
            line = self.screen.buffer[y]
            rows.append(any(line[x].bg not in ("default", None) for x in range(PROBE_COLS)))
        return rows

    def sample(self):
        """Several frames over SETTLE_S, never one: returns the last and whether it held."""
        counts = []
        deadline = time.monotonic() + SETTLE_S
        while time.monotonic() < deadline:
            self.pump(SAMPLE_EVERY_S)
            counts.append(sum(self.painted_rows()))
        stable = len(counts) >= 2 and counts[-1] == counts[-2]
        return counts[-1], stable, counts

    def wait_for_first_paint(self):
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        while time.monotonic() < deadline:
            self.pump(0.5)
            if sum(self.painted_rows()) > 0:
                return True
        return False

    def close(self):
        # ctrl+c is a two-press chord with exitOnCtrlC off.
        for _ in range(2):
            try:
                self.send(b"\x03", CHORD_GAP_S)
            except OSError:
                break
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            done, _ = os.waitpid(self.pid, os.WNOHANG)
            if done:
                break
            self.pump(0.2)
        else:
            os.kill(self.pid, signal.SIGTERM)
            time.sleep(1)
            if os.waitpid(self.pid, os.WNOHANG)[0] == 0:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        os.close(self.fd)

    def row_map(self):
        return "".join("#" if p else "." for p in self.painted_rows())


def run(node, incremental, keep):
    work = pathlib.Path(tempfile.mkdtemp(prefix="aa-swap-paint-"))
    state = work / "state"
    state.mkdir()
    tty = Tty(node, incremental, state)
    result = {"incremental": incremental, "workDir": str(work)}
    try:
        if not tty.wait_for_first_paint():
            result["error"] = f"no painted rows within {STARTUP_TIMEOUT_S}s"
            return result
        before, before_stable, before_samples = tty.sample()
        result.update(before=before, beforeStable=before_stable,
                      beforeSamples=before_samples, beforeMap=tty.row_map())
        tty.send(b"\x07", CHORD_GAP_S)  # ctrl+g
        tty.send(b"n", 0.2)             # session.new
        after, after_stable, after_samples = tty.sample()
        result.update(after=after, afterStable=after_stable,
                      afterSamples=after_samples, afterMap=tty.row_map(),
                      afterText="\n".join(tty.screen.display))
    finally:
        tty.close()
        (work / "full.ansi").write_bytes(tty.raw)
        if not keep:
            shutil.rmtree(work, ignore_errors=True)
            result.pop("workDir")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=("on", "off", "both"), default="both")
    parser.add_argument("--expect", default="33")
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--keep", action="store_true")
    opts = parser.parse_args()
    if not CLI.exists():
        sys.stderr.write(f"{CLI} not found: run `npm run build` first\n")
        return 2
    modes = {"on": [True], "off": [False], "both": [True, False]}[opts.mode]
    expect = None if opts.expect == "any" else int(opts.expect)
    failures = []
    results = []
    for incremental in modes:
        r = run(opts.node, incremental, opts.keep)
        results.append(r)
        label = "incremental: " + ("true " if incremental else "false")
        if "error" in r:
            failures.append(f"{label}: {r['error']}")
            continue
        print(f"{label}  before {r['before']:>2}  after {r['after']:>2}"
              f"   before {r['beforeMap']}   after {r['afterMap']}")
        if not (r["beforeStable"] and r["afterStable"]):
            failures.append(f"{label}: frame still changing ({r['beforeSamples']} / {r['afterSamples']})")
        if r["after"] != r["before"]:
            failures.append(f"{label}: {r['before']} painted rows before ctrl+g n, {r['after']} after")
        elif expect is not None and r["before"] != expect:
            failures.append(f"{label}: {r['before']} painted rows, expected {expect}")
    if failures:
        print(json.dumps(results, indent=2))
        for f in failures:
            print("FAIL " + f)
        return 1
    print(f"PASS session swap keeps the painted rows ({', '.join(str(r['after']) for r in results)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

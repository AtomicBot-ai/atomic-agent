# Overnight soak

Leaves the real app working for hours to find what only shows up with time:
memory that keeps growing, turns that get slower, a crash at turn 900.

Real window, real `atag serve` from this checkout, real tools and real clicks.
Only the model is scripted, with a delay, so it needs no GPU and no key.
Everything lives in a throwaway directory.

## Running it

Build the agent at the repo root first (`npm run build`), then from `desktop/`:

    npm run soak

| Variable | Default | Meaning |
|---|---|---|
| `ATAG_SOAK_HOURS` | `6` | How long to keep working. `0.1` is a quick check that it runs. |
| `ATAG_SOAK_OUT` | `$TMPDIR/atag-soak` | Where the CSV files and the verdict go. Set this for a real night. |
| `ATAG_LIVE_PORT` | `9414` | Debugging port. It is the one `smoke:live` uses, so run one at a time. |

It uses the same stand as the live smoke tier. On a Mac it runs `caffeinate`
for as long as it runs. A window stays open, so use the second Mac.

## What it does

Turns with tool calls (read, write with an approval click, shell, plain reply)
in one long chat. Every 29 turns a new chat, every 7 a visit to an earlier one,
every 13 a real click on Stop while the model is answering.

## What it writes

- `soak-<time>-samples.csv`: one row a minute with RSS of the Electron main
  process, the renderer and `atag serve`, their open files, and turn latency for
  that minute. Each row is appended as it is taken, so it survives a crash.
- `soak-<time>-turns.csv`: one row per turn, Stop, switch and new chat.
- `soak-<time>-verdict.txt`: the same verdict the console prints.

## The verdict

It stops at the first crash or hang and prints the verdict. It also prints one
when the time is up and on Ctrl+C.

The run fails on any of these:

- the Electron main process, the window's renderer or `atag serve` is gone or
  was replaced, including a restart that recovered by itself;
- a turn ran past the hang limit, or did not end with its reply and its file;
- the late median of turn latency is over the set factor of the early median;
- memory grows faster than the set slope, leaving out the first 30 minutes.

A run too short to judge something says "not judged" for it. Open files are
reported but not judged.

| Exit code | Meaning |
|---|---|
| 0 | pass |
| 1 | fail |
| 3 | could not run: the agent or the desktop is not built |

The thresholds are constants at the top of `soak.mjs`. They are first guesses:
tune them from the CSV of the first real night.

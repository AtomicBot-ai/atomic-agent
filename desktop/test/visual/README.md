# desktop/test/visual: screenshot diff against baselines

Shoots a fixed set of desktop screens and compares each with a baseline
picture taken earlier on the same OS. A screen that moved, lost a border,
overflowed or switched colour shows up as a red diff in `report.html`,
before a user sees it.

```sh
cd desktop
npm run visual          # build, shoot, compare; exit 1 if anything changed
npm run visual:update   # build, shoot, write the shots as the new baselines
```

Results land in `test/visual/out/` (ignored by git): `actual/`, `baseline/`,
`diff/`, `report.html` and `summary.json`. Open `report.html`: the counts are
at the top, then every shot with before, after and difference, changed ones
first.

## What is shot

`screens.mjs`: first run (title card, setup, providers, API key), the empty
chat, a chat with a fixed answer, the slash menu, Settings (General and
Models), the model picker and the download card. Each in the light and the
dark theme, at 1100x700, 1470x923 and 1920x1080, plus 1470x923 at 1.5x
(`matrix.mjs`). That is 11 screens x 2 themes x 4 sizes = 88 shots.

Narrow a run from the environment:

| variable | example | default |
| --- | --- | --- |
| `VISUAL_VARIANTS` | `1470x923@1,1470x923@1.5` | the four sizes above |
| `VISUAL_THEMES` | `dark` | `light,dark` |
| `VISUAL_SCREENS` | `settings-general,model-picker` | all |
| `VISUAL_PIXEL_THRESHOLD` | `0.1` | `0.1` (pixelmatch colour tolerance) |
| `VISUAL_MAX_DIFF_RATIO` | `0.005` | `0.001` (0.1% of the pixels) |
| `VISUAL_BASELINES` | a folder | `test/visual/baselines/<process.platform>` |
| `VISUAL_OUT` | a folder | `test/visual/out` |
| `VISUAL_PORT` | `9496` | `9495` |

A screen is reached through renderer hooks that already exist (`window.__obOpen`,
`__settingsOpen`, `__selOpen`, `__dlSeed` and so on). If a hook disappears,
the screen is listed under "Screens left out" in the report instead of failing
in a confusing way. Add a screen by adding an entry to `SCREENS` with the hooks
it needs.

## How shots are kept stable

`stabilize.mjs`: animations, transitions and the caret are switched off by an
injected stylesheet, `prefers-reduced-motion` is on, the clock is frozen at
27 Nov 2026 12:00 UTC with the timezone set to UTC and the locale to en-US,
the pointer is parked in the bottom-right corner, any `x.y.z` version in the
visible text reads `0.0.0`, and the vendored fonts are awaited with the same
check `visual.drive.mjs` makes. Model replies are never live: the chat
screen pushes a fixed question and answer. Each run uses a throwaway state
dir, checked by `state-guard.mjs`.

If the fonts do not load, the run fails and `visual:update` refuses to write
baselines: shots with fallback letterforms are not worth keeping.

## Baselines

Baselines are per OS, because fonts and scrollbars render differently:
`baselines/darwin/` (taken on the second Mac) and `baselines/win32/` (taken
by the Windows CI job). A shot with no baseline is reported as **new** and
never fails the run.

### Changing the UI in a PR

1. Run `npm run visual`. Red shots are the ones your change touched.
2. If every red shot is intended, run `npm run visual:update` and commit the
   changed PNGs under `baselines/<os>/` in the same PR.
3. Put the `report.html` before/after pictures (or a screenshot of them) in
   the PR description.

### Who approves a baseline change

The PR reviewer. A changed or new baseline PNG in a diff is a UI change and
is approved like code: look at before and after, and reject anything that
was not meant. A baseline is never updated just to make the run green.

To drop a screen's baselines, delete its PNG files; `visual:update` does not
delete files for screens that no longer exist.

## The per-release summary for the product owner

Once per release, the combined run on the second Mac includes
`npm run visual` against the baselines of the previous release. Its
`report.html` is the "what changed visually" summary: send that one page
(changed shots first, before and after side by side), not single shots.
After the release is approved, run `npm run visual:update` on the same
checkout and commit the new baselines, so the next release compares with
this one.

## Windows

`.github/workflows/desktop-visual-windows.yml` runs the same suite on a
GitHub Windows runner against `baselines/win32/` with a softer limit, and
uploads `report.html`, the shots and the diffs as artifacts. While
`baselines/win32/` is empty the job passes and its `actual/` shots can be
committed as the first Windows baselines.

## Files

| file | job |
| --- | --- |
| `run.mjs` | the entry point: launch, walk the matrix, compare, write the report |
| `screens.mjs` | the screen list and how to reach each one |
| `matrix.mjs` | sizes, scales, themes, file names (pure) |
| `stabilize.mjs` | what is pinned before a shot |
| `compare.mjs` | pixelmatch + pngjs, the only file that loads them |
| `verdict.mjs` | thresholds, per-shot status, exit code (pure) |
| `report.mjs` | `report.html` (pure) |
| `launch.mjs` | drive.mjs `launch` on macOS/Linux, a taskkill-aware launch on Windows |

Unit tests for the pure parts are `test/visual-*.test.mjs` (the
`test:unit` glob only reads `test/*.test.mjs`).

---
name: motion
description: "Make a short MP4 from code with no video credits: release announcement, big number or logo reveal. Fills an HTML template, captures its frames, joins them with ffmpeg."
version: 1.0.0
requires_tools:
  - skill.run_script
  - os.fs.read
  - os.fs.write
  - os.shell.run
requires_scripts:
  - render-frames.mjs
dangerous: false
---

# motion

Three ready video templates, built as plain HTML pages whose animation is
driven by one time value. Fill in the text, render every frame, join the
frames into an MP4. No video model, no credits, works offline.

| Template | Length | For |
|---|---|---|
| `templates/release.html` | 6 s | A release: product, version, headline, up to 5 points, a link. |
| `templates/big-number.html` | 5 s | One number that counts up: "6.4x faster", "12,000 downloads". |
| `templates/logo-reveal.html` | 4 s | A logo (or a drawn mark), the name, a tagline. |

All three use light, colourful backgrounds. Keep them light: no black or
near-black backgrounds (pass light hex colours in `bg`).

## Parameters

Everything is set in the URL query, so the files never need editing.

| Template | Params (defaults in brackets) |
|---|---|
| all | `w` [1920], `h` [1080] (use `w=1080&h=1920` for vertical, `w=1080&h=1080` for square); `accent`, `ink` (hex, no `#`); `bg` (2 or 3 hex colours, comma separated) |
| release | `product` [Atomic Agent], `version` [v1.0], `headline`, `items` (points separated by `\|`), `cta` [atomicagent.io] |
| big-number | `value` (`6.4`, `12000`; decimals are kept), `prefix`, `suffix` [x], `label`, `caption` (where the number comes from), `brand` [Atomic Agent, empty hides it] |
| logo-reveal | `logo` (image path or URL; without it a drawn atom mark is used), `name` [Atomic Agent], `tagline` |

URL-encode values (space as `%20`). Use the product name "Atomic Agent"
when the video is about it. For `big-number`, use only a number the user
gave, and put its source in `caption` (for example "Our measurement").
Never make up a number for the video.

## Frame contract

Any page that follows this contract can be rendered the same way, so the
user can also write their own template:

- `window.__setTime(t)` draws the frame at `t` seconds, synchronously, and
  stops the preview loop. Nothing on the page may depend on the wall
  clock, random numbers or network timing.
- `?t=<seconds>` in the URL draws that one frame at load and does not
  animate (for one-screenshot-per-frame capture).
- `window.__duration` (seconds) and `window.__fps` (suggested, 30). The
  duration is also in `<meta name="motion:duration" content="6">`.
- `window.__ready === true` (and `data-ready="1"` on `<html>`) once fonts
  and images are loaded. Wait for it before the first frame.
- Opened without `t`, the page plays in a loop, so it can be previewed in
  any browser. `autoplay=0` turns the loop off.
- The page is exactly `w` x `h` CSS pixels at device scale 1.

## How to render

1. **Pick the template and fill the params** from what the user asked.
   Ask only for what is missing (the version and headline for a release,
   the number and its label for big-number).
2. **Preview one frame** before rendering the whole video: take a
   screenshot of the page at a late time (for example `t=5` for release)
   and look at it, so long text that overflows is caught early. Shorten
   the text if it does not fit.
3. **Render.**
   - **If this agent has an HTML-to-MP4 tool** (a video tool that takes an
     HTML file or URL and produces an MP4; it is being added for "Studio"),
     use it: give it the template path with the params in the query, the
     duration from the table, 30 fps and the size. It follows the same
     frame contract.
   - **Otherwise use the bundled script**, which needs Chrome (or
     Chromium, Edge) and `ffmpeg`:

     ```json
     [{ "tool": "skill.run_script", "args": { "skill": "motion", "script": "render-frames.mjs", "args": ["release", "./release-v0.7.0.mp4", "--params", "version=v0.7.0&headline=Desktop%20and%20terminal%20in%20one&items=Faster%20replies%7CNew%20tools", "--w", "1920", "--h", "1080"] } }]
     ```

     The first argument is a template name (`release`, `big-number`,
     `logo-reveal`) or a path to the user's own HTML file. Options:
     `--params`, `--fps` [30], `--w`, `--h`, `--duration` (default: the
     template's meta tag), `--keep-frames`. It drives one headless Chrome
     over the DevTools protocol (or Playwright if it is installed), calls
     `window.__setTime(t)` for every frame, saves PNGs to a temp folder
     and runs `ffmpeg` with H.264, `yuv420p`, CRF 18. `CHROME_PATH` and
     `FFMPEG_PATH` override the binaries.
   - **If `ffmpeg` is missing**, offer to install it (see the `ffmpeg`
     skill). **If no Chrome is found**, ask the user to install Chrome or
     set `CHROME_PATH`.
4. **Check the result**: `ffprobe` the file for duration and size, and
   extract one frame near the end to look at it:
   `ffmpeg -ss 4 -i out.mp4 -frames:v 1 check.png`.

Rendering takes a while (every frame is a screenshot). Tell the user
before starting a long or high-resolution render.

## Doing it by hand

If neither the tool nor the script can run, the steps are the same in any
headless browser: open the page with `autoplay=0`, wait for
`window.__ready`, then for `i` from 0 to `duration * fps - 1` call
`window.__setTime(i / fps)` and save a screenshot as
`frame_00001.png`, `frame_00002.png`, and so on. Then:

```
ffmpeg -framerate 30 -i frame_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart out.mp4
```

## What to report

The MP4 path, its duration and size from `ffprobe`, the params used, and
the checked frame attached with `reply.attachments`.

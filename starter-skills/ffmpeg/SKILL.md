---
name: ffmpeg
description: Process audio and video with the `ffmpeg` / `ffprobe` CLIs — convert, trim, extract audio, resize, change format, make GIFs, inspect media. Use for any audio/video transformation.
version: 1.0.1
requires_tools:
  - os.shell.run
dangerous: false
---

# ffmpeg

Transform audio and video files with [`ffmpeg`](https://ffmpeg.org/) and inspect
them with `ffprobe`. Operations are non-destructive: always write to a new
output file. Re-encoding can be slow on long media — set realistic expectations.

## Setup health check (run first, every session)

Verify with **one solo step**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "ffmpeg", "args": ["-version"] } }]
```

Outcome map:
- `exit 0` + version → ready, proceed.
- `command not found: ffmpeg` → enter **Setup playbook → "ffmpeg missing"**.

## Setup playbook (when prerequisites are missing)

### ffmpeg missing

Reply (solo `reply` step):

> "`ffmpeg` is not installed. I can install it: `brew install ffmpeg`. Install it?"

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "ffmpeg"] } }]
```

On Linux: `apt-get install ffmpeg`.

## When to use

- "Convert this video/audio to <format>", "extract the audio from this mp4".
- "Trim from 0:30 to 1:00", "resize to 720p", "make a GIF from this clip".
- "What codec / duration / resolution is this file?" (use `ffprobe`).

## When NOT to use

- Downloading media from URLs — that's `yt-dlp` territory (separate skill).
- Still-image editing — use the `imagemagick` skill.
- Lossless container-only edits where a remux suffices — still fine here, just
  use `-c copy` to avoid re-encoding.

## Common operations

All examples invoke `os.shell.run`. Inspect first with `ffprobe`; the approval
gate surfaces each write. Use `-c copy` to remux without re-encoding when only
the container changes.

| Goal | cmd / args |
|---|---|
| Inspect media | `ffprobe` `["-hide_banner", "in.mp4"]` |
| Convert MOV → MP4 | `ffmpeg` `["-i", "in.mov", "-c:v", "libx264", "-c:a", "aac", "out.mp4"]` |
| Extract audio (MP3) | `ffmpeg` `["-i", "in.mp4", "-vn", "-q:a", "2", "out.mp3"]` |
| Trim (start 30s, 30s long) | `ffmpeg` `["-ss", "00:00:30", "-i", "in.mp4", "-t", "30", "-c", "copy", "clip.mp4"]` |
| Resize to 720p | `ffmpeg` `["-i", "in.mp4", "-vf", "scale=-2:720", "out_720p.mp4"]` |
| Video → GIF | `ffmpeg` `["-i", "in.mp4", "-vf", "fps=12,scale=480:-1", "out.gif"]` |
| Extract one frame | `ffmpeg` `["-ss", "00:00:05", "-i", "in.mp4", "-frames:v", "1", "frame.png"]` |
| Remux only (fast) | `ffmpeg` `["-i", "in.mkv", "-c", "copy", "out.mp4"]` |

## Rules

1. Always write to a NEW output path; never overwrite the source.
2. Inspect with `ffprobe` first when unsure of codecs/duration/resolution.
3. Warn the user that long re-encodes can take a while; prefer `-c copy` when
   only the container changes.
4. Echo the output path (and `ffprobe` duration if relevant) after each run.

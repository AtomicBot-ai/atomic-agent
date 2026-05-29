---
name: imagemagick
description: Edit and convert images with the ImageMagick `magick` CLI — resize, crop, convert format, compress, rotate, montage, annotate. Use for any still-image transformation.
version: 1.0.0
requires_tools:
  - os.shell.run
  - vision.describe
dangerous: false
---

# imagemagick

Transform still images with [ImageMagick](https://imagemagick.org/) v7
(`magick` command). Pairs well with `vision.describe` — describe an image to
decide what to do, then operate on it here. Always write to a new output file.

> ImageMagick v7 uses `magick in.png out.jpg`. Legacy v6 uses `convert`; if only
> `convert` exists, substitute it for `magick` in the examples below.

## Setup health check (run first, every session)

Verify with **one solo step**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "magick", "args": ["--version"] } }]
```

Outcome map:
- `exit 0` + `Version: ImageMagick 7…` → ready, proceed.
- `command not found: magick` → try `convert --version` (v6); if also missing →
  enter **Setup playbook → "imagemagick missing"**.

## Setup playbook (when prerequisites are missing)

### imagemagick missing

Reply (solo `reply` step):

> «ImageMagick не установлен. Могу поставить: `brew install imagemagick`. Поставить?»

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "imagemagick"] } }]
```

On Linux: `apt-get install imagemagick`.

## When to use

- "Resize / crop / rotate this image", "convert PNG to JPG / WebP".
- "Compress this image", "make a thumbnail", "combine images into a montage".
- "Add a text caption / watermark to this image".

## When NOT to use

- Understanding image *content* — use `vision.describe` instead.
- Video frames / animation encoding — use the `ffmpeg` skill.
- Multi-page PDF assembly from images — use the `pdf` skill (`magick` can make a
  PDF but page-level control lives in `pdf`).

## Common operations

All examples invoke `os.shell.run` with `cmd: "magick"`. The approval gate
surfaces each write.

| Goal | args |
|---|---|
| Inspect dimensions/format | `["identify", "in.png"]` |
| Convert PNG → JPG | `["in.png", "out.jpg"]` |
| Convert → WebP | `["in.png", "-quality", "82", "out.webp"]` |
| Resize to 800px wide | `["in.jpg", "-resize", "800x", "out.jpg"]` |
| Thumbnail (fit 200x200) | `["in.jpg", "-thumbnail", "200x200", "thumb.jpg"]` |
| Crop 300x300 from 10,10 | `["in.png", "-crop", "300x300+10+10", "+repage", "crop.png"]` |
| Rotate 90° | `["in.jpg", "-rotate", "90", "rot.jpg"]` |
| Compress JPG quality 75 | `["in.jpg", "-quality", "75", "small.jpg"]` |
| Montage 2x2 grid | `["montage", "a.png", "b.png", "c.png", "d.png", "-tile", "2x2", "-geometry", "+4+4", "grid.png"]` |
| Add caption | `["in.jpg", "-pointsize", "36", "-annotate", "+20+40", "Hello", "out.jpg"]` |

## Rules

1. Always write to a NEW output path; never overwrite the source image.
2. Use `magick identify` first to learn dimensions/format before transforming.
3. After a transform, optionally `vision.describe` the result to confirm it
   matches the user's intent for visual tasks.
4. Echo the output path and final dimensions after each operation.

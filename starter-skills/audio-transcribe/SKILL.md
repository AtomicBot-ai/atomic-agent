---
name: audio-transcribe
description: "Transcribe speech from audio files and Telegram voice messages (ogg, mp3, m4a, wav, flac, webm) to text locally, no API key: the built-in audio.transcribe tool (whisper.cpp) first, the Python whisper CLI as a fallback. Use whenever a task hinges on the spoken content of an audio attachment."
version: 1.1.0
requires_tools:
  - os.shell.run
  - os.fs.read
dangerous: false
---

# audio-transcribe

## First choice: the built-in `audio.transcribe` tool

Atomic Agent has a built-in tool that runs [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
on this computer, with no Python or PyTorch. It converts Telegram voice messages
(OGG/Opus) and other formats itself and returns the transcript as text:

```
[{ "tool": "audio.transcribe", "args": { "path": "voice.ogg" } }]
```

- Add `"language": "ru"` (or another ISO code) when you know the language; the default is `auto`.
- The result says what is missing, and you relay it:
  - `whisper-cli` not installed → offer `brew install whisper-cpp` (macOS/Linux with Homebrew);
    on Windows the whisper.cpp release zip.
  - `ffmpeg` not installed → offer `brew install ffmpeg` / `sudo apt install ffmpeg` / `winget install ffmpeg`.
  - the speech model is not downloaded → the result gives its size; ask the user, then call again
    with `"download": true`.
- Answer strictly from the returned text.

Use the Python route below only when `audio.transcribe` is not available in this build, or the user
already has `openai-whisper` and asks for it.

## Fallback: the Python `whisper` CLI

Turn spoken audio into text locally with [`whisper`](https://github.com/openai/whisper).
Whisper writes a plain-text transcript next to the audio; you then read that file
and answer from its content. The chat model never "hears" the audio — `whisper`
does the listening as a separate process, so this works regardless of model size.

### Setup health check (run first, every session)

Verify with **one solo step**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "whisper", "args": ["--help"] } }]
```

Outcome map:
- `exit 0` + usage text → ready, proceed.
- `command not found: whisper` → enter **Setup playbook → "whisper missing"**.

### Setup playbook (when prerequisites are missing)

#### whisper missing

Reply (solo `reply` step):

> "`whisper` is not installed. I can install it: `brew install openai-whisper` (also needs `ffmpeg`). Install it?"

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "openai-whisper", "ffmpeg"] } }]
```

On Linux: `pipx install openai-whisper` (or `pip install openai-whisper`) plus
`apt-get install ffmpeg`. The first transcription downloads the model weights to
`~/.cache/whisper`.

## When to use

- The task references an audio attachment (`.mp3`, `.m4a`, `.wav`, `.ogg`,
  `.flac`, `.webm`) and the answer depends on what is said in it.
- "What does the speaker say…", "list the ingredients mentioned…", "which page
  numbers are read aloud…".

## When NOT to use

- The audio only needs format conversion / trimming — that's the `ffmpeg` skill.
- The attachment is an image / document — use vision or `fs.read_document`.

## How to transcribe

1. Transcribe to a `.txt` next to the audio (one solo step). Pick the model by
   need: `small` is a good speed/accuracy default; use `medium` when accuracy
   matters and the clip is short.

```
[{ "tool": "os.shell.run", "args": { "cmd": "whisper", "args": ["audio.mp3", "--model", "small", "--output_format", "txt", "--output_dir", ".", "--language", "en"] } }]
```

2. Read the produced transcript (whisper names it `<basename>.txt`):

```
[{ "tool": "os.fs.read", "args": { "path": "audio.txt" } }]
```

3. Answer strictly from the transcript text. If a list/order is requested,
   preserve the spoken order exactly.

## Rules

1. Always write the transcript to a NEW `.txt`; never overwrite the source audio.
2. Drop `--language` only when the spoken language is unknown; setting it
   correctly improves accuracy and speed.
3. Long clips re-encode slowly — set realistic expectations and prefer a smaller
   `--model` for multi-minute audio.
4. Base the final answer on the transcript content, not on the file name or
   metadata.

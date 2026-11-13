# Audio transcription tool

Status: current
Owner: src/tools/audio/

`audio.transcribe { path, language?, model?, translate?, make_default? }` turns speech in a local audio file into text with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), without Python or PyTorch (ATO-702). Telegram voice messages land in the channel inbox as `.ogg` files and the attachments hint points the agent here.

- **whisper.cpp.** In order: the path `ATOMIC_AGENT_WHISPER_BIN` names; the copy the agent downloaded into `<localModelsDataDir>/whisper/bin/<tag>/`; `whisper-cli` (older builds `whisper-cpp`) on PATH plus the toolchain folders a desktop-launched agent misses (`withToolchainEnv`). On Windows (x64, arm64) and Linux (x64, arm64) a missing CLI is downloaded on first use from the pinned upstream release (`whisper-release.ts`: `ggml-org/whisper.cpp` build `b5454` = v1.9.5, the SHA-256 GitHub publishes per asset). Upstream ships no macOS CLI (only an xcframework), and neither Atomic Chat Core nor the managed llama.cpp carries whisper, so on macOS the route stays `brew install whisper-cpp` and a missing binary ends the call with that line. The bare `whisper` command is the Python CLI and is not used here.
- **Model.** A multilingual ggml file from `huggingface.co/ggerganov/whisper.cpp`, kept in `<localModelsDataDir>/whisper/`, or the file `ATOMIC_AGENT_WHISPER_MODEL` names. Which one: the call's `model`, else the default saved in `<localModelsDataDir>/whisper/settings.json` (`make_default: true` writes it; the desktop's model choice too), else `base` (148 MB). A missing model is downloaded on first use and checked against the size and SHA-256 Hugging Face lists; it is renamed into place only after the check.
- **Downloads.** One `http` approval per call names every file, its size and host (`github.com`, `huggingface.co`); then `downloadFile` (resumable) fetches them and `tool_progress` events carry one progress bar for both. Archives are unpacked by the agent's own zip/tar code (paths and links kept inside the folder), never run before the digest matched (`whisper-install.ts`).
- **ffmpeg.** `ATOMIC_AGENT_FFMPEG_BIN` or PATH; not downloaded.
- **Conversion.** Every input goes through ffmpeg to 16 kHz mono 16-bit WAV in a temp folder that is removed afterwards (whisper.cpp cannot read OGG/Opus). Without ffmpeg only a `.wav` is tried as is.
- **Run.** `whisper-cli -m <model> -f <wav> -l <lang|auto> -nt -np`, no shell; stdout is the transcript. Solo in a batch (`approval_gated`): it can run for minutes and asks before a first-use download.

The `audio-transcribe` starter skill keeps the Python `openai-whisper` route as a fallback. Read [tool instructions](../AGENTS.md) and the adjacent tests before changing arguments, the model list or where models are stored.

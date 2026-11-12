# Audio transcription tool

Status: current
Owner: src/tools/audio/

`audio.transcribe { path, language?, model?, translate?, download? }` turns speech in a local audio file into text with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), without Python or PyTorch (ATO-702). Telegram voice messages land in the channel inbox as `.ogg` files and the attachments hint points the agent here.

- **Binaries.** The user's own `whisper-cli` (Homebrew `whisper-cpp`; older builds `whisper-cpp`) and `ffmpeg`, found on PATH plus the toolchain folders a desktop-launched agent misses (`withToolchainEnv`), or named by `ATOMIC_AGENT_WHISPER_BIN` / `ATOMIC_AGENT_FFMPEG_BIN` (absolute paths). Nothing is downloaded: a missing binary ends the call with the install line for the platform. The bare `whisper` command is the Python CLI and is not used here.
- **Model.** A multilingual ggml file from `huggingface.co/ggerganov/whisper.cpp`, kept in `<localModelsDataDir>/whisper/` (default `base`, 142 MB; `tiny`, `small`, `medium`, `large-v3-turbo` on request), or the file `ATOMIC_AGENT_WHISPER_MODEL` names. A model that is not on disk is never fetched silently: the first call answers with its size, the agent asks the user, and only a call with `download: true` fetches it, after an `http` approval naming the size and host.
- **Conversion.** Every input goes through ffmpeg to 16 kHz mono 16-bit WAV in a temp folder that is removed afterwards (whisper.cpp cannot read OGG/Opus). Without ffmpeg only a `.wav` is tried as is.
- **Run.** `whisper-cli -m <model> -f <wav> -l <lang|auto> -nt -np`, no shell; stdout is the transcript. Solo in a batch (`approval_gated`): it can run for minutes and may ask before a download.

The `audio-transcribe` starter skill keeps the Python `openai-whisper` route as a fallback. Read [tool instructions](../AGENTS.md) and the adjacent tests before changing arguments, the model list or where models are stored.

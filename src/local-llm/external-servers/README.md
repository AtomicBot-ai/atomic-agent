# External model servers (ATO-2490)

Status: current
Owner: src/local-llm/external-servers/

Ollama, LM Studio and the Llama app run their own servers; this engine does not own their processes, ports or files. This folder is how Atomic Agent acts on them when a person asks, from `atomic-agent local-servers <action>` ([cli](../../cli/local-servers-actions.ts)), the TUI's `/servers` and the desktop's Settings › Local. Finding them is [detect-local-servers.ts](../../llm/provider/presets/detect-local-servers.ts).

- [external-server-paths.ts](external-server-paths.ts): where each app keeps its binary and models on macOS, Windows and Linux (`ollama.exe` under `%LOCALAPPDATA%\Programs\Ollama`, `lms` under `~/.lmstudio/bin`, `OLLAMA_MODELS`, LM Studio's `downloadsFolder`). Pure: the host (platform, home, env) is passed in, so every platform is testable anywhere.
- [ollama-control.ts](ollama-control.ts): Ollama's HTTP API on 127.0.0.1:11434: load (`/api/generate`), unload (`keep_alive: 0`), pull (NDJSON progress, done only on `success`), delete, and the weights blob from `/api/show`.
- [lmstudio-cli.ts](lmstudio-cli.ts): LM Studio through `lms` (its REST server cannot load or download): `server start`, `load --yes`, `unload [--all]`, `get --yes`, `ls --json`. Argument-array spawn only.
- [start-external-server.ts](start-external-server.ts): start and wait until the probe answers; already running spawns nothing. Ollama's app on macOS and Windows (it stays up after we quit), `ollama serve` on Linux; detached.
- [adopt-external-model.ts](adopt-external-model.ts): register a downloaded model as a local `.gguf` entry ([local-gguf.ts](../catalog/local-gguf.ts)). LM Studio's file is used in place. Ollama's blob is hard-linked into `<dataDir>/linked-models/` (symbolic link across disks, copy only with `--copy`), so `ollama rm` does not break it and there is no second copy. Refused in words: a blob that is not GGUF, or a GGUF without `tokenizer.chat_template` (Ollama keeps its template in a separate layer, and serving without one gives the wrong prompt format).

Errors are sentences for the screen; the app's own words go in `detail`. Model names are checked before any request or spawn, so a name cannot become a flag.

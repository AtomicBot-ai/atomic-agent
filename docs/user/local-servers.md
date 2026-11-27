# Ollama, LM Studio and the Llama app

Status: current
Owner: src/cli/ (local-servers), src/local-llm/external-servers/

Atomic Agent runs models on its own engine (llama.cpp), but it also works with a model app you already have. It looks for three on this computer:

| App | Address it checks | Connects as |
|---|---|---|
| Llama app (llama.app) or your own `llama-server` | `http://127.0.0.1:9931` | External llama-server |
| Ollama | `http://127.0.0.1:11434` | the Ollama provider |
| LM Studio | `http://127.0.0.1:1234` | the LM Studio provider |

## See what is running

```sh
atomic-agent local-servers
```

prints each app that answers, its models, and which ones are loaded in memory (Ollama's `/api/ps`, LM Studio's `/api/v0/models`; an older LM Studio without that list shows nothing loaded). In the TUI the same list is `/servers`. In the desktop app it is the "Running on this Mac" list in Settings › Local (and a setup step when the app finds one).

## Start, load, download, delete

```sh
atomic-agent local-servers start ollama            # or lmstudio; waits until it answers
atomic-agent local-servers load ollama qwen3:8b     # load into memory now
atomic-agent local-servers unload ollama qwen3:8b   # free the memory now
atomic-agent local-servers unload ollama --all
atomic-agent local-servers pull ollama qwen3:8b     # download (ollama pull)
atomic-agent local-servers rm ollama llama3.2:3b    # delete (ollama rm)
```

- **Ollama** is driven through its own HTTP API. Unload is Ollama's `keep_alive: 0`, which frees the memory at once instead of after Ollama's usual five idle minutes. Start opens the Ollama app on macOS and Windows (so it stays in the menu bar or tray after Atomic Agent quits) and runs `ollama serve` on Linux.
- **LM Studio** is driven through its command line tool `lms`, which LM Studio installs in `~/.lmstudio/bin` (`%USERPROFILE%\.lmstudio\bin\lms.exe` on Windows). If it is missing, open LM Studio once or run its `lms bootstrap`. `pull lmstudio <key>` is `lms get`. Deleting an LM Studio model is left to LM Studio (My Models).

In the TUI, put the same words after `/servers`, for example `/servers unload ollama --all`.

## Run an Ollama or LM Studio model on Atomic Agent's engine

```sh
atomic-agent local-servers adopt ollama qwen3:8b --use
atomic-agent local-servers adopt lmstudio qwen/qwen3-8b
```

adds the model you already downloaded to Atomic Agent's local models without downloading it again, and with `--use` switches to it.

- An LM Studio model is a plain `.gguf` file; it is used where it lies. A key with a quant (`publisher/model@q8_0`) takes only the file of that quant.
- An Ollama model is stored as a file without a name ending. Atomic Agent links it into its own folder as `ollama-<name>.gguf`. A hard link takes no extra disk space and keeps working after `ollama rm`. When the two folders are on different disks it makes a symbolic link instead, and if that is not allowed either (Windows without the right), it stops and tells you the size; `--copy` copies the file.
- A model is refused, with a sentence saying why, when its file is not GGUF (newer Ollama formats, LM Studio's MLX models on a Mac) or carries no chat template inside it (it would answer in the wrong format here). Keep using those through their app.

## Give the model at least 32K of context

An agent sends long prompts: the tool list, the files it read, the conversation. A model app's default context is often far smaller (Ollama's is a few thousand tokens), and then the start of every prompt is silently cut off: the model forgets the task, skips tools or repeats itself. Set the context to **at least 32K (32768 tokens)** in the app you use:

- **Llama app:** set the context size to 32768 or more in its model settings. If you run `llama-server` yourself, start it with `-c 32768` (or `--ctx-size 32768`).
- **Ollama:** in the Ollama app's settings, move Context length to 32k or more. Without the app, start the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`.
- **LM Studio:** set Context Length to 32768 in the model's load settings, or load it with `lms load <key> --context-length 32768`.

More context takes more memory. If the model no longer fits, pick a smaller model or a smaller quant rather than a shorter context.

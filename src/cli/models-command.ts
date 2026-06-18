import { getConfig } from "../config/index.js";
import {
  runLocalModelsDevices,
  runLocalModelsList,
  runLocalModelsListEmbeddings,
  runLocalModelsPull,
  runLocalModelsPullEmbedding,
  runLocalModelsRemove,
  runLocalModelsStart,
  runLocalModelsStatus,
  runLocalModelsStop,
  runLocalModelsUpdate,
  runLocalModelsUse,
  runLocalModelsUseDevice,
  runLocalModelsUseEmbedding,
} from "./models-handlers.js";

const HELP =
  [
    "atomic-agent models — manage the local-LLM runtime (llama.cpp backend + GGUF models)",
    "",
    "Available only when config.localModels.mode = \"managed\" (see `atomic-agent config`).",
    "",
    "Subcommands:",
    "  list                          Show model catalog + disk presence (active marked with *)",
    "  pull <id>                     Download a GGUF model from Hugging Face",
    "  use <id>                      Set active model and switch mode to \"managed\"",
    "  status                        Show mode, backend version, active model, daemon/health",
    "  start                         Spawn detached llama-server daemon (writes .pid)",
    "  stop                          Stop daemon (SIGTERM → SIGKILL after 3s)",
    "  update                        Download latest backend from GitHub Releases",
    "                                (stops daemon first; does not auto-restart)",
    "  remove <id>                   Delete a downloaded model (refuses if active + daemon running)",
    "",
    "GPU subcommands:",
    "  devices                       List GPU devices (llama-server --list-devices); active marked with *",
    "  use-device <auto|cpu|Vulkan0> Set the managed daemon's GPU (auto-picks best discrete by default)",
    "",
    "Embedding subcommands (memory-v2 phase 1B — second daemon for /embedding):",
    "  list-embeddings               Show embedding catalog + disk presence + daemon health",
    "  pull-embedding <id>           Download an embedding GGUF",
    "  use-embedding <id>|--disable  Enable + select an embedding model (or turn off)",
    "                                Note: 'start' brings both chat and embedding up;",
    "                                if the embedding daemon fails the chat one stays up.",
    "",
    "Examples:",
    "  atomic-agent models list",
    "  atomic-agent models pull qwen-3.5-4b",
    "  atomic-agent models use qwen-3.5-4b",
    "  atomic-agent models pull-embedding nomic-embed-text-v1.5",
    "  atomic-agent models use-embedding nomic-embed-text-v1.5",
    "  atomic-agent models update",
    "  atomic-agent models start",
    "  atomic-agent models status",
  ].join("\n") + "\n";

export async function modelsCommand(args: string[]): Promise<number> {
  getConfig();
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "list":
        return runLocalModelsList();
      case "pull":
        return runLocalModelsPull(args[1]);
      case "use":
        return runLocalModelsUse(args[1]);
      case "status":
        return runLocalModelsStatus();
      case "start":
        return runLocalModelsStart();
      case "stop":
        return runLocalModelsStop();
      case "update":
        return runLocalModelsUpdate();
      case "remove":
        return runLocalModelsRemove(args[1]);
      case "devices":
        return runLocalModelsDevices();
      case "use-device":
        return runLocalModelsUseDevice(args[1]);
      case "list-embeddings":
        return runLocalModelsListEmbeddings();
      case "pull-embedding":
        return runLocalModelsPullEmbedding(args[1]);
      case "use-embedding":
        return runLocalModelsUseEmbedding(args[1]);
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`models ${sub} failed: ${message}\n`);
    return 1;
  }
}

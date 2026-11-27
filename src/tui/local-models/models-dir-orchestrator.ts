import { runModelsDir, type ModelsDirDeps } from "../../cli/models-dir-command.js";
import type { ModelsDirAction, ModelsDirProgress } from "./models-dir-state.js";

/**
 * ATO-2504: what the TUI's models folder screen asks of the agent. It runs
 * the very command the terminal and the desktop card run (`models dir`,
 * src/cli/models-dir-command.ts) in-process, reading its lines: one
 * implementation of the move, the busy check, the move marker and the
 * config write. The move runs in the orchestrator's model-operation turn
 * (`inTurn`), so the TUI's own launch start, restart or `s` queues behind
 * it instead of starting a model mid-copy, and the supervisor holds off
 * while `moving`. That turn is not a blocking switch: chat turns on a
 * cloud model go on during the copy.
 *
 * Esc stops it through `signal` (never through SIGINT: the TUI owns
 * Ctrl+C), and the command puts every model back.
 */
export interface ModelsDirOrchestratorDeps {
  emit: (action: ModelsDirAction) => void;
  /** The model-operation turn; its signal is aborted when the TUI closes. */
  inTurn: (body: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  /** Re-read the model rows: their "downloaded" now comes from the new folder. */
  refresh: () => Promise<void> | void;
  /** Test seam. */
  run?: (args: readonly string[], deps: ModelsDirDeps) => Promise<number>;
}

/** The command's refusals in the TUI's words (its keys, not the terminal's commands). */
export function modelsDirTuiWords(stderr: string): string {
  const said = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (/a local model is running/.test(said)) return "Stop the local model first (s on the list), then move the models.";
  if (/a local model is starting/.test(said)) return "A local model is starting. Wait for it, stop it (s), then move the models.";
  if (/a model download is running/.test(said)) return "Wait for the model download to finish, or pause it (p), then move the models.";
  if (/is its disk connected\?/.test(said)) {
    return "The disk with your models folder is not connected. Connect it and try again, or press Enter on an empty line to use the default folder.";
  }
  const text = said.replace(/^models dir: /, "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "The models were not moved.";
}

/** Feed `moving <m> (i/n)` and `copied <d> of <t> bytes (<m>)` lines to `onProgress`. */
export function parseMoveLine(line: string): ModelsDirProgress | null {
  const moving = /^moving (.+) \((\d+)\/(\d+)\)\s*$/.exec(line);
  if (moving) return { entry: moving[1]!, index: Number(moving[2]), total: Number(moving[3]) };
  const bytes = /^copied (\d+) of (\d+) bytes \((.+)\)\s*$/.exec(line);
  // index 0: the reducer keeps the model line's position and takes the bytes.
  if (bytes) return { entry: bytes[3]!, index: 0, total: 0, done: Number(bytes[1]), size: Number(bytes[2]) };
  return null;
}

export class ModelsDirOrchestrator {
  private stop: AbortController | null = null;

  constructor(private readonly deps: ModelsDirOrchestratorDeps) {}

  /** A move is under way, from Enter until the command has ended. */
  get moving(): boolean {
    return this.stop !== null;
  }

  private get run(): (args: readonly string[], deps: ModelsDirDeps) => Promise<number> {
    return this.deps.run ?? runModelsDir;
  }

  /** Ask where the folder is (`models dir --json`). */
  async load(): Promise<void> {
    let out = "";
    let err = "";
    const code = await this.run(["--json"], { write: (t) => void (out += t), writeErr: (t) => void (err += t) }).catch(() => 1);
    const line = out.trim().split(/\r?\n/).pop() ?? "";
    try {
      const v = JSON.parse(line) as { dir?: unknown; defaultDir?: unknown; custom?: unknown; reachable?: unknown };
      if (code === 0 && typeof v.dir === "string" && typeof v.defaultDir === "string") {
        this.deps.emit({ type: "local_models_dir_loaded", dir: v.dir, defaultDir: v.defaultDir, custom: v.custom === true, reachable: v.reachable !== false });
        return;
      }
    } catch {
      /* not JSON: fall through */
    }
    this.deps.emit({ type: "local_models_dir_move_failed", error: err ? modelsDirTuiWords(err) : "Could not ask the agent where the models are." });
  }

  /** Enter: move to `raw` (trimmed), or back to the default folder when it is empty. */
  move(raw: string): Promise<void> {
    if (this.stop) return Promise.resolve();
    const target = raw.trim();
    const args = target === "" ? ["--reset"] : [target];
    const own = new AbortController();
    this.stop = own;
    this.deps.emit({ type: "local_models_dir_move_started" });
    let ended = false;
    return this.deps
      .inTurn(async (turn) => {
        let partial = "";
        let out = "";
        let err = "";
        const signal = AbortSignal.any([turn, own.signal]);
        const code = await this.run(args, {
          signal,
          write: (t) => {
            out += t;
            const lines = (partial + t).split(/\r?\n/);
            partial = lines.pop() ?? "";
            for (const l of lines) {
              const p = parseMoveLine(l);
              if (p) this.deps.emit({ type: "local_models_dir_progress", progress: p });
            }
          },
          writeErr: (t) => void (err += t),
        }).catch((e: unknown) => {
          err += e instanceof Error ? e.message : String(e);
          return 1;
        });
        if (code === 0) {
          const kept = /^the models on (.+) stay there/m.exec(out);
          const left = [...out.matchAll(/^could not delete the old copy at (.+); delete it by hand$/gm)].map((m) => m[1]!);
          const note = kept
            ? `Using the default folder now. The models stay on ${kept[1]}.`
            : left.length > 0
              ? `Moved. The old copy could not be deleted, delete it by hand: ${left.join(", ")}`
              : "Moved. New downloads go to this folder too.";
          this.deps.emit({ type: "local_models_dir_move_finished", note });
        } else {
          this.deps.emit({ type: "local_models_dir_move_failed", error: modelsDirTuiWords(err) });
        }
        ended = true;
      })
      .finally(async () => {
        this.stop = null;
        // The turn never ran (the TUI is closing, or it failed before the body).
        if (!ended) this.deps.emit({ type: "local_models_dir_move_failed", error: "The models were not moved." });
        await this.load();
        await this.deps.refresh();
      });
  }

  /** Esc during a move. */
  cancel(): void {
    if (!this.stop) return;
    this.deps.emit({ type: "local_models_dir_move_stopping" });
    this.stop.abort();
  }
}

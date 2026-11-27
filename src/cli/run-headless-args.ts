/**
 * The headless flags of `atomic-agent run` (ATO-2307): how the run
 * reports itself to a script, which model it pins, which saved chat it
 * continues, and the task given as an argument instead of stdin.
 * `parseRunArgs` hands every flag it does not own to `readHeadlessFlag`.
 */

/** `text` is the chat output; `json` one result object; `stream-json` JSONL events. */
export type RunOutputFormat = "text" | "json" | "stream-json";

export interface RunHeadlessArgs {
  outputFormat: RunOutputFormat;
  /** `--model`: a model id, a provider id, or `<provider>:<model>`. */
  model: string | null;
  /** `--resume <id>` (an id or unique id prefix), or `latest` for `--continue`. */
  resume: string | null;
  /** `-o` / `--output-last-message`: the file the last reply is written to. */
  outputLastMessage: string | null;
  /** Positional words: one turn with this message, stdin is not read as messages. */
  prompt: string | null;
}

export function emptyHeadlessArgs(): RunHeadlessArgs {
  return {
    outputFormat: "text",
    model: null,
    resume: null,
    outputLastMessage: null,
    prompt: null,
  };
}

const FORMATS: readonly RunOutputFormat[] = ["text", "json", "stream-json"];

/**
 * Read the flag at `args[i]` into `acc`. Returns the index of the last
 * argument it consumed, an error, or null when `args[i]` is not a
 * headless flag (the caller reports it as unknown). A word that does
 * not start with `-` is part of the prompt.
 */
export function readHeadlessFlag(
  args: readonly string[],
  i: number,
  acc: RunHeadlessArgs,
): number | { error: string } | null {
  const flag = args[i]!;
  const value = (): string | null => {
    const next = args[i + 1];
    return next === undefined || next.length === 0 ? null : next;
  };
  switch (flag) {
    case "--output-format": {
      const v = value();
      if (v === null || !FORMATS.includes(v as RunOutputFormat)) {
        return { error: "--output-format must be text, json or stream-json" };
      }
      acc.outputFormat = v as RunOutputFormat;
      return i + 1;
    }
    case "--json":
      // Codex `exec --json`: the JSONL event stream.
      acc.outputFormat = "stream-json";
      return i;
    case "--model":
    case "-m": {
      const v = value();
      if (v === null) return { error: `${flag} needs a model id or <provider>:<model>` };
      acc.model = v;
      return i + 1;
    }
    case "--resume": {
      const v = value();
      if (v === null || v.startsWith("-")) return { error: "--resume needs a chat id" };
      acc.resume = v;
      return i + 1;
    }
    case "--continue":
    case "-c":
      acc.resume = "latest";
      return i;
    case "--output-last-message":
    case "-o": {
      const v = value();
      if (v === null || v.startsWith("-")) return { error: `${flag} needs a file path` };
      acc.outputLastMessage = v;
      return i + 1;
    }
    default:
      if (flag.startsWith("-")) return null;
      acc.prompt = acc.prompt === null ? flag : `${acc.prompt} ${flag}`;
      return i;
  }
}

/** A combination of flags that cannot run, or null. */
export function headlessArgsConflict(
  acc: RunHeadlessArgs,
  incognito: boolean,
): string | null {
  if (acc.resume !== null && incognito) {
    return "--incognito starts a new chat, so it cannot run with --resume or --continue";
  }
  if (acc.prompt !== null && acc.prompt.trim().length === 0) {
    return "the prompt argument is empty";
  }
  return null;
}

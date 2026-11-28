import { localServersCommand } from "../../cli/local-servers-command.js";

/**
 * `/servers [action ...]` in the TUI (ATO-2490): the same command as
 * `atomic-agent local-servers`, so the terminal, the TUI and the desktop app
 * list and act on Ollama, LM Studio and the Llama app the same way. Its
 * output becomes chat notes: the listing or the result in one note, a
 * download's progress steps as they come (the command already thins them
 * to every 10 percent).
 *
 * Two things change for the TUI: `--json` is dropped (a note is for a
 * person), and `adopt --use` is refused, since `models use` prints to the
 * terminal this TUI is drawing on; the note says to run `/model use <id>`.
 */

export const SERVERS_USE_IN_TUI = "In the TUI, add the model first (/servers adopt ...), then switch to it with /model use <id>.";

export function tuiServersArgs(args: readonly string[]): readonly string[] | { refused: string } {
  if (args.includes("--use")) return { refused: SERVERS_USE_IN_TUI };
  return args.filter((a) => a !== "--json");
}

/** The command's own hint, in TUI words. */
export function tuiServersText(text: string): string {
  return text
    .replace(/Run it with: atomic-agent models use (\S+)/g, "Switch to it with /model use $1")
    .replace(/atomic-agent local-servers/g, "/servers")
    .trimEnd();
}

export async function runLocalServersSlash(
  args: readonly string[],
  post: (text: string) => void,
  run: typeof localServersCommand = localServersCommand,
): Promise<void> {
  const ready = tuiServersArgs(args);
  if ("refused" in ready) {
    post(ready.refused);
    return;
  }
  const isAction = ready.length > 0;
  if (isAction) post(`/servers ${ready.join(" ")}: working…`);
  const lines: string[] = [];
  const streaming = ready[0] === "pull";
  const take = (text: string) => {
    if (streaming) {
      for (const line of text.split("\n")) if (line.trim()) post(tuiServersText(line));
      return;
    }
    lines.push(text);
  };
  try {
    await run([...ready], { write: take, writeErr: take });
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
  }
  const joined = tuiServersText(lines.join(""));
  if (joined) post(joined);
}

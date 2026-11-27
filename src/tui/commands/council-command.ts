/**
 * `/council [flags] <question>` (ATO-2432): the model council inside the
 * chat. Pure parsing; the run itself is `tui/council-runner.ts`. The
 * flags are the `models council` ones, so the terminal command and the
 * slash command read the same:
 *
 *   /council Postgres or SQLite for a desktop app?
 *   /council --models or:gpt-4o,ollama:qwen3*2 --no-rank <question>
 *   /council --dry-run <question>      (only the cost forecast)
 *   /council stop                      (stop the running council)
 */

export const COUNCIL_USAGE =
  "Usage: /council <question>. Several models answer, review each other with the names hidden, and a chairman writes the final answer; nothing is saved to the chat. " +
  "Flags: --models a,b*2 (default: this chat's model three times), --judge <model>, --chairman <model> or --no-chairman, --no-rank, --max-usd <n>, --dry-run. `/council stop` stops it.";

export interface CouncilRunRequest {
  question: string;
  models?: string;
  judge?: string;
  chairman?: string | null;
  rank?: boolean;
  maxUsd?: number;
  dryRun?: boolean;
}

export type CouncilCommand =
  | { kind: "run"; request: CouncilRunRequest }
  | { kind: "stop" }
  | { kind: "usage"; message: string };

const VALUE_FLAGS = new Set(["--models", "--judge", "--chairman", "--max-usd"]);

export function parseCouncilCommand(args: string): CouncilCommand {
  const words = args.trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return { kind: "usage", message: COUNCIL_USAGE };
  if (words.length === 1 && words[0]!.toLowerCase() === "stop") return { kind: "stop" };
  const request: CouncilRunRequest = { question: "" };
  const question: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (VALUE_FLAGS.has(word)) {
      const value = words[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { kind: "usage", message: `${word} needs a value. ${COUNCIL_USAGE}` };
      }
      i += 1;
      if (word === "--models") request.models = value;
      else if (word === "--judge") request.judge = value;
      else if (word === "--chairman") request.chairman = value;
      else {
        const usd = Number(value.replace(/^\$/, ""));
        if (!Number.isFinite(usd) || usd < 0) return { kind: "usage", message: `--max-usd needs a number of dollars. ${COUNCIL_USAGE}` };
        request.maxUsd = usd;
      }
      continue;
    }
    if (word === "--no-rank") request.rank = false;
    else if (word === "--no-chairman") request.chairman = null;
    else if (word === "--dry-run") request.dryRun = true;
    else question.push(word);
  }
  request.question = question.join(" ");
  if (request.question === "") return { kind: "usage", message: COUNCIL_USAGE };
  return { kind: "run", request };
}

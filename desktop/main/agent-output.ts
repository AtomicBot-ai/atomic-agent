import { StringDecoder } from "node:string_decoder";

/**
 * `atag serve`'s stdout and stderr, read as lines and labelled.
 *
 * Since serve's structured log reaches stderr (src/tracing/structured-logger.ts
 * createStderrSink), most of what the agent says there is routine: a tool ran,
 * a provider answered. agent.log tagged every stderr line ERR (ATO-121), the
 * console drawer showed every one as a warning, and the 40-line ring a failed
 * smoke check quotes filled with INFO lines that pushed out the one that
 * explained the failure. A structured line now carries its own level, and so
 * do serve's lifecycle lines and the desktop's own (lineLevel below); any
 * other stderr line — a crash's stack, `serve failed: …` — stays ERR.
 */

export type AgentLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Longest line kept whole. A line with no end in sight is let out in pieces
 * past this, rather than held in memory without bound.
 */
const MAX_LINE_CHARS = 256 * 1024;

/**
 * Splits a child's output into whole lines across pipe chunks.
 *
 * A pipe hands over whatever was written, cut wherever its buffer filled: a
 * long line arrives in several chunks, and a character that takes several
 * bytes in UTF-8 can be cut between two of them. The relay used to split each
 * chunk on its own, so a long line became several and a cut character came
 * out as replacement characters on both sides. The decoder holds back a
 * partial character and the splitter a partial line until the rest arrives;
 * `end` lets out what is left when the stream closes, which is how the last
 * words of an agent that died mid-line are kept.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private carry = "";

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars = MAX_LINE_CHARS,
  ) {}

  push(chunk: Buffer): void {
    const lines = (this.carry + this.decoder.write(chunk)).split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) this.emit(line);
    if (this.carry.length > this.maxLineChars) {
      this.emit(this.carry);
      this.carry = "";
    }
  }

  end(): void {
    const rest = this.carry + this.decoder.end();
    this.carry = "";
    if (rest) for (const line of rest.split("\n")) this.emit(line);
  }

  /** A Windows child ends its lines with \r\n. */
  private emit(line: string): void {
    this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

/** `[2026-10-02T07:15:29.123Z] WARN message {context}` — the agent's structured line. */
const STRUCTURED_LINE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\] (DEBUG|INFO|WARN|ERROR) /;

/** The level of one of the agent's structured log lines, or null for any other line. */
export function structuredLevel(line: string): AgentLogLevel | null {
  const match = STRUCTURED_LINE.exec(line);
  return match ? (match[1]!.toLowerCase() as AgentLogLevel) : null;
}

/* ATO-121 (its second half): the lines that are not structured. Serve's own
   lifecycle lines (`[atomic-agent] serve listening on …`, `SIGTERM received,
   closing`, `created default config at …`) and the desktop's lines about the
   agent and the model server (`[desktop] local-llm: the app is stopping the
   model server…`) were tagged ERR in agent.log as well, and the web search's
   one-line notice about a missing key along with them; a support report read
   as a page of errors with none in it. Each is read by its shape now: a
   lifecycle or desktop line is INFO unless its words say something failed,
   a notice is WARN, and what is left — a stack, `serve failed: …`, a crash's
   last words — stays ERR. */
const FAILED_WORDS = /\b(?:fail(?:ed|s|ure)?|error|errored|could not|cannot|can't|unable to|crash(?:ed)?|refused|not found|timed out|did not|outlived|still (?:not|there)|port closed|times within|starting it again)\b/i;
const NOTICE_LINE = /^(?:web\.search: |\(node:\d+\) (?:\[[A-Z0-9_]+\] )?\w*Warning: )/;

/**
 * The level of any one line of the agent's output, or of the desktop's own
 * about it: a structured line's own, else read off the line's shape (above).
 * Null for a line nothing says is routine, which agent.log keeps as ERR.
 */
export function lineLevel(line: string): AgentLogLevel | null {
  const structured = structuredLevel(line);
  if (structured) return structured;
  // Read without the paths in it: a working folder or a config path named "errors" is not a failure.
  const words = line.replace(/\S*[\\/]\S*/g, "");
  if (line.startsWith("[atomic-agent] ")) return FAILED_WORDS.test(words) ? "warn" : "info";
  if (line.startsWith("[desktop] ")) return FAILED_WORDS.test(words) ? "error" : "info";
  if (NOTICE_LINE.test(line)) return "warn";
  return null;
}

/**
 * The tag a line of the agent's output gets in agent.log: a structured line's
 * own level (INFO, WARN, …); any other line ERR on stderr and OUT on stdout,
 * as before.
 */
export function agentLogTag(stream: string | undefined, level: AgentLogLevel | null | undefined): string {
  if (level) return level.toUpperCase();
  return stream === "stderr" ? "ERR" : "OUT";
}

/**
 * Whether a line goes into the short ring of the agent's last words that a
 * failed smoke check quotes: anything but INFO and DEBUG, which stay in
 * agent.log and the console drawer.
 */
export function worthQuoting(level: AgentLogLevel | null | undefined): boolean {
  return level !== "info" && level !== "debug";
}

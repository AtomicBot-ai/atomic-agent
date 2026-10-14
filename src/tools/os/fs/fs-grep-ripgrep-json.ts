export interface RgMatchRecord {
  lineNumber: number;
  text: string;
  submatches: Array<{ start: number; end: number; text: string }>;
  isContext: boolean;
}

export interface RgFileRecord {
  path: string;
  matches: RgMatchRecord[];
  matchCount: number;
}

interface RgJsonEnvelope {
  type: "begin" | "match" | "context" | "end" | "summary";
  data: Record<string, unknown>;
}

interface RgSubmatch {
  match: { text?: string } | undefined;
  start: number;
  end: number;
}

/**
 * Parse the NDJSON stream produced by `rg --json` into a flat list of
 * per-file records. The ripgrep envelope is documented here:
 *   https://docs.rs/grep-printer/latest/grep_printer/#json-output
 *
 * We only care about `match` and `context` records; `begin`/`end`/`summary`
 * are used to delimit file boundaries without allocating extra state.
 */
export function parseRipgrepJson(stdout: string): RgFileRecord[] {
  const files = new Map<string, RgFileRecord>();
  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    if (rawLine.length === 0) continue;
    let envelope: RgJsonEnvelope;
    try {
      envelope = JSON.parse(rawLine) as RgJsonEnvelope;
    } catch {
      continue;
    }
    if (envelope.type !== "match" && envelope.type !== "context") continue;
    const path = extractText(envelope.data.path);
    if (path === undefined) continue;
    const lineNumber =
      typeof envelope.data.line_number === "number"
        ? envelope.data.line_number
        : 0;
    const text = extractText(envelope.data.lines) ?? "";
    const submatchesRaw = Array.isArray(envelope.data.submatches)
      ? (envelope.data.submatches as RgSubmatch[])
      : [];
    const submatches = submatchesRaw.map((sm) => ({
      start: typeof sm.start === "number" ? sm.start : 0,
      end: typeof sm.end === "number" ? sm.end : 0,
      text: extractText(sm.match) ?? "",
    }));
    const existing = files.get(path) ?? {
      path,
      matches: [],
      matchCount: 0,
    };
    existing.matches.push({
      lineNumber,
      text: text.replace(/\r?\n$/, ""),
      submatches,
      isContext: envelope.type === "context",
    });
    if (envelope.type === "match") existing.matchCount++;
    files.set(path, existing);
  }
  return Array.from(files.values());
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === "string") return text;
    const bytes = (value as Record<string, unknown>).bytes;
    if (typeof bytes === "string") {
      try {
        return Buffer.from(bytes, "base64").toString("utf8");
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

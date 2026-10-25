import { namesFolder } from "./fs-move-plan.js";

/**
 * The argument shapes small models reach for instead of `os.fs.move`'s
 * own, read as the canonical form (ATO-899).
 *
 * Seen live: `{"paths":["archive (4).zip"],"destination":"Archives/archive (4).zip"}`
 * came back "unknown arguments `paths`, `destination`", and the model
 * re-sent the same keys until the turn ran out — it never found
 * `from`/`to` on its own. The call's intent is not in doubt, so it is
 * read as `from`/`to` (or `moves`), and the result says which reading
 * was taken so the next call uses the real keys.
 *
 * Do-no-harm, as with the key repair in `coerce-tool-args.ts`: nothing
 * is read when any canonical location key (`from`, `to`, `moves`) is
 * also given — an alias never overrides or merges with what the model
 * did say — nor when two aliases name the same side, nor when either
 * side is missing or not the shape below. Those calls keep the
 * unknown-argument refusal. Every other key (`overwrite`, or one that is
 * unknown) is passed through as sent, so an unknown one is still refused.
 */
const SOURCE_ALIASES = ["paths", "sources", "src", "source"] as const;
const DEST_ALIASES = ["destination", "dest", "target"] as const;
const CANONICAL = ["from", "to", "moves"] as const;

export interface MoveAliasReading {
  /** The call in canonical form: `{ from, to }` or `{ moves }`, other keys kept. */
  readonly args: Record<string, unknown>;
  /** One line for the tool result: which keys were read as what. */
  readonly note: string;
}

/** `null`, `""` and `[]` count as absent, as in `parseMoveArgs`. */
function given(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== "" &&
    !(Array.isArray(value) && value.length === 0)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * A source alias's value as a list of paths, or `null` when it is not
 * one. A list that arrived one level over-encoded (`"[\"a\",\"b\"]"`,
 * which `coerce-tool-args.ts` cannot unwrap for a key outside the
 * schema) is read as the list; a string that only looks like one
 * (`"[draft] notes.txt"`) stays a path.
 */
function sourceList(value: unknown): string[] | null {
  if (nonEmptyString(value)) {
    const listed = encodedList(value);
    return listed ?? [value];
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(nonEmptyString) ? (value as string[]) : null;
}

function encodedList(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(nonEmptyString)
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

/** The single alias key of `names` present in `args`, or `null` for none or several. */
function onlyAlias(
  args: Record<string, unknown>,
  names: readonly string[],
): string | null {
  const present = names.filter((name) => Object.hasOwn(args, name));
  return present.length === 1 ? present[0]! : null;
}

/** Aliases that name a list of paths; their destination reads as a folder. */
const LIST_ALIASES: ReadonlySet<string> = new Set(["paths", "sources"]);

function lastSegment(path: string, platform: NodeJS.Platform): string {
  return path.split(platform === "win32" ? /[\\/]/ : "/").pop() ?? "";
}

/**
 * For a one-entry list alias: does `dest` still read as the full target
 * path? Yes when its last segment has an extension (`Archives/a.zip`),
 * repeats the source's name (`Archives/a` for `a`), or it names an
 * existing file. Anything else (`Archives`) is a folder to move into:
 * `{paths:["a.zip"], destination:"Archives"}` said "put these in
 * Archives", the same as with two paths, and must not rename `a.zip` to
 * an extensionless file called `Archives`.
 */
function namesTargetFile(
  source: string,
  dest: string,
  platform: NodeJS.Platform,
  isFile: ((path: string) => boolean) | undefined,
): boolean {
  const name = lastSegment(dest, platform);
  if (/.\.[^.]+$/.test(name)) return true;
  if (name === lastSegment(source, platform)) return true;
  return isFile?.(dest) === true;
}

const CANONICAL_HINT = "os.fs.move takes { from, to } or { moves: [{ from, to }] }";

export interface MoveAliasOptions {
  platform?: NodeJS.Platform;
  /**
   * Whether `to` (as sent, relative to the working directory) is an
   * existing file. The registry passes one; a reader without it (the
   * key guard, transcript bookkeeping) treats the answer as no.
   */
  isFile?: (path: string) => boolean;
}

/**
 * `args` read as `os.fs.move`'s canonical form, or `null` when the call
 * uses no alias or cannot be read unambiguously (see above).
 *
 * A string source (`src`, `source`) with a destination is
 * `{ from, to }`, and `to` keeps the tool's own rule (a trailing
 * separator or an existing folder means "inside it", anything else is
 * the full target path). A list source (`paths`, `sources`) means "put
 * these there": with several entries, or one whose destination does not
 * read as a file name (`namesTargetFile`), each becomes a move whose
 * `to` ends in `/` — the tool's "move inside" form, which also creates
 * the folder when it is missing.
 */
export function readMoveAliases(
  args: Record<string, unknown>,
  options: MoveAliasOptions = {},
): MoveAliasReading | null {
  const platform = options.platform ?? process.platform;
  const sourceKey = onlyAlias(args, SOURCE_ALIASES);
  const destKey = onlyAlias(args, DEST_ALIASES);
  if (sourceKey === null || destKey === null) return null;
  if (CANONICAL.some((key) => given(args[key]))) return null;
  const sources = sourceList(args[sourceKey]);
  const dest = args[destKey];
  if (sources === null || !nonEmptyString(dest)) return null;

  const rest: Record<string, unknown> = { ...args };
  delete rest[sourceKey];
  delete rest[destKey];
  for (const key of CANONICAL) delete rest[key];

  const folder = namesFolder(dest, platform) ? dest : `${dest}/`;
  if (sources.length === 1) {
    const intoFolder =
      LIST_ALIASES.has(sourceKey) &&
      !namesTargetFile(sources[0]!, dest, platform, options.isFile);
    const to = intoFolder ? folder : dest;
    return {
      args: { ...rest, from: sources[0], to },
      note: intoFolder
        ? `note: read \`${sourceKey}\` as \`from\` and \`${destKey}\` as the folder \`to\`: \`${folder}\`; ${CANONICAL_HINT}`
        : `note: read \`${sourceKey}\` as \`from\` and \`${destKey}\` as \`to\`; ${CANONICAL_HINT}`,
    };
  }
  return {
    args: { ...rest, moves: sources.map((from) => ({ from, to: folder })) },
    note:
      `note: read \`${sourceKey}\` (${sources.length} paths) and \`${destKey}\` as moves into \`${folder}\`; ` +
      CANONICAL_HINT,
  };
}

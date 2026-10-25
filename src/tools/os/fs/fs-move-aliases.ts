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

/** `null` and `""` count as absent, as in `parseMoveArgs`. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A source alias's value as a list of paths, or `null` when it is not one. */
function sourceList(value: unknown): string[] | null {
  if (nonEmptyString(value)) return [value];
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(nonEmptyString) ? (value as string[]) : null;
}

/** The single alias key of `names` present in `args`, or `null` for none or several. */
function onlyAlias(
  args: Record<string, unknown>,
  names: readonly string[],
): string | null {
  const present = names.filter((name) => Object.hasOwn(args, name));
  return present.length === 1 ? present[0]! : null;
}

const CANONICAL_HINT = "os.fs.move takes { from, to } or { moves: [{ from, to }] }";

/**
 * `args` read as `os.fs.move`'s canonical form, or `null` when the call
 * uses no alias or cannot be read unambiguously (see above).
 *
 * One source with a destination is `{ from, to }`: `to` keeps the
 * tool's own rule (a trailing separator or an existing folder means
 * "inside it", anything else is the full target path). Several sources
 * with one destination can only mean a folder they all go into, so each
 * becomes a `moves` entry whose `to` ends in `/` — the tool's
 * "move inside" form, which also creates the folder when it is missing.
 */
export function readMoveAliases(
  args: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): MoveAliasReading | null {
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

  if (sources.length === 1) {
    return {
      args: { ...rest, from: sources[0], to: dest },
      note: `note: read \`${sourceKey}\` as \`from\` and \`${destKey}\` as \`to\`; ${CANONICAL_HINT}`,
    };
  }
  const folder = namesFolder(dest, platform) ? dest : `${dest}/`;
  return {
    args: { ...rest, moves: sources.map((from) => ({ from, to: folder })) },
    note:
      `note: read \`${sourceKey}\` (${sources.length} paths) and \`${destKey}\` as moves into \`${folder}\`; ` +
      CANONICAL_HINT,
  };
}

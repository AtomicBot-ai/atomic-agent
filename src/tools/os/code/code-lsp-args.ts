/**
 * Arguments of `os.code.lsp` (ATO-2373), and the column a request asks
 * about. Models often know the line and the name but not the column, so
 * `query` on a position action names the symbol on that line, and with
 * neither the line's first word is used.
 */
import { LSP_NAV_ACTIONS, type LspNavAction } from "../fs/lsp/lsp-navigation.js";
import { OS_CODE_LSP_CONTRACT } from "./code-lsp-contract.js";

const TOOL = OS_CODE_LSP_CONTRACT.name;
export const LSP_DEFAULT_RESULTS = 50;
export const LSP_MAX_RESULTS = 200;

export interface LspArgs {
  readonly action: LspNavAction;
  readonly path: string;
  /** 1-based; 1 for `symbols`, which ignores it. */
  readonly line: number;
  /** 1-based, when given. */
  readonly col?: number;
  readonly query?: string;
  readonly maxResults: number;
}

function positiveInteger(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    throw new Error(`${TOOL}: \`${name}\` must be a positive number (1-based)`);
  }
  return Math.floor(raw);
}

export function parseLspArgs(raw: Record<string, unknown>): LspArgs {
  const action = raw.action;
  if (typeof action !== "string" || !(LSP_NAV_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`${TOOL}: \`action\` must be one of ${LSP_NAV_ACTIONS.join(", ")}`);
  }
  const path = raw.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error(`${TOOL}: \`path\` must be a non-empty string`);
  }
  if (raw.query !== undefined && raw.query !== null && typeof raw.query !== "string") {
    throw new Error(`${TOOL}: \`query\` must be a string`);
  }
  const query = typeof raw.query === "string" && raw.query.trim().length > 0 ? raw.query.trim() : undefined;
  const line = positiveInteger(raw.line, "line");
  const col = positiveInteger(raw.col, "col");
  const nav = action as LspNavAction;
  if (nav !== "symbols" && line === undefined) {
    throw new Error(`${TOOL}: \`${nav}\` needs \`line\` (1-based), and \`col\` or \`query\` to name the symbol`);
  }
  const max = positiveInteger(raw.maxResults, "maxResults") ?? LSP_DEFAULT_RESULTS;
  return {
    action: nav,
    path,
    line: line ?? 1,
    ...(col === undefined ? {} : { col }),
    ...(query === undefined ? {} : { query }),
    maxResults: Math.min(max, LSP_MAX_RESULTS),
  };
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The 0-based character the request asks about: `col` when given (it may
 * point past the end; servers clamp), else where `query` stands on the
 * line (as a whole word first), else the line's first identifier.
 */
export function resolveCharacter(args: LspArgs, text: string): number {
  if (args.action === "symbols") return 0;
  const lines = text.split(/\r?\n/);
  if (args.line > lines.length) {
    throw new Error(`${TOOL}: line ${args.line} is past the end of the file (${lines.length} lines)`);
  }
  if (args.col !== undefined) return args.col - 1;
  const row = lines[args.line - 1] ?? "";
  if (args.query !== undefined) {
    const word = new RegExp(`(?<![\\w$])${escapeRegExp(args.query)}(?![\\w$])`).exec(row);
    const at = word?.index ?? row.indexOf(args.query);
    if (at === -1) {
      throw new Error(
        `${TOOL}: \`${args.query}\` is not on line ${args.line}; pass \`col\`, or the line where it appears`,
      );
    }
    return at;
  }
  const first = IDENTIFIER.exec(row);
  return first?.index ?? Math.max(0, row.length - row.trimStart().length);
}

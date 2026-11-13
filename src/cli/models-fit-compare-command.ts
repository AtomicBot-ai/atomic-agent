/**
 * `models fit-test --compare <before.json> <after.json> [--before-model <id>]
 * [--after-model <id>] [--json]` (ATO-1105): a before/after report over
 * two `models fit-test --out` files of the same task set, e.g. a base
 * model against the same model with an adapter. Reads files only; loads
 * no model.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareFitRuns,
  formatFitComparison,
  parseFitTestRun,
} from "../fit-test/index.js";
import { readCliOption } from "./models-handlers.js";

export const FIT_COMPARE_USAGE =
  "usage: atomic-agent models fit-test --compare <before.json> <after.json> [--before-model <id>] [--after-model <id>] [--json]\n";

export interface FitCompareArgs {
  beforePath: string;
  afterPath: string;
  beforeModel: string | null;
  afterModel: string | null;
  json: boolean;
}

export function parseFitCompareArgs(args: string[]): FitCompareArgs | { error: string } {
  const at = args.indexOf("--compare");
  const beforePath = args[at + 1];
  const afterPath = args[at + 2];
  if (at === -1 || !beforePath || !afterPath || beforePath.startsWith("--") || afterPath.startsWith("--")) {
    return { error: "--compare needs two run files written by `models fit-test --out`" };
  }
  return {
    beforePath: resolve(beforePath),
    afterPath: resolve(afterPath),
    beforeModel: readCliOption(args, "--before-model") ?? null,
    afterModel: readCliOption(args, "--after-model") ?? null,
    json: args.includes("--json"),
  };
}

export function runModelsFitCompare(args: string[]): number {
  const parsed = parseFitCompareArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${FIT_COMPARE_USAGE}`);
    return 2;
  }
  const read = (path: string) => parseFitTestRun(JSON.parse(readFileSync(path, "utf8")));
  const comparison = compareFitRuns(read(parsed.beforePath), read(parsed.afterPath), {
    before: parsed.beforeModel,
    after: parsed.afterModel,
  });
  process.stdout.write(parsed.json ? `${JSON.stringify(comparison, null, 2)}\n` : formatFitComparison(comparison));
  return 0;
}

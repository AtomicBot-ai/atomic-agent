import type { NormalisedCommand } from "./guard-types.js";
import { normaliseCommand } from "./normalise.js";
import {
  NESTED_SHELL_PROGRAMS,
  invocationsOf,
  scanNestedShellOptions,
  splitCommandSegments,
} from "./command-segments.js";

/**
 * The command lines a line runs inside quotes (ATO-2730): the line of
 * `sh -c "<line>"` / `bash -lc '<line>'` (any `NESTED_SHELL_PROGRAMS`,
 * behind `sudo`, `env`, `xargs` too) and the words `eval` joins and runs.
 * The quoted line stays one word for the argument rules, so `sh -c "cat
 * ~/.ssh/id_rsa"` asked only as an ordinary nested shell, quiet in
 * bypass. Each line comes back normalised the way the shell tool hands a
 * command line to the guard (whitespace tokens), for the argument rules
 * to read again.
 */
export function nestedCommandLines(input: NormalisedCommand, cwd: string): NormalisedCommand[] {
  const lines: string[] = [];
  for (const words of splitCommandSegments(input.joined)) {
    for (const program of NESTED_SHELL_PROGRAMS) {
      for (const args of invocationsOf([words], program)) {
        lines.push(...scanNestedShellOptions(args, program).scripts);
      }
    }
    for (const args of invocationsOf([words], "eval")) lines.push(args.join(" "));
  }
  const commands: NormalisedCommand[] = [];
  for (const line of lines) {
    const tokens = line.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    commands.push(normaliseCommand({ cmd: tokens[0]!, rawArgs: tokens.slice(1), cwd }));
  }
  return commands;
}

import type { CliOutdated } from "../llm/provider/completion-types.js";

/**
 * ATO-2523. The Claude Code or Codex CLI that answered is older than the
 * oldest version Atomic Agent works with (ATO-1685's `--version` check).
 * Before this event an old CLI was only logged on a turn that worked, and
 * named in the error of one that failed, so the person learned it when a
 * flag it lacks broke a turn. Rides the `AgentLoopEvent` union, as
 * `tool_disabled` does (ATO-1417), so the TUI and the HTTP stream can
 * say it in the chat before anything breaks.
 *
 * Emitted once per session and CLI: the version is read once per process,
 * and every completion of every turn carries the same mark.
 */
export interface CliOutdatedEvent {
  type: "cli_outdated";
  stepIndex: number;
  cli: CliOutdated["cli"];
  productName: string;
  version: string;
  minimum: string;
  /** Plain-text update commands for this platform, in the order to offer them. */
  updateCommands: readonly string[];
}

/**
 * The chat line for a `cli_outdated` event, shared by the TUI and the
 * HTTP frame: "Claude Code 2.1.10 is out of date: run `claude update`
 * (Atomic Agent needs 2.1.22 or newer)."
 */
export function cliOutdatedNotice(event: Pick<CliOutdatedEvent, "productName" | "version" | "minimum" | "updateCommands">): string {
  const commands = event.updateCommands.map((c) => `\`${c}\``).join(" or ");
  const run = commands.length > 0 ? `: run ${commands}` : "";
  return `${event.productName} ${event.version} is out of date${run} (Atomic Agent needs ${event.minimum} or newer).`;
}

/** Sessions and CLIs already told, so a long-lived loop says each once. */
export class CliOutdatedWarnings {
  private readonly told = new Set<string>();
  private static readonly MAX = 500;

  /** True the first time for this session and CLI, false after. */
  shouldWarn(sessionId: string, cli: string): boolean {
    const key = `${sessionId}\u0000${cli}`;
    if (this.told.has(key)) return false;
    this.told.add(key);
    if (this.told.size > CliOutdatedWarnings.MAX) {
      const oldest = this.told.values().next().value;
      if (oldest !== undefined) this.told.delete(oldest);
    }
    return true;
  }
}

/** The `cli_outdated` event a completion calls for, or null: none marked, or this session was told. */
export function cliOutdatedEvent(
  mark: CliOutdated | undefined,
  warnings: CliOutdatedWarnings,
  sessionId: string,
  stepIndex: number,
): CliOutdatedEvent | null {
  if (!mark) return null;
  if (!warnings.shouldWarn(sessionId, mark.cli)) return null;
  return {
    type: "cli_outdated",
    stepIndex,
    cli: mark.cli,
    productName: mark.productName,
    version: mark.version,
    minimum: mark.minimum,
    updateCommands: mark.updateCommands,
  };
}

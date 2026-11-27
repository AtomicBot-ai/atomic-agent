import type { UsageHistoryFile } from "../../session/usage-history.js";
import { buildUsageReport, usageReportJson } from "../../session/usage-report.js";
import { parseUsageArgs, usageHelp } from "../../session/usage-report-args.js";
import {
  readDefaultUsageHistory,
  usageReferenceProviders,
  usageToday,
  type UsageReferenceProviders,
} from "../../session/usage-report-defaults.js";
import { formatUsageReportText } from "../../session/usage-report-format.js";
import type { TuiAction } from "../tui-action.js";

/**
 * `/usage [options]` (ATO-2442): the TUI's view of the per-day history,
 * the same report `atomic-agent usage` prints, as a system message.
 * Runs on the submit path because the slash dispatcher and the reducer
 * are pure; the history is a small JSON file in the state dir, read
 * once per command. Precedent: Claude Code `/usage`, Codex `/status`.
 */
export interface UsageHistoryCommandDeps {
  readHistory?: () => UsageHistoryFile;
  today?: () => string;
  providers?: () => UsageReferenceProviders;
}

const MORE_HINT = "More: /usage --days 30 --tools --projects --sessions, or /usage --help.";

export function runUsageHistoryCommand(
  args: string,
  dispatch: (action: TuiAction) => void,
  deps: UsageHistoryCommandDeps = {},
): void {
  const say = (text: string): void => dispatch({ type: "system_message", text });
  const parsed = parseUsageArgs(args.split(/\s+/).filter((a) => a !== ""));
  if (!parsed.ok) {
    say(`${parsed.error}\n\n${usageHelp("/usage")}`);
    return;
  }
  const options = parsed.options;
  if (options.help) {
    say(usageHelp("/usage"));
    return;
  }
  let text: string;
  try {
    const history = (deps.readHistory ?? (() => readDefaultUsageHistory()))();
    const report = buildUsageReport(history, {
      days: options.days,
      today: (deps.today ?? (() => usageToday()))(),
      compare: options.compare,
      ...(deps.providers ?? usageReferenceProviders)(),
    });
    text = options.json
      ? JSON.stringify(usageReportJson(report, options), null, 2)
      : formatUsageReportText(report, options);
  } catch {
    say("Could not read the usage history just now. Try again, or run atomic-agent usage in a terminal.");
    return;
  }
  const bare = args.trim() === "";
  say(bare ? `${text}\n${MORE_HINT}` : text);
}

import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  buildLogbookQuery,
  describeWindow,
  formatLogbookEntries,
  readLogbookDay,
  readLogbookSettings,
  selectLogbookEntries,
  type LogbookEntry,
  type LogbookQuery,
} from "../../logbook/index.js";
import type { ToolDefinition } from "../tool-registry.js";

export const LOGBOOK_QUERY_TOOL = "logbook.query";

/**
 * `logbook.query { day?, part?, from?, to?, contains?, limit? }`
 * (ATO-2363): read what the person's local logbook noted about their
 * screen, for "what did I do yesterday afternoon" and the standup
 * recipe. Read-only; it never takes a screenshot. The notes were written
 * by a model looking at whatever was on screen (web pages, mail), so the
 * result is framed as outside data, not instructions. The notes were made
 * on this computer, but the answer goes to the model serving the chat:
 * when that model (or a fallback) is not on this computer, the call asks
 * first (`logbook_cloud`, silent only at full trust).
 */
const RESULT_OPTIONS = { maxSummaryLength: 8_000, maxTailLines: Number.MAX_SAFE_INTEGER } as const;

export interface LogbookQueryToolOptions extends DangerousToolOptions {
  stateDir: string;
  /**
   * Whether the model serving this step runs on this computer
   * (`ToolContext.providerId`, else the active text provider), read per
   * call. `false` makes the call ask before any note is read.
   */
  notesStayLocal: (providerId: string | undefined) => boolean;
  now?: () => Date;
}

export function buildLogbookQueryTool(options: LogbookQueryToolOptions): ToolDefinition {
  const now = options.now ?? (() => new Date());
  return {
    name: LOGBOOK_QUERY_TOOL,
    description:
      "Read the person's logbook: short notes a local model wrote about their screen every few minutes, kept on this computer; the notes you read go to the model serving this chat. Pick a day (today, yesterday or YYYY-MM-DD), optionally a part (morning, afternoon, evening) or from/to times like 14:00, and words to match. Use it for what they did and for standups.",
    readonly: true,
    untrustedOutput: "logbook screen notes",
    async run(args, ctx) {
      let query: LogbookQuery;
      try {
        query = buildLogbookQuery(args, now());
      } catch (err) {
        return result("error", (err as Error).message);
      }
      if (!options.notesStayLocal(ctx.providerId)) {
        // A denial throws ApprovalDeniedError; the dispatcher reports it.
        await requireApproval(options, {
          sessionId: ctx.sessionId,
          tool: LOGBOOK_QUERY_TOOL,
          category: "logbook_cloud",
          reason: `read your logbook notes for ${describeWindow(query)} into this chat; the model serving it is not on this computer, so the notes leave it`,
          affectedResources: [`logbook ${query.day}`],
        }, ctx.signal);
      }
      let entries: LogbookEntry[];
      try {
        entries = readLogbookDay(options.stateDir, query.day);
      } catch (err) {
        return result("error", `could not read the logbook: ${(err as Error).message}`);
      }
      const picked = selectLogbookEntries(entries, query);
      const span = describeWindow(query);
      if (picked.length === 0) {
        const on = readLogbookSettings(options.stateDir).enabled;
        const hint = on
          ? ""
          : " The logbook is off; the person turns it on with `atomic-agent logbook start` (it needs a local vision model).";
        return result("ok", `No logbook notes for ${span}${query.contains ? ` matching "${query.contains}"` : ""}.${hint}`, {
          day: query.day,
          count: 0,
          total: entries.length,
        });
      }
      const head = `Logbook for ${span}: ${picked.length} of ${entries.length} notes (time, app, what was on screen).`;
      return result("ok", `${head}\n${formatLogbookEntries(picked)}`, {
        day: query.day,
        count: picked.length,
        total: entries.length,
      });
    },
  };
}

function result(status: "ok" | "error", output: string, details: Record<string, unknown> = {}) {
  return compressToolResult({ tool: LOGBOOK_QUERY_TOOL, status, output, details }, RESULT_OPTIONS);
}

/**
 * ATO-2442: Settings > Usage (renderer/usage-tab.js).
 *
 *   usage:report  GET /api/usage?days=&compare=  the agent's usage report
 *
 * Answers `{ok:true, data}` or `{ok:false, error, detail, unsupported}`
 * (main/usage-report.ts): `error` is for the window, `detail` goes behind
 * its "Details". Read-only; asked only when the tab is shown or refreshed.
 */

import { ipcMain } from "electron";

import { cleanUsageQuery, usageCall, usageQueryString, type UsageAnswer } from "./usage-report.js";

export interface UsageIpcDeps {
  client: { usageReport: (query: string) => Promise<unknown> };
}

export function wireUsageIpc({ client }: UsageIpcDeps): void {
  ipcMain.handle("usage:report", async (_event, payload: unknown): Promise<UsageAnswer> => {
    const query = cleanUsageQuery(payload);
    if (!query) return { ok: false, error: "That period or model name is not one the usage report takes.", detail: "", unsupported: false };
    return usageCall(() => client.usageReport(usageQueryString(query)));
  });
}

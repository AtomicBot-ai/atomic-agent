import { join } from "node:path";

import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { cleanAppName, pageRefusal } from "./app-names.js";
import { saveApp } from "./app-store.js";
import {
  APP_SAVE_TOOL,
  appDetails,
  appRefusal,
  appsRootOf,
  argError,
  askForApp,
  nowOf,
  optionalString,
  type AppToolOptions,
} from "./app-tool-shared.js";

/**
 * `app.save { name, html }` (ATO-2459): keep a self-contained HTML page
 * as a new app in My apps, so "make me a currency converter" ends with
 * an app the person opens from the desktop's Apps, in its own window,
 * offline and without the agent. Asks first (app-tool-shared.ts). Like
 * Claude's artifact "Publish" and ChatGPT's "Create a GPT": one call
 * makes a thing that outlives the chat.
 */
export function buildAppSaveTool(options: AppToolOptions): ToolDefinition {
  return {
    name: APP_SAVE_TOOL,
    description:
      "Save a self-contained HTML page as a new app in the person's My apps. It opens in its own window from the desktop app, offline, with no network access.",
    readonly: false,
    async run(rawArgs, ctx) {
      const name = optionalString(rawArgs.name);
      if (name === null) return argError(APP_SAVE_TOOL, "name", "must be a string");
      const refusal = pageRefusal(rawArgs.html);
      if (refusal) return appRefusal(APP_SAVE_TOOL, refusal, "html");
      const html = rawArgs.html as string;
      const shown = cleanAppName(name);
      const root = appsRootOf(options);
      await askForApp(options, ctx, {
        tool: APP_SAVE_TOOL,
        kind: "write",
        path: join(root, "index.html"),
        reason: `save "${shown}" as an app in My apps`,
        preview: `${shown} (${Math.max(1, Math.round(Buffer.byteLength(html, "utf8") / 1024))} KB page)`,
        app: shown,
      });
      const saved = saveApp(root, { name: shown, html, chatId: ctx.sessionId }, nowOf(options));
      if (!saved.ok) return appRefusal(APP_SAVE_TOOL, saved.reason);
      return compressToolResult({
        tool: APP_SAVE_TOOL,
        status: "ok",
        output:
          `saved "${saved.app.name}" to My apps as ${saved.app.id}. ` +
          "The person opens it from Apps in the desktop app's sidebar; change it later with app.update and this id.",
        details: { ...appDetails(saved.app), saved: true, page: join(root, saved.app.id, "index.html") },
      });
    },
  };
}

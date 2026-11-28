import { refuseInIncognito } from "../memory/incognito-guard.js";
import type { ToolRegistry } from "../tool-registry.js";
import { buildAppDeleteTool } from "./app-delete-tool.js";
import { buildAppListTool } from "./app-list-tool.js";
import { buildAppSaveTool } from "./app-save-tool.js";
import type { AppToolOptions } from "./app-tool-shared.js";
import { buildAppUpdateTool } from "./app-update-tool.js";

export { buildAppDeleteTool } from "./app-delete-tool.js";
export { buildAppListTool } from "./app-list-tool.js";
export { buildAppSaveTool } from "./app-save-tool.js";
export { buildAppUpdateTool } from "./app-update-tool.js";
export {
  APP_DELETE_TOOL,
  APP_LIST_TOOL,
  APP_SAVE_TOOL,
  APP_UPDATE_TOOL,
  type AppToolOptions,
} from "./app-tool-shared.js";

/** What an incognito chat answers instead of keeping an app. */
export const INCOGNITO_APP_REFUSAL =
  "This is an incognito chat, so nothing from it is kept: My apps are not changed here. Show the page in the chat instead, or ask the person to save it from a normal chat.";

/**
 * The My apps tools (ATO-2459): `app.save`, `app.update`, `app.delete`,
 * `app.list` over `<stateDir>/apps`, the folder the desktop's My apps
 * reads (ATO-2383). Always registered: they only touch that folder and
 * every change asks first. The three that change something refuse in an
 * incognito chat, as memory writes and scheduled tasks do.
 */
export function registerAppTools(
  registry: ToolRegistry,
  options: AppToolOptions & { isIncognitoSession?: (sessionId: string) => boolean },
): void {
  const guarded = (tool: ReturnType<typeof buildAppSaveTool>) =>
    refuseInIncognito(tool, options.isIncognitoSession, INCOGNITO_APP_REFUSAL);
  registry.register(guarded(buildAppSaveTool(options)));
  registry.register(guarded(buildAppUpdateTool(options)));
  registry.register(guarded(buildAppDeleteTool(options)));
  registry.register(buildAppListTool(options));
}

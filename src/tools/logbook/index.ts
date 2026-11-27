import type { ToolRegistry } from "../tool-registry.js";
import { buildLogbookQueryTool, type LogbookQueryToolOptions } from "./logbook-query-tool.js";

export { buildLogbookQueryTool, LOGBOOK_QUERY_TOOL } from "./logbook-query-tool.js";
export type { LogbookQueryToolOptions } from "./logbook-query-tool.js";

/**
 * `logbook.query` (ATO-2363). Always registered, since it only reads
 * files; its descriptor is offered only while the logbook is on or has
 * notes (`GATED_TOOLS.logbook`, `logbookToolOffered`), so a person who
 * never turned it on sees no change in the prompt.
 */
export function registerLogbookTools(registry: ToolRegistry, options: LogbookQueryToolOptions): void {
  registry.register(buildLogbookQueryTool(options));
}

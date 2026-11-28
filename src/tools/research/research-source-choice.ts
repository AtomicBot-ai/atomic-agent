import type { ResearchSources } from "./research-args.js";
import { FILES_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, type DocumentPassages, type ToolInvoker } from "./research-sources.js";

/** My files as `research.deep` reads it: the index's text and its folders (ATO-2507). */
export type ResearchDocuments = DocumentPassages & { listFolders(): readonly unknown[] };

/**
 * Which sources a run uses (ATO-2507). Asked for: that, or a plain
 * reason it cannot. Not asked: the web while web search is on, else
 * the documents in My files when there are any, as OpenClaw's deep
 * research keeps to the given documents unless the web is asked for.
 */
export function chooseSources(input: {
  asked?: ResearchSources;
  tools: ToolInvoker;
  webSearchOn: boolean;
  documents?: ResearchDocuments;
}): { sources: ResearchSources } | { error: string } {
  const { asked, tools } = input;
  const webTools = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].find((name) => !tools.has(name));
  const webError = webTools !== undefined
    ? `${webTools} is not available, so there is nothing to research with on the web`
    : !input.webSearchOn
      ? 'web search is turned off (web.search.enabled is false). To research the documents in My files instead, pass sources: "documents".'
      : null;
  const folders = input.documents?.listFolders().length ?? 0;
  const docsError = input.documents === undefined || !tools.has(FILES_SEARCH_TOOL)
    ? "My files is not set up in this app, so there are no documents to research"
    : folders === 0
      ? "No folders are in My files yet. Ask the person to add a folder on the My files screen, then research again."
      : null;
  if (asked === "web") return webError === null ? { sources: "web" } : { error: webError };
  if (asked === "documents") return docsError === null ? { sources: "documents" } : { error: docsError };
  if (asked === "both") {
    const error = webError ?? docsError;
    return error === null ? { sources: "both" } : { error };
  }
  if (webError === null) return { sources: "web" };
  if (docsError === null) return { sources: "documents" };
  return { error: webTools !== undefined ? `${webTools} is not available, so there is nothing to research with` : webError };
}

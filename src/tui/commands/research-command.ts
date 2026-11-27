/**
 * `/research [--docs | --both] <question>` (ATO-2133, ATO-2507). Pure:
 * the command becomes an ordinary user message that asks the agent to
 * run `research.deep`, so the turn goes through the same approvals,
 * cancellation and tool dispatch as any other message. The model still
 * makes the call. `--docs` keeps it to the documents in My files
 * (nothing goes online), `--both` reads the web and the documents.
 */
export const RESEARCH_USAGE =
  "Usage: /research [--docs | --both] <question>. Researches the question with research.deep: sub-questions, several pages, quotes checked against each page, and a Markdown report saved in the working folder. --docs searches only your documents in My files; --both searches the web and your documents.";

export type ResearchCommand = { kind: "message"; text: string } | { kind: "usage"; message: string };

export type ResearchScope = "web" | "documents" | "both";

const FLAGS: Record<string, ResearchScope> = {
  "--web": "web",
  "--docs": "documents",
  "--documents": "documents",
  "--files": "documents",
  "--both": "both",
};

export function parseResearchCommand(args: string): ResearchCommand {
  let rest = args.trim();
  let scope: ResearchScope = "web";
  const flag = /^(--[a-z]+)(?:\s+|$)/i.exec(rest);
  if (flag !== null) {
    const known = FLAGS[flag[1]!.toLowerCase()];
    if (known === undefined) return { kind: "usage", message: RESEARCH_USAGE };
    scope = known;
    rest = rest.slice(flag[0].length).trim();
  }
  if (rest.length === 0) return { kind: "usage", message: RESEARCH_USAGE };
  return { kind: "message", text: researchMessage(rest, scope) };
}

/** The message `/research` sends: the tool and its sources, then the question as typed. */
export function researchMessage(question: string, scope: ResearchScope = "web"): string {
  if (scope === "documents") {
    return `Research this in my documents in My files with the research.deep tool (sources: "documents", nothing online), then answer from its verified findings with their links: ${question}`;
  }
  if (scope === "both") {
    return `Research this on the web and in my documents in My files with the research.deep tool (sources: "both"), then answer from its verified findings with their links: ${question}`;
  }
  return `Research this with the research.deep tool, then answer from its verified findings with their links: ${question}`;
}

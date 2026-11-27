/**
 * `/research <question>` (ATO-2133). Pure: the command becomes an
 * ordinary user message that asks the agent to run `research.deep`, so
 * the turn goes through the same approvals, cancellation and tool
 * dispatch as any other message. The model still makes the call.
 */
export const RESEARCH_USAGE =
  "Usage: /research <question>. Researches the question on the web with research.deep: sub-questions, several pages, quotes checked against each page, and a Markdown report saved in the working folder.";

export type ResearchCommand = { kind: "message"; text: string } | { kind: "usage"; message: string };

export function parseResearchCommand(args: string): ResearchCommand {
  const question = args.trim();
  if (question.length === 0) return { kind: "usage", message: RESEARCH_USAGE };
  return { kind: "message", text: researchMessage(question) };
}

/** The message `/research` sends: the tool to use, then the question as typed. */
export function researchMessage(question: string): string {
  return `Research this with the research.deep tool, then answer from its verified findings with their links: ${question}`;
}

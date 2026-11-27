import { describe, expect, it } from "vitest";
import { parseResearchCommand, researchMessage, RESEARCH_USAGE } from "./research-command.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("/research (ATO-2133)", () => {
  it("turns the question into a message that names research.deep", () => {
    expect(parseResearchCommand("  heat pump sales in 2024  ")).toEqual({
      kind: "message",
      text: researchMessage("heat pump sales in 2024"),
    });
    expect(researchMessage("x")).toContain("research.deep");
  });

  it("prints the usage when there is no question", () => {
    expect(parseResearchCommand("   ")).toEqual({ kind: "usage", message: RESEARCH_USAGE });
  });

  it("keeps the plain message for a web question, word for word as before", () => {
    expect(researchMessage("x")).toBe("Research this with the research.deep tool, then answer from its verified findings with their links: x");
    expect(parseResearchCommand("--web x")).toEqual({ kind: "message", text: researchMessage("x") });
  });

  it("asks for documents with --docs and for both with --both (ATO-2507)", () => {
    const docs = parseResearchCommand("--docs  notice periods in my contracts");
    expect(docs).toEqual({ kind: "message", text: researchMessage("notice periods in my contracts", "documents") });
    expect(researchMessage("q", "documents")).toContain('sources: "documents"');
    expect(parseResearchCommand("--files q")).toEqual({ kind: "message", text: researchMessage("q", "documents") });
    expect(parseResearchCommand("--both q")).toEqual({ kind: "message", text: researchMessage("q", "both") });
    expect(researchMessage("q", "both")).toContain('sources: "both"');
  });

  it("prints the usage for a flag alone or an unknown flag", () => {
    expect(parseResearchCommand("--docs")).toEqual({ kind: "usage", message: RESEARCH_USAGE });
    expect(parseResearchCommand("--moon q")).toEqual({ kind: "usage", message: RESEARCH_USAGE });
  });

  it("is dispatched as a message to send, not as a forwarded buffer", () => {
    const sent = dispatchSlashCommand("/research heat pump sales in 2024");
    expect(sent.messageText).toBe(researchMessage("heat pump sales in 2024"));
    expect(sent.forwardAsMessage).toBe(false);
    expect(sent.clearBuffer).toBe(true);
    const bare = dispatchSlashCommand("/research");
    expect(bare.messageText).toBeUndefined();
    expect(bare.systemMessage).toBe(RESEARCH_USAGE);
  });
});

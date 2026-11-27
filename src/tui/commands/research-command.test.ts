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

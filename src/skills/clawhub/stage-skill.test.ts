import { describe, expect, it } from "vitest";
import { resolveSkillSource } from "./stage-skill.js";

describe("resolveSkillSource", () => {
  it("honours an explicit source", () => {
    expect(resolveSkillSource("anything", "clawhub")).toBe("clawhub");
    expect(resolveSkillSource("@alice/pdf", "github")).toBe("github");
  });

  it("infers clawhub from an @owner/slug identifier", () => {
    expect(resolveSkillSource("@alice/pdf")).toBe("clawhub");
  });

  it("infers skills.sh from a skills.sh/owner/repo/skill identifier", () => {
    expect(resolveSkillSource("skills.sh/anthropics/skills/pdf")).toBe("skills.sh");
    expect(resolveSkillSource("skills.sh/anthropics/skills/pdf", "github")).toBe("github");
  });

  it("infers github for a bare slug or owner/repo identifier", () => {
    expect(resolveSkillSource("anthropics/skills")).toBe("github");
    expect(resolveSkillSource("myskill")).toBe("github");
  });
});

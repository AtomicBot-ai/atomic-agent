import { describe, expect, it } from "vitest";
import {
  formatSkillIdentifier,
  looksLikeHubIdentifier,
  parseSkillIdentifier,
  parseTapRepo,
  SkillIdentifierError,
} from "./skill-hub-source.js";

describe("parseSkillIdentifier", () => {
  it("parses owner/repo/path", () => {
    expect(parseSkillIdentifier("anthropics/skills/pdf")).toEqual({
      owner: "anthropics",
      repo: "skills",
      path: "pdf",
    });
  });

  it("parses owner/repo with empty path", () => {
    expect(parseSkillIdentifier("openai/skills")).toEqual({
      owner: "openai",
      repo: "skills",
      path: "",
    });
  });

  it("parses a nested path with a git ref", () => {
    expect(parseSkillIdentifier("owner/repo/a/b@v1.2.0")).toEqual({
      owner: "owner",
      repo: "repo",
      path: "a/b",
      ref: "v1.2.0",
    });
  });

  it("rejects local paths and URLs", () => {
    for (const bad of ["./local", "/abs", "~/home", "https://x.com/SKILL.md"]) {
      expect(() => parseSkillIdentifier(bad)).toThrow(SkillIdentifierError);
    }
  });

  it("rejects a bare owner", () => {
    expect(() => parseSkillIdentifier("owner")).toThrow(SkillIdentifierError);
  });

  it("rejects invalid path segments", () => {
    expect(() => parseSkillIdentifier("owner/repo/a b")).toThrow(
      SkillIdentifierError,
    );
  });
});

describe("looksLikeHubIdentifier", () => {
  it("is true for owner/repo and false for local paths", () => {
    expect(looksLikeHubIdentifier("owner/repo/skill")).toBe(true);
    expect(looksLikeHubIdentifier("./my-skill")).toBe(false);
    expect(looksLikeHubIdentifier("/tmp/x")).toBe(false);
    expect(looksLikeHubIdentifier("just-a-name")).toBe(false);
  });
});

describe("parseTapRepo", () => {
  it("splits owner/repo", () => {
    expect(parseTapRepo("openai/skills")).toEqual({
      owner: "openai",
      repo: "skills",
    });
  });

  it("rejects non owner/repo strings", () => {
    expect(() => parseTapRepo("openai")).toThrow(SkillIdentifierError);
    expect(() => parseTapRepo("a/b/c")).toThrow(SkillIdentifierError);
  });
});

describe("formatSkillIdentifier", () => {
  it("omits the dir when empty", () => {
    expect(formatSkillIdentifier("o", "r", "")).toBe("o/r");
    expect(formatSkillIdentifier("o", "r", "pdf")).toBe("o/r/pdf");
  });
});

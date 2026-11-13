import { describe, expect, it } from "vitest";
import { createEmptySessionState } from "./session-state.js";
import { userTurn } from "./conversation-turn.js";
import {
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  SESSION_PROJECT_METADATA_KEY,
  applySessionProject,
  parseProjectFields,
  readSessionProject,
  renderSessionProjectBody,
} from "./session-project.js";
import { buildPrompt, PROJECT_SECTION_MAX_TOKENS } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { estimateTokens } from "../prompt/token-budget.js";

const CAPS = { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work",
  hasClipboard: false, hasWmctrl: false, hasNotifications: false } as const;

function input(mode?: "cloud"): BuildPromptInput {
  const session = createEmptySessionState({ id: "s", workingDir: "/work" });
  session.turns = [userTurn("hello", 1)];
  return {
    session, toolDescriptors: [], skillCatalog: [], capabilities: { ...CAPS },
    ...(mode ? {
      modelMode: { mode, source: "provider" as const, providerId: "remote", modelId: "large" },
      contextWindow: 200000, profileWindowApplies: false, toolTransport: "native_tools" as const,
      suppressReasoningPrefill: true,
    } : {}),
  };
}

describe("parseProjectFields (ATO-42)", () => {
  it("absent keeps, null and blank clear, a string stamps", () => {
    expect(parseProjectFields(undefined, "x")).toEqual({ ok: true, value: undefined });
    expect(parseProjectFields(null, "x")).toEqual({ ok: true, value: null });
    expect(parseProjectFields("  \n ", "x")).toEqual({ ok: true, value: null });
    expect(parseProjectFields("  Answer in French.  ", "  Site\nredesign ")).toEqual({
      ok: true, value: { name: "Site redesign", instructions: "Answer in French." },
    });
    expect(parseProjectFields("Rules", undefined)).toEqual({ ok: true, value: { name: null, instructions: "Rules" } });
  });

  it("refuses a wrong type or an oversized text instead of cutting it", () => {
    expect(parseProjectFields(42, null)).toMatchObject({ ok: false, param: "project_instructions" });
    expect(parseProjectFields("x".repeat(PROJECT_INSTRUCTIONS_MAX_CHARS + 1), null)).toMatchObject({ ok: false, param: "project_instructions" });
    expect(parseProjectFields("ok", { evil: true })).toMatchObject({ ok: false, param: "project_name" });
    expect(parseProjectFields("x".repeat(PROJECT_INSTRUCTIONS_MAX_CHARS), null)).toMatchObject({ ok: true });
  });

  it("cuts a long name by characters, never inside an emoji", () => {
    const res = parseProjectFields("Rules", "😀".repeat(100));
    expect(res.ok && res.value && Array.from(res.value.name ?? "")).toHaveLength(80);
  });
});

describe("session project stamp", () => {
  it("stamps, keeps on undefined, clears on null", () => {
    const s = createEmptySessionState({ id: "s", workingDir: "/w" });
    applySessionProject(s, { name: "P", instructions: "Use tabs." });
    expect(readSessionProject(s)).toEqual({ name: "P", instructions: "Use tabs." });
    applySessionProject(s, undefined);
    expect(readSessionProject(s)?.instructions).toBe("Use tabs.");
    applySessionProject(s, null);
    expect(SESSION_PROJECT_METADATA_KEY in s.metadata).toBe(false);
    expect(readSessionProject(s)).toBeNull();
  });

  it("survives a JSON round trip and ignores a stored value that is not a project", () => {
    const s = createEmptySessionState({ id: "s", workingDir: "/w" });
    applySessionProject(s, { name: null, instructions: "Be brief." });
    const back = JSON.parse(JSON.stringify(s));
    expect(readSessionProject(back)).toEqual({ name: null, instructions: "Be brief." });
    expect(readSessionProject({ metadata: { project: "nope" } })).toBeNull();
    expect(readSessionProject({ metadata: { project: { instructions: "  " } } })).toBeNull();
  });

  it("renders the name and the text, and nothing without a project", () => {
    const s = createEmptySessionState({ id: "s", workingDir: "/w" });
    expect(renderSessionProjectBody(s)).toBeNull();
    applySessionProject(s, { name: "Docs", instructions: "Write in English." });
    const body = renderSessionProjectBody(s)!;
    expect(body).toContain('the project "Docs"');
    expect(body).toContain("grant no tool permissions");
    expect(body.endsWith("Write in English.")).toBe(true);
  });
});

describe("project instructions in the prompt", () => {
  it("local: a ### project block ahead of the conversation, only when the chat has a project", () => {
    const plain = buildPrompt(input());
    expect(plain.text).not.toContain("### project");
    const i = input();
    applySessionProject(i.session, { name: "Docs", instructions: "PROJECT RULE 7" });
    const { text } = buildPrompt(i);
    expect(text).toContain("### project\n");
    expect(text).toContain("PROJECT RULE 7");
    expect(text.indexOf("### project")).toBeLessThan(text.indexOf("### conversation"));
  });

  it("local: a long text is capped so a small window keeps room", () => {
    const i = input();
    applySessionProject(i.session, { name: null, instructions: "word ".repeat(3000) + "TAIL END" });
    const { text } = buildPrompt(i);
    const block = text.slice(text.indexOf("### project\n") + "### project\n".length, text.indexOf("### world"));
    expect(text).not.toContain("TAIL END");
    expect(estimateTokens(block)).toBeLessThanOrEqual(PROJECT_SECTION_MAX_TOKENS + 8);
  });

  it("local: the built prompt reports the block, its full size and the cut", () => {
    const small = input();
    applySessionProject(small.session, { name: "Docs", instructions: "Short rule." });
    const uncut = buildPrompt(small).project;
    expect(uncut).toMatchObject({ name: "Docs", truncated: false });
    expect(uncut!.tokens).toBeGreaterThan(0);
    const big = input();
    applySessionProject(big.session, { name: null, instructions: "word ".repeat(3000) });
    const cut = buildPrompt(big).project!;
    expect(cut.truncated).toBe(true);
    expect(cut.name).toBeNull();
    expect(cut.tokens).toBeGreaterThan(PROJECT_SECTION_MAX_TOKENS);
    expect(buildPrompt(input()).project).toBeUndefined();
  });

  it("cloud: the full text as a project section", () => {
    const i = input("cloud");
    applySessionProject(i.session, { name: "Docs", instructions: "word ".repeat(3000) + "TAIL END" });
    const { text } = buildPrompt(i);
    expect(text).toContain("TAIL END");
    expect(text).toContain('the project "Docs"');
  });
});

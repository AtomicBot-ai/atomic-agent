import { describe, expect, it } from "vitest";

import {
  isExternalEngineEntry,
  JsonSchemaToolModes,
  MALFORMED_STRIKES,
} from "./json-schema-tool-mode.js";

const offeredNames = new Set(["os__fs__read", "reply"]);
const malformed = { content: '[TOOL_CALLS]os__fs__read{"path":"a"}', offeredNames };
const clean = {
  toolCalls: [{ function: { name: "os__fs__read", arguments: '{"path":"a"}' } }],
  content: "",
  offeredNames,
};
const answer = { content: "Done.", offeredNames };

describe("JsonSchemaToolModes", () => {
  it("starts every pair on native tools", () => {
    expect(new JsonSchemaToolModes().isOn("ollama", "m")).toBe(false);
  });

  it("switches a pair after consecutive malformed native replies, reporting the switch once", () => {
    const modes = new JsonSchemaToolModes();
    const verdicts: boolean[] = [];
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) {
      verdicts.push(modes.noteNativeReply("ollama", "m", malformed));
    }
    expect(verdicts.at(-1)).toBe(true);
    expect(verdicts.slice(0, -1).every((v) => !v)).toBe(true);
    expect(modes.isOn("ollama", "m")).toBe(true);
    expect(modes.noteNativeReply("ollama", "m", malformed)).toBe(false);
    // Other pairs are untouched.
    expect(modes.isOn("ollama", "other")).toBe(false);
    expect(modes.isOn("lmstudio", "m")).toBe(false);
  });

  it("resets the count on a clean native call, but not on a plain answer", () => {
    const modes = new JsonSchemaToolModes();
    modes.noteNativeReply("p", "m", malformed);
    modes.noteNativeReply("p", "m", clean);
    modes.noteNativeReply("p", "m", malformed);
    expect(modes.isOn("p", "m")).toBe(MALFORMED_STRIKES <= 1);

    const other = new JsonSchemaToolModes();
    other.noteNativeReply("p", "m", malformed);
    other.noteNativeReply("p", "m", answer);
    other.noteNativeReply("p", "m", malformed);
    expect(other.isOn("p", "m")).toBe(MALFORMED_STRIKES <= 2);
  });

  it("follows a probe verdict about tool calling and ignores the rest", () => {
    const modes = new JsonSchemaToolModes();
    modes.applyProbeVerdict("p", "m", "timeout");
    expect(modes.isOn("p", "m")).toBe(false);
    modes.applyProbeVerdict("p", "m", "malformed_tool_call");
    expect(modes.isOn("p", "m")).toBe(true);
    modes.applyProbeVerdict("p", "m", "tools_supported");
    expect(modes.isOn("p", "m")).toBe(false);
  });

  it("keeps a pair whose engine refused response_format on native tools for good", () => {
    const modes = new JsonSchemaToolModes();
    modes.applyProbeVerdict("p", "m", "malformed_tool_call");
    expect(modes.markRefused("p", "m")).toBe(true);
    expect(modes.markRefused("p", "m")).toBe(false);
    expect(modes.isOn("p", "m")).toBe(false);
    modes.applyProbeVerdict("p", "m", "malformed_tool_call");
    for (let i = 0; i < MALFORMED_STRIKES + 1; i += 1) {
      modes.noteNativeReply("p", "m", malformed);
    }
    expect(modes.isOn("p", "m")).toBe(false);
  });
});

describe("isExternalEngineEntry", () => {
  it("covers the Ollama and LM Studio presets and their default local ports", () => {
    expect(isExternalEngineEntry({ id: "ollama", baseUrl: "http://localhost:11434" })).toBe(true);
    expect(isExternalEngineEntry({ id: "lmstudio", baseUrl: "http://localhost:1234" })).toBe(true);
    expect(isExternalEngineEntry({ id: "ollama", baseUrl: "http://192.168.1.20:8080" })).toBe(true);
    expect(isExternalEngineEntry({ id: "box", baseUrl: "http://127.0.0.1:11434" })).toBe(true);
    expect(isExternalEngineEntry({ id: "box", baseUrl: "http://10.0.0.5:1234" })).toBe(true);
  });

  it("leaves hosted services and other local servers on native tools", () => {
    expect(isExternalEngineEntry({ id: "ollama-cloud", baseUrl: "https://ollama.com" })).toBe(false);
    expect(isExternalEngineEntry({ id: "ollama", baseUrl: "https://ollama.com" })).toBe(false);
    expect(isExternalEngineEntry({ id: "groq", baseUrl: "https://api.groq.com" })).toBe(false);
    expect(isExternalEngineEntry({ id: "llama", baseUrl: "http://localhost:8080" })).toBe(false);
    expect(isExternalEngineEntry({ id: "ollama" })).toBe(false);
  });
});

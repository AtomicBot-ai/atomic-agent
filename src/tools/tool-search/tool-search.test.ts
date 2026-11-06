import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import type { ToolContext } from "../tool-registry.js";
import { buildToolSearchTool } from "./tool-search.js";
import { argNames, callShape, queryWords, searchTools } from "./tool-search-rank.js";

const ctx: ToolContext = { workingDir: "/w", sessionId: "s", stepIndex: 0, signal: new AbortController().signal };

const slackPost: ToolDescriptor = {
  name: "mcp.slack.chat_post_message",
  summary: "[mcp:slack] Send a message to a Slack channel",
  argsSchema: "{ channel: string, text: string, thread_ts?: string }",
  tier: "frequent",
  argsJsonSchema: {
    type: "object",
    properties: { channel: { type: "string" }, text: { type: "string" }, thread_ts: { type: "string" } },
    required: ["channel", "text"],
  },
};
const notionSearch: ToolDescriptor = {
  name: "mcp.notion.search",
  summary: "[mcp:notion] Search pages and databases in the workspace",
  argsSchema: "{ query: string }",
  argsJsonSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const calendar: ToolDescriptor = {
  name: "mcp.gcal.create_event",
  summary: "[mcp:gcal] Create a calendar event",
  argsSchema: "{ title: string, start: string, end: string, attendees?: string[] }",
  argsJsonSchema: {
    type: "object",
    properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, attendees: { type: "array" } },
    required: ["title", "start", "end"],
  },
};
const catalog = [slackPost, notionSearch, calendar];

describe("searchTools", () => {
  it("drops stop words and splits on punctuation", () => {
    expect(queryWords("Send a message to the #general Slack channel")).toEqual(["send", "message", "general", "slack", "channel"]);
  });

  it("ranks by the words a tool covers across name, summary and args", () => {
    expect(searchTools("send a slack message", catalog, 3)[0]!.descriptor.name).toBe("mcp.slack.chat_post_message");
    expect(searchTools("schedule a meeting on my calendar", catalog, 3)[0]!.descriptor.name).toBe("mcp.gcal.create_event");
    expect(searchTools("notion pages", catalog, 3)[0]!.descriptor.name).toBe("mcp.notion.search");
    expect(searchTools("attendees", catalog, 3)[0]!.descriptor.name).toBe("mcp.gcal.create_event");
  });

  it("an exact tool name wins outright; a name prefix finds it", () => {
    expect(searchTools("mcp.notion.search", catalog, 1)[0]!.descriptor.name).toBe("mcp.notion.search");
    expect(searchTools("notio", catalog, 1)[0]?.descriptor.name).toBe("mcp.notion.search");
  });

  it("returns nothing for an empty or unrelated query", () => {
    expect(searchTools("   ", catalog, 3)).toEqual([]);
    expect(searchTools("kubernetes", catalog, 3)).toEqual([]);
  });

  it("finds built-in tools in the real catalog", () => {
    expect(searchTools("git commit", DEFAULT_TOOL_DESCRIPTORS, 3).map((h) => h.descriptor.name)).toContain("os.git.commit");
  });
});

describe("callShape / argNames", () => {
  it("fills required args with typed placeholders, or uses the first example", () => {
    expect(callShape(slackPost)).toBe('{"tool":"mcp.slack.chat_post_message","args":{"channel":"<channel>","text":"<text>"}}');
    expect(callShape({ ...notionSearch, examples: ['{"query":"roadmap"}'] })).toBe('{"tool":"mcp.notion.search","args":{"query":"roadmap"}}');
    expect(callShape({ name: "x.y", summary: "", argsSchema: "{ path: string, limit?: number }" })).toBe('{"tool":"x.y","args":{"path":"<path>"}}');
    expect(argNames(calendar)).toEqual(["title", "start", "end", "attendees"]);
    expect(argNames({ name: "x", summary: "", argsSchema: "{ path: string, limit?: number }" })).toEqual(["path", "limit"]);
  });
});

describe("tool.search", () => {
  const tool = buildToolSearchTool({
    catalog: () => ({ descriptors: [...catalog, { name: "reply", summary: "Final answer", argsSchema: "{ text: string }" }], deferred: new Set(["mcp.slack.chat_post_message", "mcp.notion.search"]) }),
  });

  it("answers with ranked hits, args, a ready call, and loads the deferred hits", async () => {
    const result = await tool.run({ query: "send slack message", limit: 2 }, ctx);
    expect(result.summary).toContain("1. mcp.slack.chat_post_message");
    expect(result.summary).toContain('call: {"tool":"mcp.slack.chat_post_message","args":{"channel":"<channel>","text":"<text>"}}');
    const loaded = result.details.toolsLoaded as Array<{ name: string; argsSchema: string; source: string }>;
    expect(loaded[0]).toMatchObject({ name: "mcp.slack.chat_post_message", argsSchema: slackPost.argsSchema, source: "explicit" });
    expect(result.details.results).toEqual(expect.arrayContaining(["mcp.slack.chat_post_message"]));
  });

  it("does not load a tool the prompt already describes in full", async () => {
    const result = await tool.run({ query: "calendar event" }, ctx);
    expect(result.summary).toContain("mcp.gcal.create_event (already described in ### tools)");
    expect(result.details.toolsLoaded).toEqual([]);
  });

  it("never offers the terminals, and says so when nothing matches", async () => {
    const result = await tool.run({ query: "final answer" }, ctx);
    expect(result.summary).toContain("No tool matches");
    expect(result.details.results).toEqual([]);
  });

  it("validates its arguments", async () => {
    await expect(tool.run({}, ctx)).rejects.toThrow("query");
    await expect(tool.run({ query: "x", limit: "3" }, ctx)).rejects.toThrow("limit");
  });
});

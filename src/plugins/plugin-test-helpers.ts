import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write a small Claude-format plugin into `root` for tests. Not shipped code: imported by tests only. */
export function writeClaudePlugin(root: string, opts: { name?: string; manifest?: Record<string, unknown>; mcp?: Record<string, unknown>; hooks?: boolean } = {}): string {
  const name = opts.name ?? "demo";
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  put(".claude-plugin/plugin.json", JSON.stringify({ name, version: "1.2.0", description: "Demo plugin", author: { name: "Someone" }, ...opts.manifest }));
  put("skills/review/SKILL.md", "---\nname: review\ndescription: Review code\n---\nReview body\n");
  put("skills/tidy/SKILL.md", "---\nname: tidy\ndescription: Tidy files\n---\nTidy body\n");
  put("skills/tidy/scripts/run.sh", "#!/bin/sh\necho hi\n");
  put("commands/commit.md", "---\ndescription: Make a commit\n---\nCommit with message: $ARGUMENTS\n");
  put("commands/git/push.md", "Push $ARGUMENTS\n");
  put("agents/reviewer.md", "---\nname: reviewer\ndescription: Strict reviewer\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.\n");
  if (opts.mcp) put(".mcp.json", JSON.stringify({ mcpServers: opts.mcp }));
  if (opts.hooks) put("hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh" }] }] } }));
  return root;
}

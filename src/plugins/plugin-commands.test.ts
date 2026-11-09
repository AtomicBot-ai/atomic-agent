import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listPluginCommands,
  parseCommandFile,
  renderCommandTemplate,
  renderPluginCommand,
  shortCommandAliases,
  splitCommandArgs,
} from "./plugin-commands.js";
import { installPluginFromDir, setPluginEnabled, setPluginPartEnabled } from "./plugin-install.js";
import { resetPluginCache } from "./plugin-runtime.js";
import { installedPluginDir, pluginDataDir } from "./plugin-store.js";
import { writeClaudePlugin } from "./plugin-test-helpers.js";

const vars = { root: "/plugins/demo", data: "/data/demo" };

describe("parseCommandFile", () => {
  it("reads description, argument-hint, allowed-tools and model", () => {
    const parsed = parseCommandFile("---\ndescription: Review a file\nargument-hint: <file> [focus]\nallowed-tools: Bash(git diff:*), Read\nmodel: haiku\n---\nReview $1\n");
    expect(parsed).toEqual({
      description: "Review a file",
      argumentHint: "<file> [focus]",
      allowedTools: ["Bash(git diff:*)", "Read"],
      model: "haiku",
      body: "Review $1\n",
    });
  });

  it("falls back to the first body line when there is no description", () => {
    expect(parseCommandFile("# Push the branch\n\nPush $ARGUMENTS\n").description).toBe("Push the branch");
  });

  it("keeps the body when the frontmatter is not valid YAML", () => {
    const parsed = parseCommandFile("---\ndescription: [unclosed\n---\nBody\n");
    expect(parsed.body).toBe("Body\n");
    expect(parsed.allowedTools).toEqual([]);
  });
});

describe("renderCommandTemplate", () => {
  it("substitutes $ARGUMENTS with the whole argument string", () => {
    expect(renderCommandTemplate("Commit with message: $ARGUMENTS\n", "  fix the bug  ", vars)).toBe("Commit with message: fix the bug");
  });

  it("fills $1..$9 from whitespace-split arguments, honouring quotes", () => {
    expect(splitCommandArgs(`123 "high priority" 'a b' c`)).toEqual(["123", "high priority", "a b", "c"]);
    expect(renderCommandTemplate("Fix #$1 with $2, then [$3]", `123 "high priority"`, vars)).toBe("Fix #123 with high priority, then []");
  });

  it("supports 0-based $ARGUMENTS[N] and leaves $10 alone", () => {
    expect(renderCommandTemplate("first=$ARGUMENTS[0] second=$ARGUMENTS[1] ten=$10", "a b", vars)).toBe("first=a second=b ten=$10");
  });

  it("expands the plugin root and data folders", () => {
    expect(renderCommandTemplate("Run ${CLAUDE_PLUGIN_ROOT}/x and keep ${CLAUDE_PLUGIN_DATA}", "", vars)).toBe("Run /plugins/demo/x and keep /data/demo");
  });

  it("never substitutes inside text that came from the arguments", () => {
    expect(renderCommandTemplate("Say $ARGUMENTS", "$1 ${CLAUDE_PLUGIN_ROOT}", vars)).toBe("Say $1 ${CLAUDE_PLUGIN_ROOT}");
  });

  it("appends the arguments when the template has no placeholder", () => {
    expect(renderCommandTemplate("Review the staged diff.\n", "focus on tests", vars)).toBe("Review the staged diff.\n\nARGUMENTS: focus on tests");
    expect(renderCommandTemplate("Review the staged diff.\n", "", vars)).toBe("Review the staged diff.");
  });

  it("leaves shell lines and file includes as plain text", () => {
    const body = "Status: !`git status`\nSee @src/index.ts\n$ARGUMENTS";
    expect(renderCommandTemplate(body, "go", vars)).toBe("Status: !`git status`\nSee @src/index.ts\ngo");
  });
});

describe("shortCommandAliases", () => {
  it("gives the bare name only when it is unique and free", () => {
    const aliases = shortCommandAliases([
      { name: "a:review", command: "review" },
      { name: "b:review", command: "review" },
      { name: "a:commit", command: "commit" },
      { name: "a:help", command: "help" },
    ], alias => alias === "help");
    expect([...aliases]).toEqual([["a:commit", "commit"]]);
  });
});

describe("plugin commands from installed plugins", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-plugin-commands-"));
    stateDir = join(base, "state");
    resetPluginCache();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists enabled commands with plugin-prefixed names", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src")));
    const { commands, diagnostics } = listPluginCommands(stateDir);
    expect(diagnostics).toEqual([]);
    expect(commands.map(c => [c.name, c.command, c.description])).toEqual([
      ["demo:commit", "commit", "Make a commit"],
      ["demo:git:push", "git:push", "Push $ARGUMENTS"],
    ]);
  });

  it("notes an ignored model and drops commands switched off", () => {
    const src = writeClaudePlugin(join(base, "src"));
    writeFileSync(join(src, "commands/fast.md"), "---\ndescription: Fast\nmodel: haiku\n---\nGo\n");
    installPluginFromDir(stateDir, src);
    expect(listPluginCommands(stateDir).commands.find(c => c.name === "demo:fast")?.notes[0]).toContain("haiku");
    setPluginPartEnabled(stateDir, "demo", "command:commit", false);
    resetPluginCache();
    expect(listPluginCommands(stateDir).commands.map(c => c.name)).not.toContain("demo:commit");
    expect(() => renderPluginCommand(stateDir, "demo:commit", "x")).toThrow(/turned off/);
  });

  it("renders a command with its arguments and plugin folders", () => {
    const src = writeClaudePlugin(join(base, "src"));
    mkdirSync(join(src, "commands"), { recursive: true });
    writeFileSync(join(src, "commands/where.md"), "Root ${CLAUDE_PLUGIN_ROOT} data ${CLAUDE_PLUGIN_DATA} arg $1\n");
    installPluginFromDir(stateDir, src);
    expect(renderPluginCommand(stateDir, "demo:commit", "fix typo")).toBe("Commit with message: fix typo");
    expect(renderPluginCommand(stateDir, "DEMO:GIT:PUSH", "origin main")).toBe("Push origin main");
    expect(renderPluginCommand(stateDir, "demo:where", "x")).toBe(
      `Root ${installedPluginDir(stateDir, "demo")} data ${pluginDataDir(stateDir, "demo")} arg x`,
    );
  });

  it("refuses unknown commands and commands of a disabled plugin", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src")));
    expect(() => renderPluginCommand(stateDir, "demo:nope", "")).toThrow(/not available/);
    setPluginEnabled(stateDir, "demo", false);
    resetPluginCache();
    expect(listPluginCommands(stateDir).commands).toEqual([]);
    expect(() => renderPluginCommand(stateDir, "demo:commit", "")).toThrow(/not available/);
  });
});

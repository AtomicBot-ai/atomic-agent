import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  MCP_SERVER_HELP,
  McpServerUsageError,
  parseMcpServerArgs,
} from "./mcp-server-args.js";

describe("parseMcpServerArgs (ATO-549)", () => {
  it("is read-only with no flags", () => {
    expect(parseMcpServerArgs([], "/work")).toEqual({
      workingDir: "/work",
      allowWrite: false,
      allowExec: false,
      tools: [],
    });
  });

  it("reads the opt-in flags, repeated --tool and --cwd", () => {
    expect(
      parseMcpServerArgs(
        ["--allow-write", "--allow-exec", "--tool", "skills_list", "--tool", "memory.notes.recall", "--cwd", "proj"],
        "/work",
      ),
    ).toEqual({
      workingDir: join("/work", "proj"),
      allowWrite: true,
      allowExec: true,
      tools: ["skills_list", "memory.notes.recall"],
    });
  });

  it("returns null for help", () => {
    expect(parseMcpServerArgs(["--help"])).toBeNull();
    expect(parseMcpServerArgs(["-h"])).toBeNull();
  });

  it("refuses an unknown flag and a flag without its value", () => {
    expect(() => parseMcpServerArgs(["--yolo"])).toThrow(McpServerUsageError);
    expect(() => parseMcpServerArgs(["--tool"])).toThrow(/--tool needs a value/);
    expect(() => parseMcpServerArgs(["--cwd", "--allow-write"])).toThrow(/--cwd needs a value/);
  });

  it("help names the read-only default and the approval caveat", () => {
    expect(MCP_SERVER_HELP).toContain("--allow-write");
    expect(MCP_SERVER_HELP).toContain("--allow-exec");
    expect(MCP_SERVER_HELP).toContain("read-only");
    expect(MCP_SERVER_HELP).toContain("refused");
  });
});

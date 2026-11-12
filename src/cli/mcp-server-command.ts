/**
 * `atomic-agent mcp-server` (ATO-549): the agent as an MCP server over
 * stdio, so Claude Code, Codex, Cursor and other MCP clients can search
 * its memory and read its skills.
 *
 * No runtime boot and no model: the command opens the memory database
 * and the skill folders, serves the selected tools and exits when the
 * client closes stdin. stdout carries the protocol only; anything else
 * goes to stderr.
 */

import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "../config/index.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import { ApprovalRulesStore } from "../approval/approval-rules-store.js";
import { MemoryStore } from "../memory/memory-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import { LessonStore } from "../memory/lessons/lesson-store.js";
import { ProcedureStore } from "../memory/procedures/procedure-store.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { listEnabledPluginSkills } from "../plugins/plugin-runtime.js";
import { createProjectSkillTrustGate } from "../skills/project-trust.js";
import { ShellJobRegistry } from "../tools/os/index.js";
import { getAppVersion } from "../version.js";
import {
  MCP_SERVER_HELP,
  McpServerUsageError,
  parseMcpServerArgs,
  type McpServerArgs,
} from "./mcp-server-args.js";
import { buildMcpServeTools, toWireName } from "./mcp-server-tools.js";
import {
  createMcpServeServer,
  MCP_SERVE_REFUSAL,
  MCP_SERVE_SESSION_ID,
} from "./mcp-server-bridge.js";

export async function mcpServerCommand(args: string[]): Promise<number> {
  let parsed: McpServerArgs | null;
  try {
    parsed = parseMcpServerArgs(args);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${MCP_SERVER_HELP}`);
    return 2;
  }
  if (parsed === null) {
    process.stdout.write(MCP_SERVER_HELP);
    return 0;
  }

  const config = getConfig();
  const warn = (message: string): void => {
    process.stderr.write(`atomic-agent mcp-server: ${message}\n`);
  };
  const closers: Array<() => void> = [];
  try {
    const mem = config.memory;
    const notesStore = mem.notes.enabled
      ? remember(closers, new MemoryStore({ dbFile: config.paths.memoryDbFile, maxEntries: mem.notes.maxEntries }))
      : undefined;
    const profileStore = mem.profile.enabled
      ? remember(closers, new ProfileStore({ dbFile: config.paths.memoryDbFile, maxEntries: mem.profile.maxEntries }))
      : undefined;
    const lessonStore = mem.lessons.enabled
      ? remember(closers, new LessonStore({ dbFile: config.paths.memoryDbFile, maxEntries: mem.lessons.maxEntries }))
      : undefined;
    const procedureStore = mem.procedures.enabled
      ? remember(closers, new ProcedureStore({ dbFile: config.paths.memoryDbFile, maxEntries: mem.procedures.maxEntries }))
      : undefined;

    // Same sources and trust gate as the runtime. Nothing here can ask,
    // so an untrusted project folder's skills stay out.
    const workingDir = parsed.workingDir;
    const skillRegistry = new SkillRegistry(
      {
        globalDir: config.paths.globalSkillsDir,
        projectDir: join(workingDir, config.paths.projectSkillsDirName),
        pluginSkills: () => listEnabledPluginSkills(config.paths.stateDir),
      },
      config.skills.disabled,
      createProjectSkillTrustGate(config.paths.userConfigFile, config.skills.projectTrust, workingDir),
    );
    await skillRegistry.refresh();

    // The gate keeps the user's level and saved rules; anything that
    // would still prompt is refused, since nobody can answer it.
    const approvals = new ApprovalGate({
      emit: () => undefined,
      level: config.agent.approvalLevel,
    });
    approvals.setRules(
      new ApprovalRulesStore({ stateDir: config.paths.stateDir, warn: (m) => warn(m) }),
    );
    approvals.setSessionPolicy(MCP_SERVE_SESSION_ID, {
      onPrompt: "refuse",
      reason: MCP_SERVE_REFUSAL,
    });
    const jobs = new ShellJobRegistry({
      jobMaxMs: config.tools.shell.jobMaxMs,
      maxJobs: config.tools.shell.maxJobs,
    });
    closers.push(() => void jobs.endAll());

    const toolSet = buildMcpServeTools(parsed, {
      ...(notesStore ? { notesStore } : {}),
      ...(profileStore ? { profileStore } : {}),
      ...(lessonStore ? { lessonStore } : {}),
      ...(procedureStore ? { procedureStore } : {}),
      notesRecallDefaultK: mem.notes.recallDefaultK,
      notesMaxContentChars: mem.notes.maxContentChars,
      skillRegistry,
      approvals,
      shell: {
        defaultTimeoutMs: config.tools.shell.defaultTimeoutMs,
        envPassthrough: config.tools.shell.envPassthrough,
        jobs,
      },
    });
    warn(`serving ${toolSet.tools.map((t) => t.wireName).join(", ")} (cwd ${workingDir})`);
    if (parsed.allowExec) {
      warn(
        `${toWireName("os.shell.run")} is on: commands your approval level or saved rules allow will run without asking`,
      );
    }

    const server = createMcpServeServer({ toolSet, workingDir, version: getAppVersion() });
    const transport = new StdioServerTransport();
    const closed = new Promise<void>((resolve) => {
      transport.onclose = () => resolve();
      // The SDK's stdio transport does not watch for end of input; a
      // client that goes away closes our stdin.
      process.stdin.once("end", () => void server.close());
      process.once("SIGINT", () => void server.close());
      process.once("SIGTERM", () => void server.close());
    });
    await server.connect(transport);
    await closed;
    return 0;
  } catch (err) {
    if (err instanceof McpServerUsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    warn(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    for (const close of closers.reverse()) {
      try {
        close();
      } catch {
        // best effort on the way out
      }
    }
  }
}

function remember<T extends { close(): void }>(closers: Array<() => void>, store: T): T {
  closers.push(() => store.close());
  return store;
}

import { createReadStream } from "node:fs";
import { resolve } from "node:path";

import { getConfig } from "../config/index.js";
import { buildCapabilities } from "../prompt/capabilities.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { buildSkillCatalog } from "../skills/skill-catalog.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/index.js";
import { replaySession } from "../replay/index.js";
import { traceFilePath } from "../telemetry/index.js";
import { join as joinPath } from "node:path";

import {
  listTraceSummaries,
  readTraceFile,
  type TraceSummary,
} from "./trace-file-io.js";
import { formatTraceChronology } from "./trace-formatter.js";

const HELP =
  [
    "atomic-agent trace — inspect append-only session traces",
    "",
    "Traces live at <stateDir>/traces/<sessionId>.ndjson and are written by",
    "default when running via `atomic-agent run`, `atomic-agent tui`, or",
    "`atomic-agent serve`. Sidecar mode is off unless configured.",
    "",
    "Subcommands:",
    "  list [--limit N]          Summarise the most recent trace files",
    "  show <sessionId>          Pretty-print the session chronology",
    "       [--step N] [--raw]",
    "  export <sessionId>        Dump raw trace as NDJSON (default) or JSON",
    "       [--format ndjson|json]",
    "  replay <sessionId>        Compare recorded stable-prefix hashes to",
    "                            the ones produced by the current runtime.",
    "                            Drift means tools/capabilities/skills changed.",
    "",
    "Examples:",
    "  atomic-agent trace list --limit 20",
    "  atomic-agent trace show s-1234 --step 2 --raw",
    "  atomic-agent trace export s-1234 --format json > session.json",
  ].join("\n") + "\n";

export async function traceCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "list":
        return await handleList(args.slice(1));
      case "show":
        return await handleShow(args.slice(1));
      case "export":
        return await handleExport(args.slice(1));
      case "replay":
        return await handleReplay(args.slice(1));
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`trace ${sub} failed: ${message}\n`);
    return 1;
  }
}

async function handleList(args: string[]): Promise<number> {
  const limitArg = readOptionValue(args, "--limit");
  const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;
  const dir = getConfig().paths.tracesDir;
  const summaries = await listTraceSummaries(
    dir,
    typeof limit === "number" && Number.isFinite(limit) ? { limit } : {},
  );
  process.stdout.write(formatSummaries(dir, summaries));
  return 0;
}

async function handleShow(args: string[]): Promise<number> {
  const sessionId = args[0];
  if (!sessionId || sessionId.startsWith("-")) {
    process.stderr.write("usage: atomic-agent trace show <sessionId> [--step N] [--raw]\n");
    return 1;
  }
  const dir = getConfig().paths.tracesDir;
  const path = traceFilePath(dir, sessionId);
  const events = await readTraceFile(path);
  if (events.length === 0) {
    process.stderr.write(`no trace events found for session ${sessionId} at ${path}\n`);
    return 1;
  }
  const stepStr = readOptionValue(args, "--step");
  const step = stepStr ? Number.parseInt(stepStr, 10) : undefined;
  const raw = args.includes("--raw");
  const output = formatTraceChronology(
    events,
    typeof step === "number" && Number.isFinite(step)
      ? { step, raw }
      : { raw },
  );
  process.stdout.write(`${output}\n`);
  return 0;
}

async function handleReplay(args: string[]): Promise<number> {
  const sessionId = args[0];
  if (!sessionId || sessionId.startsWith("-")) {
    process.stderr.write(
      "usage: atomic-agent trace replay <sessionId>\n",
    );
    return 1;
  }
  const config = getConfig();
  const dir = config.paths.tracesDir;
  const path = traceFilePath(dir, sessionId);
  const stepStr = readOptionValue(args, "--step");
  const targetStep = stepStr ? Number.parseInt(stepStr, 10) : undefined;

  const firstEvents = await readTraceFile(path);
  if (firstEvents.length === 0) {
    process.stderr.write(`no trace events found for session ${sessionId} at ${path}\n`);
    return 1;
  }
  const sessionStarted = firstEvents.find((e) => e.type === "session_started");
  const workingDir = sessionStarted?.type === "session_started"
    ? sessionStarted.workingDir
    : process.cwd();

  const skillRegistry = new SkillRegistry({
    globalDir: config.paths.globalSkillsDir,
    projectDir: joinPath(workingDir, config.paths.projectSkillsDirName),
  });
  await skillRegistry.refresh();
  const skillCatalog = buildSkillCatalog(skillRegistry.list());
  const capabilities = await buildCapabilities({
    workingDir,
    browserChannel: config.browser.channel,
  });

  const report = await replaySession({
    path,
    context: {
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities,
      skillCatalog,
      profile: PLAIN_INSTRUCT_PROFILE,
    },
  });

  const filtered = typeof targetStep === "number" && Number.isFinite(targetStep)
    ? report.steps.filter((s) => s.stepIndex === targetStep)
    : report.steps;

  const lines: string[] = [
    `session: ${report.sessionId}`,
    `working_dir: ${report.workingDir ?? "unknown"}`,
    `steps_checked: ${filtered.length}`,
    `drift_detected: ${filtered.filter((s) => s.drift).length}`,
    "",
  ];
  if (filtered.length === 0) {
    lines.push("no prompt_captured events matched the filter");
  } else {
    lines.push("  turn  step  drift  recordedHash  currentHash");
    for (const entry of filtered) {
      lines.push(
        [
          `  ${String(entry.turnIndex).padStart(4)}`,
          String(entry.stepIndex).padStart(4),
          entry.drift ? "DRIFT" : "ok   ",
          entry.recordedHash.slice(0, 16),
          entry.currentHash.slice(0, 16),
        ].join("  "),
      );
    }
    if (filtered.some((s) => s.drift)) {
      lines.push("");
      lines.push("Drift means the stable prefix was rebuilt differently —");
      lines.push("usually a persona/tool/capability/skill change since recording.");
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return filtered.some((s) => s.drift) ? 2 : 0;
}

async function handleExport(args: string[]): Promise<number> {
  const sessionId = args[0];
  if (!sessionId || sessionId.startsWith("-")) {
    process.stderr.write(
      "usage: atomic-agent trace export <sessionId> [--format ndjson|json]\n",
    );
    return 1;
  }
  const format = readOptionValue(args, "--format") ?? "ndjson";
  if (format !== "ndjson" && format !== "json") {
    process.stderr.write(`unknown format: ${format} (expected ndjson|json)\n`);
    return 1;
  }
  const dir = getConfig().paths.tracesDir;
  const path = traceFilePath(dir, sessionId);
  if (format === "ndjson") {
    await pipeFileToStdout(path);
    return 0;
  }
  const events = await readTraceFile(path);
  process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
  return 0;
}

function pipeFileToStdout(path: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path, { encoding: "utf8" });
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise());
    stream.pipe(process.stdout, { end: false });
  });
}

function formatSummaries(dir: string, summaries: TraceSummary[]): string {
  if (summaries.length === 0) {
    return `no trace files found in ${resolve(dir)}\n`;
  }
  const lines: string[] = [`dir: ${resolve(dir)}`, ""];
  for (const entry of summaries) {
    lines.push(
      [
        entry.sessionId,
        entry.modifiedAt.toISOString(),
        `${entry.sizeBytes}B`,
        entry.workingDir ?? "unknown-cwd",
      ].join("  "),
    );
  }
  return `${lines.join("\n")}\n`;
}

function readOptionValue(args: string[], flag: string): string | undefined {
  const idx = args.findIndex((arg) => arg === flag);
  if (idx < 0) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) return undefined;
  return next;
}

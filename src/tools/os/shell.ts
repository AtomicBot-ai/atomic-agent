import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  awaitJobExit,
  startCommandJob,
} from "../../sandbox/command-job.js";
import {
  buildSubshellInvocation,
  quoteCmdArg,
} from "../../sandbox/shell-invocation.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import { resolveUserPath } from "./expand-home.js";
import { expandShellGlobArgs } from "./expand-shell-glob-args.js";
import { nodeCheckMultiFileNotice } from "./node-check-notice.js";
import {
  basenameCommand,
  checkShellCommandGuard,
  isGogCommand,
  type ShellGuardPolicy,
} from "./shell-command-guard/index.js";
import {
  coerceShellArgs,
  describeArgsShape,
  isOpaqueInterpreterShape,
  needsShellInterpretation,
} from "./shell-interpretation.js";
import {
  classifyShellCall,
  listShellJobs,
  renderShellDetached,
  runShellKill,
  runShellWait,
} from "./shell-job-calls.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import {
  GOG_MAX_OUTPUT_BYTES,
  renderShellExit,
  renderShellTimedOut,
  type ShellCommandFacts,
} from "./shell-result.js";
import {
  describeShellTimeoutDefault,
  resolveShellTimeout,
} from "./shell-timeout.js";

export {
  isOpaqueInterpreterShape,
  needsShellInterpretation,
} from "./shell-interpretation.js";

export interface OsShellToolOptions extends DangerousToolOptions {
  /**
   * Operator policy for the pre-exec guard (the git remote-sync switch).
   * Injected by the bootstrap as live predicates; omitted by embedders
   * and tests, which then get the static rule set.
   */
  shellPolicy?: ShellGuardPolicy;
  /**
   * `tools.shell.defaultTimeoutMs`: after this long a call whose
   * `timeoutMs` the model omitted is detached as a job; `0` = never.
   * Omitted by embedders and tests, which then get the unbounded
   * pre-v67 behaviour.
   */
  defaultTimeoutMs?: number;
  /**
   * Where detached jobs live, shared with the bootstrap's turn-end and
   * session-end hooks. Omitted (embedders, tests) ⇒ a private registry
   * whose jobs die only at the ceiling.
   */
  jobs?: ShellJobRegistry;
}

export function buildOsShellTool(options: OsShellToolOptions): ToolDefinition {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
  const jobs = options.jobs ?? new ShellJobRegistry();
  return {
    name: "os.shell.run",
    description:
      "Run an OS command in the session working directory. Prefer the structured form `{cmd, args:[...]}` (argv globs `*`/`?` are expanded). Shell metacharacters (`|`, `&&`, `;`, `>`, `<`, `$`, backticks) are interpreted via the OS subshell (`sh -c` on macOS/Linux, `cmd.exe /c` on Windows) — a full command line passed as `cmd` (e.g. `\"ffprobe -v quiet … f.mp3\"` or `\"pip3 list | grep foo\"`) runs as written. Do not use for deleting user files — use `os.fs.trash` unless the user explicitly requests permanent shell deletion. Runs through a pre-exec guard: safe commands run directly, risky commands require approval, catastrophic commands are blocked without execution. " +
      describeShellTimeoutDefault(defaultTimeoutMs),
    readonly: false,
    async run(rawArgs, ctx) {
      // The job forms act on what this session already started; they
      // need no guard and no approval of their own.
      const form = classifyShellCall(rawArgs);
      const jobCtx = {
        jobs,
        sessionId: ctx.sessionId,
        defaultTimeoutMs,
        signal: ctx.signal,
      };
      if (form.kind === "invalid") {
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output: form.message,
          details: { invalidCall: true },
        });
      }
      if (form.kind === "jobs") return listShellJobs(jobCtx);
      if (form.kind === "wait") {
        return runShellWait(jobCtx, form.id, rawArgs.timeoutMs, rawArgs.keep === true);
      }
      if (form.kind === "kill") return runShellKill(jobCtx, form.id);

      const cmd = rawArgs.cmd;
      if (typeof cmd !== "string" || cmd.length === 0) {
        throw new Error("os.shell.run: `cmd` must be a non-empty string");
      }
      const rawArgList = coerceShellArgs(rawArgs.args);
      if (rawArgList === null) {
        // Some models (notably cloud `native_tools` providers under
        // tool_choice="auto") double-serialise array arguments into a
        // JSON string. Treating that as "no args" silently dropped the
        // operator's intent; surfacing a structured error gives the
        // model a chance to retry with the right shape instead.
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output:
            "os.shell.run: `args` must be an array of strings (got " +
            describeArgsShape(rawArgs.args) +
            "). Pass arguments as JSON array literal, e.g. {\"cmd\":\"ls\",\"args\":[\"-la\",\"./src\"]}.",
          details: {
            cmd,
            rawArgsType: describeArgsShape(rawArgs.args),
          },
        });
      }
      const cwd =
        typeof rawArgs.cwd === "string" && rawArgs.cwd.length > 0
          ? resolveUserPath(rawArgs.cwd, ctx.workingDir)
          : ctx.workingDir;
      // An explicit `timeoutMs` wins (`0` = none — long installs like
      // `brew install` need it) and kills at its limit: the model asked
      // for a bound. The operator's default (F47: a scan of a home
      // directory used to run until someone killed it) detaches
      // instead — a build the default interrupted is not one the model
      // wanted stopped. The turn's abort signal stays the safety valve.
      const timeout = resolveShellTimeout(rawArgs.timeoutMs, defaultTimeoutMs);

      // Two execution modes. Direct-exec (`spawn(cmd, args)`) keeps argv
      // semantics and shell-glob expansion. Subshell (`sh -c <line>`) is
      // used when the model emits shell metacharacters or a pre-joined
      // command line in `cmd` (the common ENOENT trap). In subshell mode
      // the guard inspects a tokenised view of the full command line so
      // hardline/dangerous rules still match the real binaries.
      const useShell = needsShellInterpretation(cmd, rawArgList);
      const execArgs = useShell
        ? rawArgList
        : expandShellGlobArgs(cmd, rawArgList, cwd);
      const commandLine = [cmd, ...execArgs].join(" ");
      const guardTokens = useShell
        ? commandLine.split(/\s+/).filter((t) => t.length > 0)
        : null;
      const guardInput =
        useShell && guardTokens && guardTokens.length > 0
          ? { cmd: guardTokens[0]!, rawArgs: guardTokens.slice(1), cwd }
          : { cmd, rawArgs: execArgs, cwd };
      const gogProbe = guardInput.cmd;

      const guardVerdict = checkShellCommandGuard(
        guardInput,
        options.shellPolicy,
      );
      if (guardVerdict.action === "block") {
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output: `blocked by shell guard: ${guardVerdict.rule} - ${guardVerdict.reason}`,
          details: {
            cmd,
            rawArgs: rawArgList,
            cwd,
            shell: useShell,
            guardVerdict: guardVerdict.action,
            guardRule: guardVerdict.rule,
            guardReason: guardVerdict.reason,
          },
        });
      }

      // A fan-out the operator authorised may also run commands, but
      // only in the directory they saw: `cwd` inside the scope, and the
      // guard's own hardline blocks still fire above this (a `block`
      // verdict never reaches here). The command line itself is free
      // text and cannot be scoped, so the directory is the whole of the
      // promise — which is why the fan-out prompt says "and run commands
      // in" rather than something broader.
      const scopedByFanout =
        options.approvals.fanoutScopes?.allows(ctx.sessionId, [cwd]) ?? false;
      if (guardVerdict.action === "approval_required" && !scopedByFanout) {
        // Shape grant unit: the normalised binary the guard itself keyed
        // on (basename, lowercased), so `[a]` covers exactly the argv[0]
        // that would run: `git`, not `/usr/bin/GIT` or a path. Withheld
        // for opaque interpreters (`bash -c …`) where the binary name
        // hides what runs — see `isOpaqueInterpreterShape`.
        const shape = basenameCommand(guardInput.cmd).toLowerCase();
        const commandShape = isOpaqueInterpreterShape(shape)
          ? undefined
          : shape;
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "os.shell.run",
            category: "shell",
            reason: `${guardVerdict.reason} in ${cwd}`,
            preview: commandLine,
            affectedResources: [cwd],
            ...(commandShape !== undefined ? { commandShape } : {}),
          },
          ctx.signal,
        );
      }

      // For the subshell path we hand a single command line to the OS
      // shell (`sh -c` / `cmd.exe /c`). When the model supplied separate
      // argv tokens alongside a shell-bearing `cmd`, quote them on Windows
      // so paths with spaces survive `cmd.exe` parsing. POSIX keeps the
      // legacy raw join for byte-identical behaviour.
      const subshellCommandLine =
        execArgs.length > 0 && process.platform === "win32"
          ? [cmd, ...execArgs.map(quoteCmdArg)].join(" ")
          : commandLine;
      const spawnSpec = useShell
        ? buildSubshellInvocation(subshellCommandLine)
        : { command: cmd, args: execArgs };
      const facts: ShellCommandFacts = {
        cmd,
        args: execArgs,
        rawArgs: rawArgList,
        cwd,
        shell: useShell,
        commandLine,
        // A bare interpreter — `python3` with nothing after it — exits 0
        // having done nothing, and nothing in its output says so (F40).
        // The subshell path is excluded: there the arguments live inside
        // `cmd` itself.
        noArguments: !useShell && execArgs.length === 0,
        gog: isGogCommand(gogProbe),
        guard: guardVerdict,
      };
      // Its own process group, so a stop reaches what the command
      // started too (`sleep 30 &` behind a subshell used to outlive the
      // shell and hold the result until it ended).
      const job = startCommandJob(spawnSpec.command, spawnSpec.args, {
        cwd,
        ...(facts.gog ? { maxOutputBytes: GOG_MAX_OUTPUT_BYTES } : {}),
      });
      // A spawn failure (ENOENT) rejects here, as the runner's always did.
      const outcome = await job.waitFor(timeout.timeoutMs, ctx.signal);
      // `node --check a b c` exits 0 having read only `a`. Said first,
      // because nothing in node's own output says it — and a reply built
      // on that exit code claims a check that never ran.
      const checkNotice = nodeCheckMultiFileNotice(commandLine, cwd);
      const notices = checkNotice === null ? [] : [checkNotice];
      if (outcome === "elapsed" && timeout.source === "default") {
        const { record, evicted } = jobs.register(
          ctx.sessionId,
          job,
          facts,
          rawArgs.keep === true,
        );
        return renderShellDetached(record, {
          waitedMs: timeout.timeoutMs,
          again: false,
          defaultTimeoutMs,
          evicted,
          maxJobs: jobs.maxJobs,
          notices,
        });
      }
      if (outcome === "elapsed") job.stop();
      else if (outcome === "aborted") job.kill();
      const exit = await awaitJobExit(job);
      const output = job.output();
      if (outcome === "elapsed") {
        return renderShellTimedOut(facts, exit, output, timeout, notices);
      }
      return renderShellExit(facts, exit, output, { notices });
    },
  };
}

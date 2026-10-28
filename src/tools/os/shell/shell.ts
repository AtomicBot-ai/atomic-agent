import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import {
  awaitJobExit,
  startCommandJob,
} from "../../../sandbox/command-job.js";
import { buildCommandEnv } from "../../../sandbox/command-env.js";
import { withToolchainEnv } from "../../../sandbox/command-toolchain-env.js";
import { quoteCmdArg } from "../../../sandbox/shell-invocation.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import { resolveUserPath } from "../expand-home.js";
import { expandShellGlobArgs } from "./expand-shell-glob-args.js";
import { nodeCheckMultiFileNotice } from "./node-check-notice.js";
import {
  checkBrowserBypassArgv,
  checkBrowserBypassLine,
  checkShellCommandGuard,
  execWriteTargets,
  isGogCommand,
  shellWriteTargets,
  type ShellGuardPolicy,
} from "../shell-command-guard/index.js";
import {
  coerceShellArgs,
  describeArgsShape,
  formatShellPreview,
  needsShellInterpretation,
  resolveShellSpawn,
  shellGrantShape,
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
  markRecoveredResult,
  missingCmdMessage,
  recoverMissingShellCmd,
  type RecoveredShellCmd,
} from "./recover-missing-cmd.js";
import {
  GOG_MAX_OUTPUT_BYTES,
  renderShellExit,
  renderShellTimedOut,
  type ShellCommandFacts,
} from "./shell-result.js";
import {
  describeShellTimeoutDefault,
  formatShellBackgroundNotice,
  resolveShellTimeout,
} from "./shell-timeout.js";
import {
  detectInteractivePrompt,
  formatInteractiveHandoff,
} from "./interactive-prompt.js";
import { waitWatchingForPrompt } from "./wait-watching-for-prompt.js";

export {
  isOpaqueInterpreterShape,
  needsShellInterpretation,
  shellGrantShape,
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
  /**
   * `tools.shell.envPassthrough`: names copied into the command's
   * environment even though they look like a secret. Everything else
   * secret-looking is stripped (`buildCommandEnv`, ATO-347). Omitted ⇒
   * none, so embedders and tests get the filtered environment too.
   */
  envPassthrough?: readonly string[];
  /** Test seam: the prompt watch's poll and quiet intervals. */
  promptWatch?: { pollMs?: number; quietMs?: number };
  /** Test seam: how long a `background: true` command is watched. */
  backgroundSettleMs?: number;
}

/**
 * How long a `background: true` command is watched before it is handed
 * back as a job: long enough for a dev server to print its URL or fail
 * on a busy port, short enough not to hold the step.
 */
export const SHELL_BACKGROUND_SETTLE_MS = 3_000;

export function buildOsShellTool(options: OsShellToolOptions): ToolDefinition {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
  const jobs = options.jobs ?? new ShellJobRegistry();
  const backgroundSettleMs =
    options.backgroundSettleMs ?? SHELL_BACKGROUND_SETTLE_MS;
  /**
   * The command form: guard, approval, run. `recovered` is set when the
   * call's `cmd` was read back from its `args` (#901).
   */
  async function runCommand(
    rawArgs: Record<string, unknown>,
    ctx: ToolContext,
    recovered: RecoveredShellCmd | null,
  ): Promise<CompressedToolResult> {
    const cmd = rawArgs.cmd;
    if (typeof cmd !== "string" || cmd.trim().length === 0) {
      throw new Error(missingCmdMessage(rawArgs));
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

    // Driving a web browser from the shell (AppleScript, `open -a
    // Chrome <url>`, DevTools) skips the browser tool's own asks, at any
    // approval level (ATO-1260). Read from the real line or argv: the
    // guard's whitespace split loses quotes and heredocs.
    const guardVerdict =
      (useShell
        ? checkBrowserBypassLine(commandLine, cwd)
        : checkBrowserBypassArgv(cmd, execArgs, cwd)) ??
      checkShellCommandGuard(guardInput, options.shellPolicy);
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

    // For the subshell path we hand a single command line to the OS
    // shell (`sh -c` / `cmd.exe /c`). When the model supplied separate
    // argv tokens alongside a shell-bearing `cmd`, quote them on Windows
    // so paths with spaces survive `cmd.exe` parsing. POSIX keeps the
    // legacy raw join for byte-identical behaviour.
    const subshellCommandLine =
      execArgs.length > 0 && process.platform === "win32"
        ? [cmd, ...execArgs.map(quoteCmdArg)].join(" ")
        : commandLine;
    // The files the command would write, move or remove: after the
    // user declined a write of one of them this turn, this is the same
    // write by another route, and the gate refuses it unasked. Read
    // from the line the shell will run, or from the argv a direct exec
    // passes as it is — there a `>` in an argument is only text.
    const targetPaths = useShell
      ? shellWriteTargets(subshellCommandLine, cwd)
      : execWriteTargets(cmd, execArgs, cwd);

    // A fan-out the operator authorised may also run commands, but
    // only in the directory they saw: `cwd` inside the scope, and the
    // guard's own hardline blocks still fire above this (a `block`
    // verdict never reaches here). The command line itself is free
    // text and cannot be scoped, so the directory is the whole of the
    // promise — which is why the fan-out prompt says "and run commands
    // in" rather than something broader. One exception: a command
    // that would change a file the user declined this turn goes to the
    // gate, which refuses it, rather than running on the fan-out's yes.
    const scopedByFanout =
      (options.approvals.fanoutScopes?.allows(ctx.sessionId, [cwd]) ??
        false) &&
      !(
        options.approvals.hasDeclinedTarget?.({
          sessionId: ctx.sessionId,
          tool: "os.shell.run",
          category: "shell",
          targetPaths,
        }) ?? false
      );
    if (guardVerdict.action === "approval_required" && !scopedByFanout) {
      // Shape grant unit: the bare binary name (lowercased), so `[a]`
      // and "Allow in this chat" cover exactly the argv[0] that would
      // run: `git`, not `./git` or a compound line that starts with
      // `git`. Withheld for those and for opaque interpreters
      // (`bash -c …`) where the binary name hides what runs — see
      // `shellGrantShape`.
      const commandShape = shellGrantShape(
        guardInput.cmd,
        commandLine,
        useShell,
      );
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.shell.run",
          category: "shell",
          reason:
            `${guardVerdict.reason} in ${cwd}` +
            // The user approves the lifetime too: a background command
            // outlives the turn (ATO-1252).
            (rawArgs.background === true
              ? " (starts in the background and keeps running until the session ends or it is stopped)"
              : "") +
            (recovered === null
              ? ""
              : " (command reconstructed from args: the call had no cmd)"),
          // Quoted like the shell would need it, so the human approves
          // the argv that runs, not a re-joined look-alike (ATO-433).
          preview: formatShellPreview(cmd, execArgs, useShell),
          affectedResources: [cwd],
          ...(commandShape !== undefined ? { commandShape } : {}),
          targetPaths,
        },
        ctx.signal,
      );
    }

    const spawnSpec = resolveShellSpawn(cmd, execArgs, useShell);
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
    // Built per call, from the live env, so a key added to `.env`
    // mid-session is filtered the same way. The toolchain additions
    // (non-interactive switches, PATH folders) are fixed values applied
    // after the filter, never read from the call.
    const job = startCommandJob(spawnSpec.command, spawnSpec.args, {
      cwd,
      env: withToolchainEnv(
        buildCommandEnv(process.env, options.envPassthrough ?? []),
      ),
      ...(facts.gog ? { maxOutputBytes: GOG_MAX_OUTPUT_BYTES } : {}),
      ...(spawnSpec.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    // `node --check a b c` exits 0 having read only `a`. Said first,
    // because nothing in node's own output says it — and a reply built
    // on that exit code claims a check that never ran.
    const checkNotice = nodeCheckMultiFileNotice(commandLine, cwd);
    const notices = checkNotice === null ? [] : [checkNotice];

    // `background: true` (a dev server, a watcher): watched briefly for
    // an early failure, then handed back as a kept job. It went through
    // the same guard and approval above; only the wait differs.
    if (rawArgs.background === true) {
      const early = await job.waitFor(backgroundSettleMs, ctx.signal);
      if (early === "elapsed") {
        const { record, evicted } = jobs.register(ctx.sessionId, job, facts, true);
        return renderShellDetached(record, {
          waitedMs: backgroundSettleMs,
          again: false,
          defaultTimeoutMs,
          evicted,
          maxJobs: jobs.maxJobs,
          notices,
          detachNotice: formatShellBackgroundNotice(record.id),
        });
      }
      if (early === "aborted") job.kill();
      const exit = await awaitJobExit(job);
      return renderShellExit(facts, exit, job.output(), { notices });
    }

    // A spawn failure (ENOENT) rejects here, as the runner's always did.
    // While it runs, a command that went quiet at a prompt only a person
    // can answer is caught here rather than at the timeout (ATO-1252).
    const { outcome, prompt } = await waitWatchingForPrompt(
      job,
      timeout.timeoutMs,
      ctx.signal,
      options.promptWatch,
    );
    if (
      prompt !== null &&
      prompt.kind === "sign_in" &&
      timeout.source === "default"
    ) {
      // A sign-in completes in the user's browser while the command
      // listens for it: kept as a job so it can finish there. Not when
      // the model set its own `timeoutMs` — that bound still kills.
      const { record, evicted } = jobs.register(ctx.sessionId, job, facts, true);
      return renderShellDetached(record, {
        waitedMs: Date.now() - job.startedAt,
        again: false,
        defaultTimeoutMs,
        evicted,
        maxJobs: jobs.maxJobs,
        notices,
        detachNotice: formatInteractiveHandoff(prompt, commandLine, {
          jobId: record.id,
        }),
      });
    }
    if (prompt !== null) {
      // Waiting on input that will never come: stopped at once.
      job.stop();
      const exit = await awaitJobExit(job);
      return renderShellExit(facts, exit, job.output(), {
        notices: [
          formatInteractiveHandoff(prompt, commandLine, { ended: "stopped" }),
          ...notices,
        ],
      });
    }
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
    // A command that failed because it wanted a terminal, a password or
    // sudo: the result says which one step needs the user.
    const failedPrompt =
      outcome === "exited" && exit.exitCode !== 0
        ? (detectInteractivePrompt(output.stderr, "exited") ??
          detectInteractivePrompt(output.stdout, "exited"))
        : null;
    if (failedPrompt !== null) {
      notices.unshift(
        formatInteractiveHandoff(failedPrompt, commandLine, { ended: "failed" }),
      );
    }
    return renderShellExit(facts, exit, output, { notices });
  }

  return {
    name: "os.shell.run",
    description:
      "Run an OS command in the session working directory. Prefer the structured form `{cmd, args:[...]}` (argv globs `*`/`?` are expanded). Shell metacharacters (`|`, `&&`, `;`, `>`, `<`, `$`, backticks) are interpreted via the OS subshell (`sh -c` on macOS/Linux, `cmd.exe /c` on Windows) — a full command line passed as `cmd` (e.g. `\"ffprobe -v quiet … f.mp3\"` or `\"pip3 list | grep foo\"`) runs as written. Do not use for deleting user files — use `os.fs.trash` unless the user explicitly requests permanent shell deletion. Not for controlling web browsers (`osascript` scripts that read or set tabs and URLs, `open -a <browser> <url>`): those are refused; use the browser tools. Runs through a pre-exec guard: safe commands run directly, risky commands require approval, catastrophic commands are blocked without execution. Run the steps of a task yourself (installs such as `brew install`, `npm i -g`, `pip install`, `git clone`, builds, `make`, `docker run`) instead of printing them for the user to type: the approval prompt is how the user keeps control. The command has no terminal and no stdin; a command that stops at a sign-in, a password, sudo or a terminal question comes back with \"this step needs the user: …\" — hand over only that step. Pass `background: true` for a command that keeps running (a dev server, a watcher): it is started, watched for 3 s, and returned as a kept job. " +
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

      // `{"cmd": ["git", "status"]}`: an argv in `cmd` is the program and
      // its arguments (ATO-1259), when `args` does not also say them.
      if (
        Array.isArray(rawArgs.cmd) &&
        rawArgs.cmd.length > 0 &&
        rawArgs.cmd.every((v) => typeof v === "string") &&
        (coerceShellArgs(rawArgs.args)?.length ?? 1) === 0
      ) {
        const [program, ...rest] = rawArgs.cmd as string[];
        rawArgs = { ...rawArgs, cmd: program, args: rest };
      }

      // A call that put the whole command in `args` and named no `cmd`
      // is read back from its argv when that is unambiguous (#901); the
      // recovered call goes through the same guard and approval.
      const recovered = recoverMissingShellCmd(rawArgs);
      if (recovered === null) return runCommand(rawArgs, ctx, null);
      const result = await runCommand(
        { ...rawArgs, cmd: recovered.cmd, args: recovered.args },
        ctx,
        recovered,
      );
      return markRecoveredResult(result, recovered);
    },
  };
}

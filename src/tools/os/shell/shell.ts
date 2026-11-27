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
import {
  buildOsSandboxPolicy,
  formatSandboxUnavailable,
  readOsSandboxSettings,
  wrapWithOsSandbox,
  type OsSandboxSettings,
} from "../../../sandbox/os-sandbox.js";
import {
  ensureSandboxCacheRoot,
  withSandboxCacheEnv,
} from "../../../sandbox/sandbox-cache-env.js";
import { withoutLocalSocketEnv } from "../../../sandbox/os-sandbox-sockets.js";
import { quoteCmdArg } from "../../../sandbox/shell-invocation.js";
import {
  requireApproval,
  requireGuardOnShortcut,
  savedRuleDenies,
  savedRuleOverridesScope,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import { resolveUserPath } from "../expand-home.js";
import { expandShellGlobArgs } from "./expand-shell-glob-args.js";
import { nodeCheckMultiFileNotice } from "./node-check-notice.js";
import {
  shellCommandArgv,
  shellRuleSegments,
  shellRunsUnreadableScript,
} from "./shell-command-argv.js";
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
import {
  hasUntil,
  runShellWaitUntil,
  runShellWaitUntilById,
} from "./shell-job-until.js";
import { compileWatchPattern } from "./shell-job-watch.js";
import { runShellWrite } from "./shell-job-write.js";
import { runShellMonitor } from "./shell-job-monitor-call.js";
import { hideTypedSecrets } from "./shell-job-secret.js";
import { ttyEnv } from "./tty-wrap.js";
import { startInteractiveJob, type TtyBackend } from "./tty-spawn.js";
import type { NodePtyModule } from "../../../native/load-node-pty.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { shellEgress } from "./shell-egress.js";
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
  formatShellInteractiveNotice,
  resolveShellTimeout,
} from "./shell-timeout.js";
import {
  detectInteractivePrompt,
  formatInteractiveHandoff,
} from "./interactive-prompt.js";
import { waitWatchingForPrompt } from "./wait-watching-for-prompt.js";
import type { ToolSecretSource } from "../../../config/tool-secrets.js";
import {
  checkShellSecrets,
  describeShellSecretUse,
  fillShellSecrets,
} from "./shell-secrets.js";
import { ghReadOnlyRule } from "../shell-command-guard/rules-trusted/gh.js";
import { execShellScript, shellSecurityCheck } from "./shell-security-check.js";
import { gogReadOnlyRule } from "../shell-command-guard/rules-trusted/gog.js";
import { icalBuddyReadOnlyRule } from "../shell-command-guard/rules-trusted/ical-buddy.js";

export {
  isOpaqueInterpreterShape,
  needsShellInterpretation,
  shellGrantShape,
} from "./shell-interpretation.js";

/**
 * True for a verdict of the guard's dangerous layer (`dangerous.*` in
 * `rules-dangerous.ts`): the command asks as `shell_dangerous`.
 */
export function isDangerousGuardRule(rule: string): boolean {
  return rule.startsWith("dangerous.");
}

/**
 * The trusted read-only tools the guard runs unasked (`rules-trusted/`):
 * `gh` reads, `gog`, `icalBuddy`. They read private data (a calendar,
 * private repositories), so the person's security rules (ATO-2111)
 * still review them when a guard file covers `os.shell.run`. Matched by
 * the rule's id prefix, since one rule returns several verdict names
 * (`gh.read_only`, `gh.api_read`, `gog.auth_read`).
 */
const TRUSTED_RULE_PREFIXES: readonly string[] = [ghReadOnlyRule, gogReadOnlyRule, icalBuddyReadOnlyRule].map(
  (rule) => `${rule.id.split(".")[0]}.`,
);

/** True for an allow verdict of a trusted read-only rule. */
export function isTrustedReadOnlyVerdict(verdict: { action: string; rule: string }): boolean {
  return verdict.action === "allow" && TRUSTED_RULE_PREFIXES.some((prefix) => verdict.rule.startsWith(prefix));
}

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
  /**
   * Safe Mode's OS sandbox switch (ATO-469), read per call so a switch
   * flipped mid-session applies to the next command. Omitted ⇒ read
   * from `ATOMIC_AGENT_SANDBOX` / `ATOMIC_AGENT_SANDBOX_NETWORK`.
   */
  sandbox?: () => OsSandboxSettings;
  /**
   * `config.paths.stateDir`: hidden from a sandboxed command (its
   * `.env`, config and tokens). Omitted ⇒ only the home credential
   * folders are hidden.
   */
  stateDir?: string;
  /** Test seam: the prompt watch's poll and quiet intervals. */
  promptWatch?: { pollMs?: number; quietMs?: number };
  /** Test seam: how long a `background: true` command is watched. */
  backgroundSettleMs?: number;
  /**
   * Tool secrets a command may name as `{{secret:NAME}}` (ATO-476),
   * filled in only after approval. Omitted ⇒ none: a placeholder fails.
   */
  secrets?: ToolSecretSource;
  /** Test seam: the pty binding for `tty: true` jobs (ATO-2484). */
  loadPty?: () => NodePtyModule | null;
}

/**
 * How long a `background: true` command is watched before it is handed
 * back as a job: long enough for a dev server to print its URL or fail
 * on a busy port, short enough not to hold the step.
 */
export const SHELL_BACKGROUND_SETTLE_MS = 3_000;
/** The same for a `tty: true` job, which usually just waits for input. */
export const SHELL_TTY_SETTLE_MS = 1_000;

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
    // An explicit `timeoutMs` wins (`-1` = none — long installs like
    // `brew install` need it) and kills at its limit: the model asked
    // for a bound. The operator's default (F47: a scan of a home
    // directory used to run until someone killed it) detaches
    // instead — a build the default interrupted is not one the model
    // wanted stopped. The turn's abort signal stays the safety valve.
    // A zero `timeoutMs` reads as omitted (zero-filling models, ATO-1175).
    const timeout = resolveShellTimeout(rawArgs.timeoutMs, defaultTimeoutMs);
    // `until` (ATO-2358): start in the background and come back at the
    // first output line matching it. A bad pattern is refused before
    // anything is asked or run.
    const until = hasUntil(rawArgs.until) ? rawArgs.until : undefined;
    if (until !== undefined) {
      const compiled = compileWatchPattern(until);
      if (!compiled.ok) {
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output: `os.shell.run: ${compiled.message}`,
          details: { cmd, invalidCall: true },
        });
      }
    }
    // `tty: true` (ATO-2277): an interactive kept job on a pty that
    // `{"write": id, "text": …}` types into.
    const interactive = rawArgs.tty === true;
    // Safe Mode keeps its sandbox as it is: on macOS it does not allow
    // the pty device, and widening it for this is not worth the risk.
    if (
      interactive &&
      (options.sandbox ?? (() => readOsSandboxSettings()))().mode === "workspace"
    ) {
      return compressToolResult({
        tool: "os.shell.run",
        status: "error",
        output:
          "os.shell.run: terminal mode (`tty: true`) is off in Safe Mode; run the command without `tty`, or hand the interactive step to the user.",
        details: { cmd, tty: true, safeMode: true },
      });
    }
    const background =
      rawArgs.background === true || until !== undefined || interactive;

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

    // `{{secret:NAME}}` (ATO-476): every name must be a configured tool
    // secret before anything is asked. Such a command always goes to the
    // gate, and the approval names the secrets it uses.
    const secretCheck = checkShellSecrets(cmd, execArgs, useShell, options.secrets);
    if (!secretCheck.ok) {
      return compressToolResult({
        tool: "os.shell.run",
        status: "error",
        output: `os.shell.run: ${secretCheck.message}`,
        details: { cmd, rawArgs: rawArgList, cwd, shell: useShell },
      });
    }
    const secretNames = secretCheck.names;

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
    // Same for a call a saved deny or ask rule covers.
    // Nor does the directory cover a dangerous command (`rm -rf`, `git
    // reset --hard`, `sudo`): the operator approved a directory of work,
    // not those, so it goes to the gate too, where a worker's refuse
    // policy hands it back as a step for the operator (ATO-1223).
    // A write into a startup, SSH or credential file in home asks at
    // every level, like a credential read (ATO-2505).
    const security = shellSecurityCheck(
      guardVerdict,
      targetPaths,
      cwd,
      useShell ? subshellCommandLine : execShellScript(cmd, execArgs),
      useShell && process.platform === "win32" ? "cmd" : "posix",
    );
    const dangerous = isDangerousGuardRule(guardVerdict.rule) || security.forcesGate;
    const commandSegments = shellRuleSegments(cmd, execArgs, useShell);
    const commandUnreadable = shellRunsUnreadableScript(cmd, execArgs, useShell);
    // Where the command sends data (ATO-2116): shown on the card, and a
    // host nobody approved keeps a fan-out scope from settling the call.
    // A script fed to a shell counts as data to an unknown host.
    const egress = shellEgress(commandSegments, cwd, { commandUnreadable, targetPaths });
    const ruleCheck = {
      sessionId: ctx.sessionId,
      tool: "os.shell.run",
      category: "shell" as const,
      commandSegments,
      ...(commandUnreadable ? { commandUnreadable } : {}),
      affectedResources: [cwd],
      targetPaths,
      workdir: ctx.workingDir,
    };
    const scopedByFanout =
      !dangerous &&
      (options.approvals.fanoutScopes?.allows(ctx.sessionId, [cwd]) ??
        false) &&
      !(
        options.approvals.hasDeclinedTarget?.({
          sessionId: ctx.sessionId,
          tool: "os.shell.run",
          category: "shell",
          targetPaths,
        }) ?? false
      ) &&
      (options.approvals.unapprovedEgress?.(ctx.sessionId, egress) ?? []).length === 0 &&
      !savedRuleOverridesScope(options.approvals, ruleCheck);
    // A command the guard deems safe (`echo`, `ls`) runs without asking,
    // but a saved deny rule still stops it: it goes to the gate, which
    // refuses it on the rule before any level, grant or prompt
    // (ATO-1332). Ask and allow rules keep to the gated path.
    const deniedBySavedRule =
      guardVerdict.action === "allow" &&
      options.approvalRequired &&
      savedRuleDenies(options.approvals, ruleCheck);
    if (
      (guardVerdict.action === "approval_required" && !scopedByFanout) ||
      deniedBySavedRule ||
      secretNames.length > 0 ||
      security.forcesGate
    ) {
      // Shape grant unit: the bare binary name (lowercased), so `[a]`
      // and "Allow in this chat" cover exactly the argv[0] that would
      // run: `git`, not `./git` or a compound line that starts with
      // `git`. Withheld for those and for opaque interpreters
      // (`bash -c …`) where the binary name hides what runs — see
      // `shellGrantShape`.
      //
      // A command the dangerous layer matched (`rm -rf`, `git reset
      // --hard`, `sudo`) asks as `shell_dangerous` with no shape: no
      // `shell` grant, no `[a]` on `git` and no level below full trust
      // runs it unasked, and no prompt offers to remember it (ATO-1220).
      // A command that uses a tool secret (ATO-476) asks the same way,
      // as `shell_secret` (ATO-2530): the human sees each one, and no
      // earlier grant lets one through. Dangerous wins the label.
      const strict = dangerous || secretNames.length > 0;
      const commandShape = strict
        ? undefined
        : shellGrantShape(guardInput.cmd, commandLine, useShell);
      // Saved approval rules match on argv and on the session's folder.
      const commandArgv = shellCommandArgv(cmd, execArgs, useShell, commandShape);
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.shell.run",
          category: dangerous ? "shell_dangerous" : secretNames.length > 0 ? "shell_secret" : "shell",
          reason:
            `${security.forcesGate ? security.finding!.reason : guardVerdict.reason} in ${cwd}` +
            // The user approves the lifetime too: a background command
            // outlives the turn (ATO-1252).
            (background
              ? " (starts in the background and keeps running until the session ends or it is stopped)"
              : "") +
            (interactive
              ? " (interactive: the agent can type into it, and each input asks like a command)"
              : "") +
            (recovered === null
              ? ""
              : " (command reconstructed from args: the call had no cmd)") +
            describeShellSecretUse(secretNames),
          // Quoted like the shell would need it, so the human approves
          // the argv that runs, not a re-joined look-alike (ATO-433).
          preview: formatShellPreview(cmd, execArgs, useShell),
          affectedResources: [cwd],
          ...(commandShape !== undefined ? { commandShape } : {}),
          ...(commandArgv !== undefined ? { commandArgv } : {}),
          commandSegments,
          ...(commandUnreadable ? { commandUnreadable } : {}),
          ...(egress.length > 0 ? { egress } : {}),
          workdir: ctx.workingDir,
          targetPaths,
          ...(security.askEveryLevel ? { askEveryLevel: true as const } : {}),
          ...(security.finding !== undefined ? { securityFinding: security.finding } : {}),
        },
        ctx.signal,
      );
    } else {
      // The fan-out's yes does not cover the person's security rules
      // (ATO-2111), nor does the guard's trust in a read-only tool, nor
      // its "safe" verdict (`echo`, `cat`, `cp`: ATO-2529): every call
      // that skips the gate still meets guard.md when one covers the
      // shell. Without a guard file this is a no-op.
      await requireGuardOnShortcut(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.shell.run",
          category: "shell",
          reason: `${guardVerdict.reason} in ${cwd}`,
          preview: formatShellPreview(cmd, execArgs, useShell),
          affectedResources: [cwd],
          ...(egress.length > 0 ? { egress } : {}),
          workdir: ctx.workingDir,
          targetPaths,
        },
        ctx.signal,
      );
    }

    // After approval, and only into what is spawned: `facts`, the
    // result and every record keep the placeholders.
    let runCmd = cmd;
    let runArgs: readonly string[] = execArgs;
    if (secretNames.length > 0 && options.secrets !== undefined) {
      const filled = await fillShellSecrets(
        cmd,
        execArgs,
        useShell,
        secretNames,
        options.secrets,
        (c, a) => {
          const line = [c, ...a].join(" ");
          const tokens = line.split(/\s+/).filter((t) => t.length > 0);
          const verdict =
            (useShell
              ? checkBrowserBypassLine(line, cwd)
              : checkBrowserBypassArgv(c, [...a], cwd)) ??
            checkShellCommandGuard(
              useShell && tokens.length > 0
                ? { cmd: tokens[0]!, rawArgs: tokens.slice(1), cwd }
                : { cmd: c, rawArgs: [...a], cwd },
              options.shellPolicy,
            );
          return verdict.action === guardVerdict.action && verdict.rule === guardVerdict.rule;
        },
      );
      if (!filled.ok) {
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output: `os.shell.run: ${filled.message}`,
          details: { cmd, rawArgs: rawArgList, cwd, shell: useShell },
        });
      }
      runCmd = filled.cmd;
      runArgs = filled.args;
    }
    const plainSpawn = resolveShellSpawn(runCmd, runArgs, useShell);
    const spawnSpec = plainSpawn;
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
    // Safe Mode (ATO-469/472): the same spawn, wrapped so the kernel
    // keeps writes in the work folders, hides credential folders and the
    // agent's state, and (unless allowed) blocks the network. Without a
    // sandbox on this machine the command is refused, never run bare.
    const sandbox = (options.sandbox ?? (() => readOsSandboxSettings()))();
    let spawnCommand = spawnSpec.command;
    let spawnArgs = spawnSpec.args;
    let sandboxNotice: string | null = null;
    let sandboxCacheRoot: string | null = null;
    let sandboxFd3: Buffer | undefined;
    if (sandbox.mode === "workspace") {
      // Roots from the session's working directory only: `cwd` is a
      // model-supplied argument, so it may start the command anywhere
      // but never widens what the sandbox allows.
      const policy = buildOsSandboxPolicy({
        workspaceRoots: [ctx.workingDir],
        ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        network: sandbox.network,
      });
      const wrapped = wrapWithOsSandbox(spawnSpec.command, spawnSpec.args, policy);
      if (!wrapped.ok) {
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output: formatSandboxUnavailable(wrapped.reason),
        });
      }
      spawnCommand = wrapped.command;
      spawnArgs = wrapped.args;
      // Linux without network: the seccomp program bwrap reads on fd 3 (ATO-2469).
      sandboxFd3 = wrapped.fd3Input;
      // Package caches go to a private folder under temp, never the
      // shared ones in the home folder (ATO-1651).
      sandboxCacheRoot = ensureSandboxCacheRoot();
      sandboxNotice = sandbox.network
        ? "Safe Mode sandbox: writes outside the working folder and temp, and reads of credential folders, are blocked. An `Operation not permitted` error comes from that, not from the command."
        : "Safe Mode sandbox: writes outside the working folder and temp, reads of credential folders, internet and local-socket connections, DNS and opening URLs are blocked; loopback (127.0.0.1) stays open. An `Operation not permitted` or name-resolution error comes from that, not from the command.";
      sandboxNotice +=
        " Package caches (npm, npx, pip, Go, cargo, Maven, Gradle and similar) use a private sandbox cache under temp, not the shared ones in the home folder.";
      // ATO-2471: these run code later, outside the sandbox.
      const gitPart =
        process.platform === "linux"
          ? "`.git` and any other git folder (git commands that write the repo fail here; use the os.git.* tools)"
          : "`.git` and any other git folder apart from git's own data (no `git init`, `git clone`, `git config` or `git rebase` here; use the os.git.* tools)";
      sandboxNotice += ` Even in the working folder these are read-only: ${gitPart}, hook folders (\`.husky\`, \`.githooks\`, the \`core.hooksPath\` folder), shell rc files, \`.envrc\`, git's and fish's config and editor settings (\`.vscode\`, \`.idea\`).`;
      if (policy.narrowedRoots !== undefined) {
        sandboxNotice +=
          " The working folder is the home folder or above it, so it is not writable inside the sandbox; only temp is. Start the session in a project folder to write files there.";
      }
    }
    // Its own process group, so a stop reaches what the command
    // started too (`sleep 30 &` behind a subshell used to outlive the
    // shell and hold the result until it ended).
    // Built per call, from the live env, so a key added to `.env`
    // mid-session is filtered the same way. The toolchain additions
    // (non-interactive switches, PATH folders) are fixed values applied
    // after the filter, never read from the call.
    const commandEnv = withToolchainEnv(
      buildCommandEnv(process.env, options.envPassthrough ?? []),
    );
    const cachedEnv =
      sandboxCacheRoot === null
        ? commandEnv
        : withSandboxCacheEnv(commandEnv, sandboxCacheRoot);
    const dropSocketEnv = sandbox.mode === "workspace" && !sandbox.network;
    // Package caches go to the private sandbox cache (ATO-1651); without
    // network the socket variables (`SSH_AUTH_SOCK`, `DOCKER_HOST`,
    // D-Bus) are dropped too (ATO-1652); a tty job adds its terminal
    // variables last (ATO-2277).
    const jobEnv = (interactive ? ttyEnv : (env: NodeJS.ProcessEnv) => env)(
      dropSocketEnv ? withoutLocalSocketEnv(cachedEnv) : cachedEnv,
    );
    // A `tty: true` job runs on node-pty, else `script(1)`, else pipes
    // (tty-spawn.ts, ATO-2484). Safe Mode refused it above, so its
    // spawn is never the sandbox wrapper.
    const interactiveJob = interactive
      ? startInteractiveJob(
          {
            command: spawnCommand,
            args: spawnArgs,
            ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          },
          {
            cwd,
            env: jobEnv,
            ...(facts.gog ? { maxOutputBytes: GOG_MAX_OUTPUT_BYTES } : {}),
          },
          options.loadPty ? { loadPty: options.loadPty } : {},
        )
      : null;
    const ttyBackend: TtyBackend | null = interactiveJob?.backend ?? null;
    const job =
      interactiveJob?.job ??
      startCommandJob(spawnCommand, spawnArgs, {
        cwd,
        env: jobEnv,
        // The Safe Mode wrapper's seccomp program (never on a tty job).
        ...(sandboxFd3 === undefined ? {} : { fd3Input: sandboxFd3 }),
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
    if (sandboxNotice !== null) notices.push(sandboxNotice);

    // `background: true` (a dev server, a watcher): watched briefly for
    // an early failure, then handed back as a kept job. It went through
    // the same guard and approval above; only the wait differs.
    if (background && until !== undefined) {
      // A spawn failure rejects here, as on the plain background path.
      await job.waitFor(1, ctx.signal);
      const { record, evicted } = jobs.register(ctx.sessionId, job, facts, true);
      const jobCtx = { jobs, sessionId: ctx.sessionId, defaultTimeoutMs, signal: ctx.signal };
      const result = await runShellWaitUntil(jobCtx, record, until, timeout.timeoutMs, {
        notices,
        evicted,
        maxJobs: jobs.maxJobs,
      });
      // A cancelled turn does not leave behind what it was starting.
      if (ctx.signal.aborted && record.state === "running") jobs.stop(record, "kill");
      return result;
    }
    if (background) {
      // An interactive program waits for input: no point watching it long.
      const settleMs = interactive
        ? Math.min(backgroundSettleMs, SHELL_TTY_SETTLE_MS)
        : backgroundSettleMs;
      const early = await job.waitFor(settleMs, ctx.signal);
      if (early === "elapsed") {
        const { record, evicted } = jobs.register(ctx.sessionId, job, facts, true);
        return renderShellDetached(record, {
          waitedMs: settleMs,
          again: false,
          defaultTimeoutMs,
          evicted,
          maxJobs: jobs.maxJobs,
          notices,
          detachNotice: interactive
            ? formatShellInteractiveNotice(record.id, ttyBackend !== null && ttyBackend !== "pipes")
            : formatShellBackgroundNotice(record.id),
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
      "Run an OS command in the session working directory. Prefer the structured form `{cmd, args:[...]}` (argv globs `*`/`?` are expanded). Shell metacharacters (`|`, `&&`, `;`, `>`, `<`, `$`, backticks) are interpreted via the OS subshell (`sh -c` on macOS/Linux, `cmd.exe /c` on Windows) — a full command line passed as `cmd` (e.g. `\"ffprobe -v quiet … f.mp3\"` or `\"pip3 list | grep foo\"`) runs as written. Do not use for deleting user files — use `os.fs.trash` unless the user explicitly requests permanent shell deletion. Not for controlling web browsers (`osascript` scripts that read or set tabs and URLs, `open -a <browser> <url>`): those are refused; use the browser tools. Runs through a pre-exec guard: safe commands run directly, risky commands require approval, catastrophic commands are blocked without execution. Run the steps of a task yourself (installs such as `brew install`, `npm i -g`, `pip install`, `git clone`, builds, `make`, `docker run`) instead of printing them for the user to type: the approval prompt is how the user keeps control. The command has no terminal and no stdin unless started with `tty: true` (an interactive kept job on a terminal: a REPL, `npm init`, an installer's questions), which `{\"write\": id, \"text\": \"y\\n\"}` types into (end with \\n to press Enter; each input asks like a command; never type a password: `{\"write\": id, \"secret\": \"sudo password\"}` asks the user to type it into the job, and you never see the value); otherwise a command that stops at a sign-in, a password, sudo or a terminal question comes back with \"this step needs the user: …\" — hand over only that step. Pass `background: true` for a command that keeps running (a dev server, a watcher): it is started, watched for 3 s, and returned as a kept job. Pass `until` (a case-insensitive regular expression, e.g. \"ready|error\") to come back as soon as the command or job prints a matching line instead of polling: `{cmd, until}` starts it as a kept background job, `{wait: id, until}` watches a job; each match is reported once, so the next `until` waits for the next one. `{\"monitor\": id, \"until\": \"ready|error\"}` returns at once and keeps listening: each later matching line arrives as a notice in this conversation, also after the turn ends, so do not poll; `{\"monitor\": id}` turns it off. " +
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
      // A value the person typed into a job (ATO-2486) is hidden in every
      // later result of the session's jobs, however weak it looks.
      const hideTyped = (result: CompressedToolResult) => hideTypedSecrets(ctx.sessionId, result);
      if (form.kind === "jobs") return hideTyped(await listShellJobs(jobCtx));
      if (form.kind === "wait") {
        if (hasUntil(rawArgs.until)) {
          return hideTyped(
            await runShellWaitUntilById(
              jobCtx,
              form.id,
              rawArgs.until,
              rawArgs.timeoutMs,
              rawArgs.keep === true,
            ),
          );
        }
        return hideTyped(await runShellWait(jobCtx, form.id, rawArgs.timeoutMs, rawArgs.keep === true));
      }
      if (form.kind === "kill") return hideTyped(await runShellKill(jobCtx, form.id));
      if (form.kind === "write") return hideTyped(await runShellWrite(jobCtx, options, form.id, rawArgs));
      if (form.kind === "monitor") return hideTyped(await runShellMonitor(jobCtx, form.id, rawArgs.until));

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
      const platform = process.platform;
      const recovered = recoverMissingShellCmd(rawArgs, platform);
      // A started command can print a value typed into a job (ATO-2486):
      // its tail, its `until` match or its whole output.
      if (recovered === null) return hideTyped(await runCommand(rawArgs, ctx, null));
      const result = await runCommand(
        { ...rawArgs, cmd: recovered.cmd, args: recovered.args },
        ctx,
        recovered,
      );
      return hideTyped(markRecoveredResult(result, recovered, platform));
    },
  };
}

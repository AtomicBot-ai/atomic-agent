import type { CommandJob, CommandJobExit, CommandJobOutputListener } from "../../../sandbox/command-job.js";
import { checkShellCommandGuard } from "../shell-command-guard/index.js";
import type { ShellCommandFacts } from "./shell-result.js";

/**
 * A job with no process behind it, for the host-side tests (ATO-2485):
 * `print` plays output through `onOutput`, `typed` collects what reached
 * stdin, `finish` ends it.
 */
export interface HostFakeJob extends CommandJob {
  typed: string[];
  ended: boolean;
  stops: number;
  print(text: string): void;
  finish(exit: CommandJobExit): void;
}

export function hostFakeJob(options: { stdinOpen?: boolean; snapshot?: string; truncated?: boolean } = {}): HostFakeJob {
  let resolveExit!: (exit: CommandJobExit) => void;
  let exited: CommandJobExit | null = null;
  let stdinOpen = options.stdinOpen ?? true;
  const printed: string[] = [options.snapshot ?? ""];
  const listeners = new Set<CommandJobOutputListener>();
  const exit = new Promise<CommandJobExit>((resolve) => {
    resolveExit = resolve;
  });
  const job: HostFakeJob = {
    command: "python3",
    args: [],
    pid: 4242,
    startedAt: 1_700_000_000_000,
    exit,
    typed: [],
    ended: false,
    stops: 0,
    exited: () => exited,
    output: () => ({ stdout: printed.join(""), stderr: "", truncated: options.truncated ?? false }),
    waitFor: () => Promise.resolve("elapsed" as const),
    onOutput(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write(text) {
      if (!stdinOpen || exited) return false;
      job.typed.push(text);
      return true;
    },
    endInput() {
      stdinOpen = false;
      job.ended = true;
    },
    stop() {
      job.stops += 1;
    },
    kill() {
      job.stops += 1;
    },
    print(text) {
      printed.push(text);
      for (const listener of listeners) listener(text, "stdout");
    },
    finish(value) {
      exited = value;
      stdinOpen = false;
      resolveExit(value);
    },
  };
  return job;
}

export function hostFacts(cmd: string): ShellCommandFacts {
  return {
    cmd,
    args: [],
    rawArgs: [],
    cwd: "/work",
    shell: false,
    commandLine: cmd,
    noArguments: false,
    gog: false,
    guard: checkShellCommandGuard({ cmd, rawArgs: [], cwd: "/work" }),
  };
}

/**
 * Resolves "open a new OS terminal window running atomic-agent" into a
 * concrete `{cmd, args}` for the current platform. Pure on purpose: the
 * PATH probe and the spawn both arrive as inputs, so every branch is
 * unit-reachable without touching the machine.
 */

export interface TerminalLaunch {
  readonly cmd: string;
  readonly args: readonly string[];
  /** Human name of the terminal being opened, for the chat confirmation. */
  readonly label: string;
}

export interface TerminalLaunchInput {
  readonly platform: NodeJS.Platform;
  /** `process.execPath` of the running agent. */
  readonly execPath: string;
  /** `process.argv` of the running agent. */
  readonly argv: readonly string[];
  /** `isSea()` — a SEA build has no script path in argv. */
  readonly isSea: boolean;
  /** Working directory the new window should start in. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `true` when `name` resolves to an executable on PATH. */
  readonly hasBinary: (name: string) => boolean;
}

interface LinuxTerminal {
  readonly bin: string;
  readonly label: string;
  /** Wraps a `sh -c`-able command line into this emulator's argv shape. */
  readonly args: (command: string) => readonly string[];
}

/**
 * Probed in order. `-e` is the near-universal spelling; gnome-terminal
 * deprecated it in favour of `--`, and kitty takes the command bare.
 */
const LINUX_TERMINALS: readonly LinuxTerminal[] = [
  {
    bin: "gnome-terminal",
    label: "gnome-terminal",
    args: (command) => ["--", "sh", "-c", command],
  },
  {
    bin: "konsole",
    label: "konsole",
    args: (command) => ["-e", "sh", "-c", command],
  },
  {
    bin: "xfce4-terminal",
    label: "xfce4-terminal",
    args: (command) => ["-e", `sh -c ${shellQuote(command)}`],
  },
  { bin: "kitty", label: "kitty", args: (command) => ["sh", "-c", command] },
  {
    bin: "alacritty",
    label: "alacritty",
    args: (command) => ["-e", "sh", "-c", command],
  },
  {
    bin: "wezterm",
    label: "wezterm",
    args: (command) => ["start", "--", "sh", "-c", command],
  },
  {
    bin: "x-terminal-emulator",
    label: "x-terminal-emulator",
    args: (command) => ["-e", "sh", "-c", command],
  },
  { bin: "xterm", label: "xterm", args: (command) => ["-e", "sh", "-c", command] },
];

/**
 * Returns `null` — never throws — when the platform offers nothing we
 * know how to drive (a headless Linux box with no emulator installed is
 * the realistic case). The caller turns that into one warn line.
 */
export function buildTerminalLaunch(
  input: TerminalLaunchInput,
): TerminalLaunch | null {
  switch (input.platform) {
    case "darwin":
      return darwinLaunch(input);
    case "win32":
      return win32Launch(input);
    default:
      return posixLaunch(input);
  }
}

/**
 * The argv the child needs to re-enter the TUI. Mirrors the SEA
 * reasoning in `tui-command.ts`'s self-update relaunch: a SEA binary is
 * its own entry point, plain node needs the script path back. `tui` is
 * always explicit so the new window lands in the UI regardless of how
 * the parent process was invoked.
 */
export function agentArgv(input: TerminalLaunchInput): readonly string[] {
  const scriptPath = input.isSea ? undefined : input.argv[1];
  return scriptPath
    ? [input.execPath, scriptPath, "tui"]
    : [input.execPath, "tui"];
}

/**
 * Env vars the child must be told about explicitly, in the order they
 * are emitted. A freshly spawned terminal starts a login shell and does
 * **not** inherit our environment, so anything that steers where the
 * agent reads its state or its packaged assets has to travel inside the
 * command line — otherwise the second window silently talks to a
 * different `~/.atomic-agent`, or resolves `grammars/` and
 * `starter-skills/` from its own cwd and disagrees with the parent about
 * which copy is authoritative.
 */
const FORWARDED_ENV: readonly string[] = [
  "ATOMIC_AGENT_STATE_DIR",
  "ATOMIC_AGENT_GRAMMARS_DIR",
  "ATOMIC_AGENT_STARTER_SKILLS_DIR",
];

/** `NAME='value' ` for every forwarded var that is actually set. */
function forwardedEnv(
  input: TerminalLaunchInput,
  format: (name: string, value: string) => string,
): string {
  return FORWARDED_ENV.map((name) => {
    const value = input.env[name];
    return value ? format(name, value) : "";
  }).join("");
}

function posixCommandLine(input: TerminalLaunchInput): string {
  const prefix = forwardedEnv(
    input,
    (name, value) => `${name}=${shellQuote(value)} `,
  );
  const agent = agentArgv(input).map(shellQuote).join(" ");
  return `cd ${shellQuote(input.cwd)} && ${prefix}${agent}`;
}

function darwinLaunch(input: TerminalLaunchInput): TerminalLaunch {
  // Terminal.app is always installed; iTerm only when the operator is
  // already living in it. Both keep the shell alive after the agent
  // exits, so errors stay on screen.
  const app = input.env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
  const script = escapeAppleScript(posixCommandLine(input));
  return {
    cmd: "osascript",
    args: [
      "-e",
      `tell application "${app}" to do script "${script}"`,
      "-e",
      `tell application "${app}" to activate`,
    ],
    label: app === "iTerm" ? "iTerm" : "Terminal",
  };
}

function posixLaunch(input: TerminalLaunchInput): TerminalLaunch | null {
  // `-e` closes the window the moment the agent exits, which would eat
  // a startup error before anyone could read it; drop into a shell in
  // the same directory instead.
  const command = `${posixCommandLine(input)}; exec "\${SHELL:-sh}"`;
  const preferred =
    input.env.ATOMIC_AGENT_TERMINAL ?? input.env.TERMINAL ?? null;
  if (preferred && input.hasBinary(preferred)) {
    const known = LINUX_TERMINALS.find((t) => t.bin === preferred);
    return {
      cmd: preferred,
      args: known ? known.args(command) : ["-e", "sh", "-c", command],
      label: preferred,
    };
  }
  const found = LINUX_TERMINALS.find((t) => input.hasBinary(t.bin));
  if (!found) return null;
  return { cmd: found.bin, args: found.args(command), label: found.label };
}

function win32Launch(input: TerminalLaunchInput): TerminalLaunch {
  const agent = agentArgv(input);
  if (input.hasBinary("wt.exe")) {
    // `-w -1` opens a new window rather than a tab in the existing one.
    return {
      cmd: "wt.exe",
      args: ["-w", "-1", "nt", "-d", input.cwd, ...agent],
      label: "Windows Terminal",
    };
  }
  const prefix = forwardedEnv(
    input,
    (name, value) => `set "${name}=${value}" && `,
  );
  const command = `${prefix}${agent.map(cmdQuote).join(" ")}`;
  return {
    cmd: "cmd.exe",
    // `/k` keeps the console open after the agent exits, matching the
    // POSIX branches. The empty title argument is required by `start`.
    args: ["/c", "start", "atomic-agent", "cmd", "/k", command],
    label: "Command Prompt",
  };
}

/** POSIX single-quote quoting — safe for every byte except NUL. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value: string): string {
  return /[\s&|<>^]/.test(value) ? `"${value}"` : value;
}

/**
 * AppleScript string literal escaping. Backslash first, then the quote —
 * reversing the order would double-escape the backslashes we just added.
 */
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

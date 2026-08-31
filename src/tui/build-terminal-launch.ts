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
  /**
   * win32 only: the args are already quoted for cmd.exe and must reach
   * CreateProcess byte-for-byte. Node's default argv quoting cannot
   * protect a `cmd /c start` line — it only quotes on whitespace, and
   * cmd's operators (`&`, `^`, `|`) need double quotes, not backslash
   * escapes. Set by `open-url.ts`; every terminal launch leaves it off.
   */
  readonly windowsVerbatimArguments?: boolean;
}

export interface TerminalLaunchInput {
  readonly platform: NodeJS.Platform;
  /** `process.execPath` of the running agent. */
  readonly execPath: string;
  /** `process.argv` of the running agent. */
  readonly argv: readonly string[];
  /** `process.execArgv` — loader/inspect flags a dev run needs back. */
  readonly execArgv?: readonly string[];
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
  // foot takes the command bare, like kitty — it has no `-e` at all.
  { bin: "foot", label: "foot", args: (command) => ["sh", "-c", command] },
  // terminator and tilix take `-e` as a single command string.
  {
    bin: "terminator",
    label: "terminator",
    args: (command) => ["-e", `sh -c ${shellQuote(command)}`],
  },
  {
    bin: "tilix",
    label: "tilix",
    args: (command) => ["-e", `sh -c ${shellQuote(command)}`],
  },
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
  // execArgv keeps dev runs honest: under tsx/--import loaders the
  // script path alone is not runnable by plain node.
  const execArgv = input.execArgv ?? [];
  return scriptPath
    ? [input.execPath, ...execArgv, scriptPath, "tui"]
    : [input.execPath, ...execArgv, "tui"];
}

/**
 * A freshly spawned terminal starts a login shell and does **not**
 * inherit our environment, so a non-default state dir has to travel
 * inside the command line — otherwise the second window silently talks
 * to a different `~/.atomic-agent`.
 */
function posixCommandLine(input: TerminalLaunchInput): string {
  const prefix = forwardedEnv(input.env)
    .map(([k, v]) => `${k}=${shellQuote(v)} `)
    .join("");
  const agent = agentArgv(input).map(shellQuote).join(" ");
  return `cd ${shellQuote(input.cwd)} && ${prefix}${agent}`;
}

/**
 * Every `ATOMIC_AGENT_*` variable travels into the new window, sorted so
 * the command line is deterministic. Forwarding only the state dir made
 * the second window silently different whenever the parent was launched
 * with a custom llama URL, grammar dir or skills dir — the exact failure
 * class the state-dir forwarding was added to close.
 */
function forwardedEnv(
  env: Readonly<Record<string, string | undefined>>,
): [string, string][] {
  return Object.entries(env)
    .filter((pair): pair is [string, string] =>
      pair[0].startsWith("ATOMIC_AGENT_") && typeof pair[1] === "string" && pair[1].length > 0,
    )
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

function darwinLaunch(input: TerminalLaunchInput): TerminalLaunch {
  // Terminal.app is always installed; iTerm only when the operator is
  // already living in it. Both keep the shell alive after the agent
  // exits, so errors stay on screen.
  const script = escapeAppleScript(posixCommandLine(input));
  if (input.env.TERM_PROGRAM === "iTerm.app") {
    // iTerm2 has no Terminal-style `do script`: its dictionary is
    // "create window with default profile" plus "write text".
    return {
      cmd: "osascript",
      args: [
        "-e",
        `tell application "iTerm" to create window with default profile`,
        "-e",
        `tell application "iTerm" to tell current session of current window to write text "${script}"`,
        "-e",
        `tell application "iTerm" to activate`,
      ],
      label: "iTerm",
    };
  }
  return {
    cmd: "osascript",
    args: [
      "-e",
      `tell application "Terminal" to do script "${script}"`,
      "-e",
      `tell application "Terminal" to activate`,
    ],
    label: "Terminal",
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
      // Unknown emulator: the single-string `-e` dialect is the broadest
      // (xterm, konsole, terminator and tilix all accept it; the
      // multi-arg form breaks the last two).
      args: known ? known.args(command) : ["-e", `sh -c ${shellQuote(command)}`],
      label: preferred,
    };
  }
  const found = LINUX_TERMINALS.find((t) => input.hasBinary(t.bin));
  if (!found) return null;
  return { cmd: found.bin, args: found.args(command), label: found.label };
}

function win32Launch(input: TerminalLaunchInput): TerminalLaunch {
  const agent = agentArgv(input);
  const prefix = forwardedEnv(input.env)
    .map(([k, v]) => `set "${k}=${v}" && `)
    .join("");
  // `/k` keeps the console open after the agent exits on BOTH Windows
  // paths, matching the POSIX branches — a startup error must stay on
  // screen, and the env prefix must reach Windows Terminal too (wt's own
  // env inheritance goes through its single-instance monarch, which may
  // predate this process).
  const command = `${prefix}${agent.map(cmdQuote).join(" ")}`;
  if (input.hasBinary("wt.exe")) {
    // `-w -1` opens a new window rather than a tab in the existing one.
    // wt splits its command line on unquoted `;` (its pane separator),
    // so every argument that can carry one is escaped for wt.
    return {
      cmd: "wt.exe",
      args: [
        "-w",
        "-1",
        "nt",
        "-d",
        wtEscape(input.cwd),
        "cmd",
        "/k",
        wtEscape(command),
      ],
      label: "Windows Terminal",
    };
  }
  return {
    cmd: "cmd.exe",
    // The first `start` argument is its window title; unquoted, `start`
    // reads the next token as the program instead. An explicit empty
    // title (serialized as `""`) keeps `cmd /k` the program.
    args: ["/c", "start", "", "cmd", "/k", command],
    label: "Command Prompt",
  };
}

/** Windows Terminal splits on unquoted `;` — escape it per wt's rules. */
function wtEscape(value: string): string {
  return value.replace(/;/g, "\\;");
}

/** POSIX single-quote quoting — safe for every byte except NUL. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value: string): string {
  // Embedded quotes double inside a quoted cmd token. `%VAR%` expansion
  // inside quotes is a cmd property no quoting silences — a path
  // containing a defined %NAME% will still expand; acceptable residual.
  const escaped = value.replace(/"/g, '""');
  return /[\s&|<>^%;=,()"]/.test(value) ? `"${escaped}"` : value;
}

/**
 * AppleScript string literal escaping. Backslash first, then the quote —
 * reversing the order would double-escape the backslashes we just added.
 */
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

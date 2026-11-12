/**
 * Drive the real TUI through a real pseudo-terminal, in vitest (ATO-658).
 *
 * `ink-testing-library` renders the React tree into a string; it never
 * sees what a terminal does with the bytes: the alternate screen, mouse
 * reporting modes, incremental repaints over old cells, resize. The rail
 * bug and the "every click prints `[<0;64;21M` after exit" bug both lived
 * there. Until now that layer was checked by hand with a Python PTY +
 * pyte script.
 *
 * This fixture spawns a command in `node-pty` and feeds every byte into
 * `@xterm/headless`, a full terminal emulator without a DOM, so a test
 * reads the cell grid and the terminal modes exactly as a user's terminal
 * would hold them.
 *
 * Both packages are optional test-only dependencies (MIT; `node-pty` is
 * native). They are not in package.json: the `TUI (real terminal)` CI
 * workflow installs them with `npm install --no-save`, and
 * {@link loadPtyDeps} returns null anywhere they are absent so the tests
 * skip instead of failing the normal suite. Module names go through a
 * variable so `tsc` does not try to resolve them.
 */

/** The slice of node-pty this fixture uses. */
interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): PtyProcess;
}

/** The slice of @xterm/headless this fixture uses. */
interface HeadlessTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly type: "normal" | "alternate";
      readonly viewportY: number;
      readonly cursorX: number;
      readonly cursorY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  readonly modes: {
    readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
    readonly bracketedPasteMode: boolean;
    readonly applicationCursorKeysMode: boolean;
  };
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

type TerminalCtor = new (options: { cols: number; rows: number; allowProposedApi: boolean; scrollback: number }) => HeadlessTerminal;

export interface PtyDeps {
  pty: PtyModule;
  Terminal: TerminalCtor;
}

function pick<T>(mod: unknown, name: string): T | undefined {
  const record = mod as Record<string, unknown> | null;
  const direct = record?.[name];
  if (direct !== undefined) return direct as T;
  const fallback = (record?.default as Record<string, unknown> | undefined)?.[name];
  return fallback as T | undefined;
}

/** node-pty + @xterm/headless, or null when either is not installed. */
export async function loadPtyDeps(): Promise<PtyDeps | null> {
  const ptyName = "node-pty";
  const xtermName = "@xterm/headless";
  try {
    const ptyMod: unknown = await import(ptyName);
    const xtermMod: unknown = await import(xtermName);
    const spawn = pick<PtyModule["spawn"]>(ptyMod, "spawn");
    const Terminal = pick<TerminalCtor>(xtermMod, "Terminal");
    if (typeof spawn !== "function" || typeof Terminal !== "function") return null;
    return { pty: { spawn }, Terminal };
  } catch {
    return null;
  }
}

export interface PtySessionOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

/** A process running in a PTY with an emulated screen attached. */
export class PtySession {
  private readonly term: HeadlessTerminal;
  private readonly proc: PtyProcess;
  private pending: Promise<void> = Promise.resolve();
  private raw = "";
  private exitInfo: PtyExit | null = null;
  private readonly exited: Promise<PtyExit>;

  constructor(deps: PtyDeps, options: PtySessionOptions) {
    this.term = new deps.Terminal({ cols: options.cols, rows: options.rows, allowProposedApi: true, scrollback: 0 });
    this.proc = deps.pty.spawn(options.command, options.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    this.proc.onData((data) => {
      this.raw += data;
      this.pending = this.pending.then(() => new Promise<void>((done) => this.term.write(data, done)));
    });
    this.exited = new Promise<PtyExit>((resolveExit) => {
      this.proc.onExit((event) => {
        this.exitInfo = { exitCode: event.exitCode, signal: event.signal };
        resolveExit(this.exitInfo);
      });
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** Every byte the process wrote, for failure messages. */
  get rawOutput(): string {
    return this.raw;
  }

  get hasExited(): boolean {
    return this.exitInfo !== null;
  }

  /** Waits until the emulator has parsed everything received so far. */
  async settle(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.pending) {
      seen = this.pending;
      await seen;
    }
  }

  /** The visible grid, one string per row, right-trimmed. */
  async screen(): Promise<string[]> {
    await this.settle();
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y += 1) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
    }
    return lines;
  }

  async screenText(): Promise<string> {
    return (await this.screen()).join("\n");
  }

  /** Terminal state a user's shell inherits when the process is gone. */
  async terminalState(): Promise<{ buffer: "normal" | "alternate"; mouseTracking: string; bracketedPaste: boolean }> {
    await this.settle();
    return {
      buffer: this.term.buffer.active.type,
      mouseTracking: this.term.modes.mouseTrackingMode,
      bracketedPaste: this.term.modes.bracketedPasteMode,
    };
  }

  write(data: string): void {
    this.proc.write(data);
  }

  /** Resizes both sides, like a user dragging the window (SIGWINCH included). */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
    this.proc.resize(cols, rows);
  }

  signal(name: "SIGTERM" | "SIGINT" | "SIGHUP"): void {
    this.proc.kill(name);
  }

  /**
   * Polls the screen until `predicate` holds. Never a fixed sleep: a cold
   * start on a slow CI runner takes many seconds, a warm one a fraction.
   */
  async waitFor(
    predicate: (text: string) => boolean,
    { timeoutMs, label }: { timeoutMs: number; label: string },
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let text = "";
    while (Date.now() < deadline) {
      text = await this.screenText();
      if (predicate(text)) return text;
      if (this.hasExited) break;
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    }
    throw new Error(
      `timed out waiting for ${label} (exited: ${JSON.stringify(this.exitInfo)})\n--- screen ---\n${text}\n--- tail of raw output ---\n${JSON.stringify(this.raw.slice(-800))}`,
    );
  }

  /** Resolves with the exit, or null when it has not exited within `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<PtyExit | null> {
    const timeout = new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), timeoutMs));
    const result = await Promise.race([this.exited, timeout]);
    if (result) await this.settle();
    return result;
  }

  /** Kills the process if still running and frees the emulator. */
  async dispose(): Promise<void> {
    if (!this.hasExited) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await this.waitForExit(5_000);
    }
    this.term.dispose();
  }
}

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  columns: number;
  rows: number;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * React hook that subscribes to `process.stdout` `resize` events and
 * returns the live `columns` × `rows` of the host terminal. Falls back
 * to a sensible 80×24 default when the stream is not a TTY (piped
 * output, CI, ink-testing-library) so layouts stay deterministic in
 * snapshot-style tests.
 *
 * The hook only listens while mounted — the listener is detached on
 * unmount to avoid leaking handlers into long-running processes.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setSize(readSize(stdout));
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  const columns = stdout?.columns ?? DEFAULT_COLUMNS;
  const rows = stdout?.rows ?? DEFAULT_ROWS;
  return { columns, rows };
}

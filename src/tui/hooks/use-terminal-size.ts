import { useStdout } from "ink";
import { useEffect, useState } from "react";

import {
  clampRowsForLegacyConhost,
  isLegacyConhost,
} from "../legacy-conhost.js";

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
 *
 * On a legacy Win10 conhost the reported height is one row short of the
 * real terminal: a full-height frame scrolls that console, which is the
 * "shaking" / duplicated-last-row report. See `legacy-conhost.ts`.
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

/**
 * Pure size read, exported for tests. The legacy-conhost row guard only
 * applies to a real TTY: the fake stdouts used by tests, pipes and CI
 * have no scrolling cursor, and their reported size is kept verbatim.
 */
export function readTerminalSize(
  stdout: NodeJS.WriteStream | undefined,
  legacyConhost: boolean,
): TerminalSize {
  const columns = stdout?.columns ?? DEFAULT_COLUMNS;
  const rows = stdout?.rows ?? DEFAULT_ROWS;
  const guard = legacyConhost && stdout?.isTTY === true;
  return { columns, rows: clampRowsForLegacyConhost(rows, guard) };
}

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  return readTerminalSize(stdout, isLegacyConhost());
}

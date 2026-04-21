export interface LogSummary {
  totalLines: number;
  errorLines: number;
  warningLines: number;
  passCount: number;
  failCount: number;
  firstError: string | null;
  firstFailure: string | null;
}

/**
 * Pure heuristic summariser for tool stdout/stderr. We look for common
 * framework signals (pytest PASSED/FAILED, go test ok/FAIL, jest PASS/FAIL)
 * so the runtime can emit a compact one-line summary without an LLM call.
 */
export function summariseLog(output: string): LogSummary {
  const lines = output.split(/\r?\n/);
  let errorLines = 0;
  let warningLines = 0;
  let passCount = 0;
  let failCount = 0;
  let firstError: string | null = null;
  let firstFailure: string | null = null;
  for (const line of lines) {
    if (/\b(error|exception)\b/i.test(line)) {
      errorLines += 1;
      if (!firstError) firstError = line.trim().slice(0, 200);
    } else if (/\bwarn(ing)?\b/i.test(line)) {
      warningLines += 1;
    }
    if (/\b(PASSED|PASS|ok)\b/.test(line)) passCount += 1;
    if (/\b(FAILED|FAIL)\b/.test(line)) {
      failCount += 1;
      if (!firstFailure) firstFailure = line.trim().slice(0, 200);
    }
  }
  return {
    totalLines: lines.length,
    errorLines,
    warningLines,
    passCount,
    failCount,
    firstError,
    firstFailure,
  };
}

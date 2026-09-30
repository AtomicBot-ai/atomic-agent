import type { CompressorOptions } from "../../../compressor/result-compressor.js";

/**
 * Turning what the network git verbs print into something the model can
 * act on.
 *
 * Two things conspire against handing `compressToolResult` a raw
 * transcript here. It keeps the LAST twelve non-blank lines and then
 * head-slices the result to 400 characters, so a long report survives
 * only at its seam — the beginning of its end, which is the one stretch
 * that never holds the answer. And git splits the answer across both
 * streams: a pull says what happened to the tree on stdout and which
 * refs moved on stderr, so concatenating them and cutting from one end
 * buries whichever half the operator asked about.
 *
 * So each verb shapes its own short report, puts the lines that matter
 * where the cut cannot reach them, and asks for a cap sized to that
 * shape. The caps below are computed from the shape, not picked round:
 * every tool_result is re-cut at 8000 characters when the transcript is
 * rendered, and an oversized fresh result permanently evicts history
 * from the prompt pack, so the smallest cap that holds the content is
 * the only defensible one.
 */

/**
 * Passed to every network verb. git only draws a progress meter when
 * stderr is a terminal and the sandbox runner pipes it, so today these
 * commands are already quiet — but that is a side effect of how the
 * child process happens to be wired, not a promise. Saying so out loud
 * makes it a guarantee if anything ever hands git a pty, and it also
 * tells the server not to push its own meter down the sideband.
 */
export const NO_PROGRESS = "--no-progress";

/**
 * Render a stream the way a terminal would. A progress meter rewrites
 * one physical line over and over with carriage returns; only the last
 * frame was ever visible, and the last frame is the one that carries the
 * totals ("Receiving objects: 100% (18302/18302), 15.83 MiB, done."). So
 * this is not a filter over what git said — it is what git meant to
 * leave on screen. Blank lines go too, because the compressor drops them
 * anyway and they would otherwise spend line budget.
 */
export function renderStream(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).trimEnd())
    .filter((line) => line.trim().length > 0);
}

/**
 * Keep the first `head` and the last `tail` lines and count what fell
 * out in between. The count matters: dropping lines silently would let
 * the model believe it had seen the whole answer and report a partial
 * diffstat as the total.
 */
export function clampLines(
  lines: string[],
  head: number,
  tail: number,
): string[] {
  if (lines.length <= head + tail) return lines;
  return [
    ...lines.slice(0, head),
    `… [omitted ${lines.length - head - tail} lines]`,
    ...lines.slice(-tail),
  ];
}

/**
 * A pull is the one verb that speaks on both streams. stdout carries
 * what happened to the working tree — `Updating a1b2c3..d4e5f6`, the
 * `Fast-forward` (or `Successfully rebased`) line, one diffstat row per
 * file, git's own verdict "42 files changed, 1180 insertions(+)", and
 * then a `create mode` / `delete mode` block. stderr carries the
 * `From <url>` header and the refs that moved.
 *
 * Neither end of stdout holds the answer on its own, which is why this
 * one cannot be a plain head-or-tail cut. The head holds the
 * `Updating`/`Fast-forward` pair; the verdict is the single line anyone
 * actually reads, and it is buried in the middle because the mode block
 * trails it. So the report ends at the verdict — the mode lines below it
 * only restate which of the diffstat rows above were new files — and the
 * rows in between are counted rather than carried. stderr is short and
 * its header comes first, so it is mostly head-weighted.
 *
 * Budget: 1 preview line + (14 + marker + 2) + the trailing-lines note +
 * (4 + marker + 2) = 26 lines, at the ~90 characters a diffstat row with
 * a deep path runs to.
 */
const PULL_STDOUT_HEAD_LINES = 14;
const PULL_STDOUT_TAIL_LINES = 2;
const PULL_STDERR_HEAD_LINES = 4;
const PULL_STDERR_TAIL_LINES = 2;
const PULL_REPORT_LINES = 26;

/** git's own verdict on a merge or a pull: " 42 files changed, 1180 …". */
const DIFFSTAT_VERDICT = /^\s*\d+ files? changed/;

export const PULL_REPORT_LIMITS: Partial<CompressorOptions> = {
  maxTailLines: PULL_REPORT_LINES,
  maxSummaryLength: PULL_REPORT_LINES * 90,
};

export function shapePullReport(stdout: string, stderr: string): string {
  const stdoutLines = renderStream(stdout);
  const verdictAt = stdoutLines.findIndex((line) => DIFFSTAT_VERDICT.test(line));
  const trailing = verdictAt < 0 ? 0 : stdoutLines.length - verdictAt - 1;
  const tree = clampLines(
    trailing > 0 ? stdoutLines.slice(0, verdictAt + 1) : stdoutLines,
    PULL_STDOUT_HEAD_LINES,
    PULL_STDOUT_TAIL_LINES,
  );
  if (trailing > 0) tree.push(`… [omitted ${trailing} lines below the verdict]`);
  const refs = clampLines(
    renderStream(stderr),
    PULL_STDERR_HEAD_LINES,
    PULL_STDERR_TAIL_LINES,
  );
  const report = [...tree, ...refs].join("\n");
  return report || "(already up to date)";
}

/**
 * A fetch says everything it has to say on stderr, and it never touches
 * the working tree, so there is no diffstat to protect: the report is
 * the `From <url>` header plus one line per ref that moved — `* [new
 * branch] x -> origin/x`, `+ abc123...def456 main -> origin/main
 * (forced update)`, `- [deleted] (none) -> origin/gone`. Those start at
 * the top and no line among them is privileged, so this one is
 * head-weighted; the tail is kept only so a trailing warning survives a
 * first fetch of a repo with hundreds of branches.
 *
 * Budget: 1 preview line + 16 + marker + 4 = 22 lines, at the ~80
 * characters a ref-update line runs to.
 */
const FETCH_HEAD_LINES = 16;
const FETCH_TAIL_LINES = 4;
const FETCH_REPORT_LINES = 22;

export const FETCH_REPORT_LIMITS: Partial<CompressorOptions> = {
  maxTailLines: FETCH_REPORT_LINES,
  maxSummaryLength: FETCH_REPORT_LINES * 80,
};

export function shapeFetchReport(stderr: string): string {
  const refs = clampLines(
    renderStream(stderr),
    FETCH_HEAD_LINES,
    FETCH_TAIL_LINES,
  );
  return refs.join("\n") || "(already up to date)";
}

/**
 * A clone announces itself first and warns last, which makes it the
 * opposite of a fetch. "Cloning into 'x'…" is already in the preview and
 * in `details`, while everything worth acting on lands at the end: a
 * repository that turned out to be empty, a `--branch` that does not
 * exist so HEAD is detached, a warning that the remote HEAD points
 * nowhere. So this report is tail-weighted, and the head is kept only to
 * preserve the ordering when the whole thing fits anyway.
 *
 * Budget: 1 preview line + 2 + marker + 8 = 12 lines, at the ~100
 * characters a git warning runs to.
 */
const CLONE_HEAD_LINES = 2;
const CLONE_TAIL_LINES = 8;
const CLONE_REPORT_LINES = 12;

export const CLONE_REPORT_LIMITS: Partial<CompressorOptions> = {
  maxTailLines: CLONE_REPORT_LINES,
  maxSummaryLength: CLONE_REPORT_LINES * 100,
};

export function shapeCloneReport(stderr: string): string {
  const notes = clampLines(
    renderStream(stderr),
    CLONE_HEAD_LINES,
    CLONE_TAIL_LINES,
  );
  return notes.join("\n") || "cloned";
}

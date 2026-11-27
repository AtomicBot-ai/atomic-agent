import type { TurnExperience } from "./experience-review.js";

/**
 * Local content the self-learning review treats as outside content
 * (ATO-1650). The approval gate's taint (ATO-618) only names tools whose
 * result carries text from the network (web pages, MCP answers, HTTP
 * bodies, the inbox). A file on disk or a command's output can carry
 * someone else's text just as well: a downloaded file, a cloned repo, the
 * output of `curl`, a commit message. Text like that must not turn itself
 * into a live skill every later turn loads, so a turn that read any of it
 * keeps what it learned as a pending draft for the owner to approve, like
 * a turn that read a web page.
 *
 * Claude Code and Codex treat every tool result, files and command output
 * included, as data that may carry a prompt injection; this list applies
 * that to the one place where a turn's result outlives the turn.
 *
 * Kept apart from the approval taint on purpose: marking every file read
 * there would hold every later shell call of a tainted turn for review
 * (`agent.taintReview`), which is a separate decision.
 *
 * A map from the tool name to the label shown on the draft. Tools
 * not named here (writes, listings of file names, status checks) are not
 * counted; tools with `untrustedOutput` already reach the review through
 * the taint.
 */
const LOCAL_CONTENT_TOOLS: ReadonlyMap<string, string> = new Map(Object.entries({
  // File contents.
  "os.fs.read": "a local file",
  "os.fs.read_document": "a local document",
  "os.fs.grep": "local file contents",
  "os.fs.diff": "local file contents",
  "os.fs.docx": "a local document",
  "os.fs.xlsx": "a local spreadsheet",
  "os.fs.archive.read_entry": "a file inside an archive",
  "os.code.search": "local file contents",
  // Symbol names are short, but they are still text from the files.
  "os.fs.code_map": "local code symbols",
  // Command and code output.
  "os.shell.run": "shell command output",
  "skill.run_script": "script output",
  "verify.run": "program output",
  // Repository text written by whoever made the commits.
  "os.git.show": "git repository content",
  "os.git.diff": "git repository content",
  "os.git.log": "git repository content",
  "os.git.blame": "git repository content",
  // Text other people wrote on GitHub.
  "github.issue.list": "GitHub issues",
  "github.pr.list": "GitHub pull requests",
  // Whatever was copied last, often from a web page.
  "os.clipboard.read": "the clipboard",
  // Text read off the screen, an image or a recording.
  "os.screen.elements": "the screen",
  "vision.describe": "an image",
  "audio.transcribe": "a recording",
  // A delegated run's result relays what it read; its own taint stays on its own session.
  "subagent.run": "a subagent's result",
  "fusion.delegate": "a delegated worker's result",
}));

/**
 * The labels of the local content the turn read, in first-read order,
 * one per label. A call that failed still counts: an error message can
 * quote the file or the command output.
 */
export function localContentSources(experience: Pick<TurnExperience, "steps"> | null): string[] {
  if (experience === null) return [];
  const labels: string[] = [];
  for (const step of experience.steps) {
    const label = LOCAL_CONTENT_TOOLS.get(step.tool);
    if (label !== undefined && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Whether a result of `tool` counts as local outside content for self-learning. */
export function isLocalContentTool(tool: string): boolean {
  return LOCAL_CONTENT_TOOLS.has(tool);
}

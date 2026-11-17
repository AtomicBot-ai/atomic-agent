import type { AgentProfile } from "./agent-profile.js";

/**
 * The three profiles every install has (ATO-566). A trusted project file
 * or a user file of the same name (`~/.atomic-agent/agents/review.md`)
 * replaces one; see `profile-loader.ts` for the order.
 *
 * `model` names a fusion role (`llm.runMode.fusion.roles`), so the task
 * goes to that role's model when one is configured and to the worker leg
 * otherwise; nothing is spent on a model the operator did not set up.
 * `research` uses the `explore` role: it is reading, only of the web.
 *
 * All three are read-only: no file writes, no shell. `review` keeps the
 * `verify.*` checks, which run on a throwaway copy of the workspace.
 */
const FS_READ = [
  "os.fs.read",
  "os.fs.read_document",
  "os.fs.list",
  "os.fs.glob",
  "os.fs.grep",
  "os.fs.hash",
  "os.fs.diff",
  "os.fs.locate_project",
  "os.fs.code_map",
  "os.fs.archive.list",
  "os.fs.archive.read_entry",
];

const GIT_READ = ["os.git.status", "os.git.log", "os.git.diff", "os.git.show", "os.git.blame"];

const WEB_READ = [
  "os.web.search",
  "os.web.fetch",
  "browser.navigate",
  "browser.search",
  "browser.read_aria",
  "browser.scroll",
  "browser.tabs",
];

export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    name: "explore",
    description: "Find where things are in the code and how they fit together. Read-only.",
    model: "explore",
    tools: [...FS_READ, ...GIT_READ, "skill.view"],
    source: "builtin",
    prompt: [
      "You are an explorer. Your job is to find and explain, never to change anything.",
      "- Search before you read: grep and glob for names, then open only the files that matter.",
      "- Report concrete locations: file paths with line numbers, the function or type names, and how the pieces call each other.",
      "- Say plainly what you could not find and where you looked.",
      "- Do not propose a fix unless the task asks for one.",
    ].join("\n"),
  },
  {
    name: "review",
    description: "Review code or a change for bugs, risks and missing tests. Read-only.",
    model: "review",
    tools: [...FS_READ, ...GIT_READ, "verify.*", "skill.view"],
    source: "builtin",
    prompt: [
      "You are a reviewer. Read the code or change the task names and report what is wrong with it; do not edit files.",
      "- Look for correctness bugs first, then broken edge cases, missing tests and risky behaviour changes. Skip style unless it hides a bug.",
      "- Every finding names the file and line, what goes wrong, and when. Separate what you checked (ran a check, read the code path) from what you suspect.",
      "- Use the verify checks when they can confirm or refute a finding.",
      "- If you find nothing serious, say so in one line instead of inventing findings.",
    ].join("\n"),
  },
  {
    name: "research",
    description: "Look things up on the web and in local files and report sourced findings. Read-only.",
    model: "explore",
    tools: [...WEB_READ, ...FS_READ],
    source: "builtin",
    prompt: [
      "You are a researcher. Answer the task's question from sources and say where each fact came from.",
      "- Prefer primary sources: official docs, the project's own repository, release notes.",
      "- Give the URL or file path for every claim. Mark anything you could not confirm as unconfirmed.",
      "- Do not sign in, submit forms, buy anything or post anywhere.",
      "- Keep the answer to what the task asked; note conflicting sources instead of picking one silently.",
    ].join("\n"),
  },
];

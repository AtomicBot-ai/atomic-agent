import type { EvalCase } from "../harness/case-schema.js";

import { fsReadReadme } from "./fs-read-readme.case.js";
import { fsGrepTodo } from "./fs-grep-todo.case.js";
import { fsCreateChangelog } from "./fs-create-changelog.case.js";
import { fsGlobTypescript } from "./fs-glob-typescript.case.js";
import { shellPrintMarker } from "./shell-print-marker.case.js";
import { gitStatusClean } from "./git-status-clean.case.js";
import { skillListInstalled } from "./skill-list-installed.case.js";
import { skillViewPing } from "./skill-view-ping.case.js";
import { httpGetStatus } from "./http-get-status.case.js";
import { httpPostEcho } from "./http-post-echo.case.js";
import { summarizeReadme } from "./summarize-readme.case.js";
import { explainTreeShape } from "./explain-tree-shape.case.js";

/**
 * Initial eval corpus. Order is stable so report rows can be diff'd
 * across runs without sorting. Categories: 8 OS + 2 skill + 2 http.
 * The two OS judge cases at the tail use LLM-as-judge for open-ended
 * replies (summarisation, structural description).
 */
export const EVAL_CASES: ReadonlyArray<EvalCase> = [
  fsReadReadme,
  fsGrepTodo,
  fsCreateChangelog,
  fsGlobTypescript,
  shellPrintMarker,
  gitStatusClean,
  skillListInstalled,
  skillViewPing,
  httpGetStatus,
  httpPostEcho,
  summarizeReadme,
  explainTreeShape,
];

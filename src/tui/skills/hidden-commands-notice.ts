import { projectTrustHint } from "../../skills/project-trust.js";

/**
 * The one line the terminal shows when the working folder ships command
 * files (`.atomic-agent/commands`, `.claude/commands`) that stay hidden
 * because the folder is not trusted yet (ATO-2441). Before this they were
 * hidden without a word, and `/review` just looked missing.
 */
export function hiddenCommandsNotice(count: number, workingDir: string): string {
  const files = count === 1 ? "1 command file" : `${count} command files`;
  return `This folder has ${files} in .atomic-agent/commands or .claude/commands. `
    + "They stay hidden until you trust the folder: answer its trust question at start, "
    + `or run \`${projectTrustHint(workingDir)}\`.`;
}

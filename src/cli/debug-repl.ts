import { createInterface } from "node:readline";

export const REPL_HELP =
  [
    "atomic-agent repl — interactive debug scaffold (not yet implemented)",
    "",
    "Currently a stub: only 'help' and 'quit' work inside. The real",
    "step-the-agent-manually REPL lands with a later milestone, and the",
    "command is hidden from `atomic-agent --help` until then.",
  ].join("\n") + "\n";

/**
 * Interactive REPL to step the agent manually. The real implementation is
 * wired up once the agent loop (M4) and retrieval (M6) land. For M1 we
 * provide a minimal line-reader so the binary has a stable command surface.
 */
export async function debugReplCommand(args: string[]): Promise<number> {
  // Answer --help before touching readline: opening the interface grabs
  // stdin, so a help request used to drop the user into the (empty)
  // interactive prompt instead of printing anything.
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(REPL_HELP);
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("atomic-agent> ");
  process.stdout.write(
    "debug repl scaffolded. type 'help' for commands, 'quit' to exit.\n",
  );
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "quit" || trimmed === "exit") break;
    if (trimmed === "help") {
      process.stdout.write(
        [
          "available commands:",
          "  help          show this message",
          "  quit          exit the repl",
          "  (more commands will be added in later milestones)",
        ].join("\n") + "\n",
      );
    } else if (trimmed.length > 0) {
      process.stdout.write(`unknown command: ${trimmed}\n`);
    }
    rl.prompt();
  }
  rl.close();
  return 0;
}

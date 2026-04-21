import { createInterface } from "node:readline";

/**
 * Interactive REPL to step the agent manually. The real implementation is
 * wired up once the agent loop (M4) and retrieval (M6) land. For M1 we
 * provide a minimal line-reader so the binary has a stable command surface.
 */
export async function debugReplCommand(_args: string[]): Promise<number> {
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

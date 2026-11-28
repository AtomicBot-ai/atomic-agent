/**
 * Terminal questions for setup wizards such as `atag connect linear`
 * (ATO-2464). `ask` echoes; `askSecret` does not, so an API key typed
 * or pasted never shows on screen or in the scrollback (the same as `gh
 * auth login` and `npm login`). Without a terminal (piped input) both
 * read one line each, so the wizard can be scripted.
 */

import { createInterface } from "node:readline/promises";

export interface WizardIo {
  write(text: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

export function terminalWizardIo(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): WizardIo {
  const write = (text: string): void => {
    output.write(text);
  };
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input, output, terminal: input.isTTY === true });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
  const askSecret = async (question: string): Promise<string> => {
    if (input.isTTY !== true || typeof input.setRawMode !== "function") return ask(question);
    output.write(question);
    return new Promise<string>((resolve, reject) => {
      let value = "";
      input.setRawMode(true);
      input.resume();
      input.setEncoding("utf8");
      const done = (err: Error | null): void => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        output.write("\n");
        if (err) reject(err);
        else resolve(value.trim());
      };
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") return done(null);
          if (ch === "\u0003") return done(new Error("Cancelled"));
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      input.on("data", onData);
    });
  };
  return { write, ask, askSecret };
}

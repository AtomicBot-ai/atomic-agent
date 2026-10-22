import { createInterface } from "node:readline";

/**
 * The one reader of stdin for `atomic-agent run`. Every line is queued
 * the moment readline emits it and handed out in arrival order, to the
 * chat loop and to the approval prompt alike.
 *
 * A single reader matters for piped input: a driver that writes
 * "task", "y" and the next message at once has all three lines read
 * before the approval opens. A second reader for the approval (the old
 * shape) never saw the "y", and the main reader dropped every line read
 * while the approval was open, so the next message was lost (ATO-802).
 */
export interface StdinLineQueue {
  /**
   * The next line, in arrival order; `null` once input has ended and
   * every queued line was handed out. When nothing is queued and
   * `prompt` is given, it is shown before waiting.
   */
  next(prompt?: string): Promise<string | null>;
  /**
   * The line `next` would return, without taking it: it stays at the
   * head of the queue. Waits like `next` when nothing is queued; `null`
   * once input has ended and the queue is empty.
   */
  peek(prompt?: string): Promise<string | null>;
  /**
   * Stop reading; pending and later `next` calls resolve `null`. Safe to
   * call more than once.
   */
  close(): void;
}

export interface StdinLineQueueOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  terminal: boolean;
}

export function createStdinLineQueue(
  options: StdinLineQueueOptions,
): StdinLineQueue {
  const rl = createInterface(options);
  const lines: string[] = [];
  // A waiter that takes the line (`next`) or only looks at it (`peek`).
  // Peekers ahead of the first taker all see the line, which then stays
  // queued; the first taker in line gets it.
  const waiters: Array<{
    take: boolean;
    resolve: (line: string | null) => void;
  }> = [];
  let ended = false;
  rl.on("line", (line) => {
    while (waiters.length > 0 && !waiters[0]!.take) {
      waiters.shift()!.resolve(line);
    }
    const taker = waiters.shift();
    if (taker) taker.resolve(line);
    else lines.push(line);
  });
  rl.once("close", () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.resolve(null);
  });
  const wait = (take: boolean, prompt?: string): Promise<string | null> => {
    if (lines.length > 0) {
      return Promise.resolve(take ? lines.shift()! : lines[0]!);
    }
    if (ended) return Promise.resolve(null);
    if (prompt !== undefined) {
      rl.setPrompt(prompt);
      rl.prompt();
    }
    return new Promise((resolve) => waiters.push({ take, resolve }));
  };
  return {
    next(prompt) {
      return wait(true, prompt);
    },
    peek(prompt) {
      return wait(false, prompt);
    },
    close() {
      if (!ended) rl.close();
    },
  };
}

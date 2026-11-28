/**
 * Keeps the operator's messages in typing order while one of them is
 * still being expanded (ATO-2472). `@diff`, `@git:N`, a link or
 * `@problems` take a moment to read; a steer or queued message typed in
 * that moment must not reach the agent first. With nothing waiting a
 * message goes out at once, exactly as before.
 */

export interface OrderedSend {
  /** Hand `value` to `deliver` after every message still waiting. */
  send(value: string | Promise<string>, deliver: (text: string) => void): void;
  /** Whether a message is still waiting for its expansion. */
  readonly waiting: boolean;
}

export function createOrderedSend(): OrderedSend {
  let tail: Promise<void> | null = null;
  return {
    send(value, deliver) {
      if (tail === null && typeof value === "string") {
        deliver(value);
        return;
      }
      const prev: Promise<void> = tail ?? Promise.resolve();
      // The expansion never rejects (it falls back to the typed text);
      // a failed delivery must not stop the ones after it.
      const mine: Promise<void> = prev
        .then(() => value)
        .then((text) => deliver(text))
        .catch(() => undefined)
        .then(() => {
          if (tail === mine) tail = null;
        });
      tail = mine;
    },
    get waiting() {
      return tail !== null;
    },
  };
}

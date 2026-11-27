/**
 * How the terminal sends a message with `@` mentions (ATO-2472): plain
 * file mentions are inlined at once, as since ATO-665; a message with
 * `@diff`, `@git:N`, a range, a folder, a link or `@problems` is
 * expanded by the runtime's shared mention services (src/mentions/, the
 * same code behind the desktop's `POST /api/mentions/expand`) and sent
 * when that is done, in typing order with whatever is typed meanwhile.
 *
 * ATO-2796: the fallback (no runtime services, or a failed expansion)
 * applies core's rule too: the agent's own key and trust files
 * (`getStateSecretPaths`) are named, never inlined, so a chat whose folder
 * is the agent's state folder cannot send `@.env` to the model.
 */
import type { MentionServices } from "../../mentions/index.js";
import { DEFAULT_MENTION_LIMITS, expandFileMentions } from "../../mentions/expand-file-mentions.js";
import { protectedPathCheck } from "../../mentions/mention-services.js";
import { createOrderedSend } from "./ordered-send.js";

export interface MentionSender {
  /** The message to send: a string at once, or a promise while mentions are read. */
  expand(text: string): string | Promise<string>;
  /** Deliver a message (or its pending expansion) after the ones still waiting. */
  send(value: string | Promise<string>, deliver: (text: string) => void): void;
}

export function createMentionSender(
  mentions: MentionServices | undefined,
  workingDir: () => string,
  /** `getStateSecretPaths(config.paths)`: never inlined by the fallback. */
  protectedFiles: readonly string[],
): MentionSender {
  const order = createOrderedSend();
  const isProtected = protectedPathCheck(protectedFiles);
  const filesOnly = (text: string, dir: string): string =>
    expandFileMentions(text, dir, DEFAULT_MENTION_LIMITS, isProtected);
  return {
    expand(text) {
      const dir = workingDir();
      if (!mentions) return filesOnly(text, dir);
      const now = mentions.expandNow(text, dir);
      if (now !== null) return now;
      // Never rejects: a failed read sends the files alone, never nothing.
      return mentions.expand(text, dir).catch(() => filesOnly(text, dir));
    },
    send: (value, deliver) => order.send(value, deliver),
  };
}

/** Longest reason we carry: this lands in a chat notice and a feed line. */
const MAX_REASON_CHARS = 180;

/**
 * What the operator is told about a fallover.
 *
 * The message, not the class name. This used to answer `OpenAiHttpError`
 * — technically the error's `name`, and useless to the person deciding
 * what to do: it names the transport, never the refusal. The provider's
 * own text is the part that distinguishes "your key is wrong" from "you
 * are out of credit" from "the service is down", and those want three
 * different actions.
 *
 * Collapsed to one line and capped, because it is rendered inside a
 * notice and a feed row; the untruncated original is still on the error
 * the logger records.
 */
export function describeReason(err: unknown): string {
  const message =
    err && typeof err === "object" && "message" in err
      ? (err as { message?: unknown }).message
      : undefined;
  if (typeof message === "string" && message.trim().length > 0) {
    const line = message.replace(/\s+/g, " ").trim();
    return line.length > MAX_REASON_CHARS
      ? `${line.slice(0, MAX_REASON_CHARS - 1)}…`
      : line;
  }
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "provider unavailable";
}

/**
 * Messages a plugin command template produced, and what the person
 * actually typed after the command. A rendered message travels as a plain
 * string through the send and steer queues, so the words are recognised
 * here when the turn is recorded. Only the typed part may widen the read
 * scope: a path written in a template is the plugin's word, not the user's.
 */
const MAX_REMEMBERED = 64;

const typedArgsByText = new Map<string, string>();

export function rememberRenderedCommand(text: string, typedArgs: string): void {
  typedArgsByText.delete(text);
  typedArgsByText.set(text, typedArgs);
  if (typedArgsByText.size > MAX_REMEMBERED) {
    const oldest = typedArgsByText.keys().next().value;
    if (oldest !== undefined) typedArgsByText.delete(oldest);
  }
}

/** The typed arguments behind `text`, or undefined when the user wrote it all. */
export function typedArgsOfRendered(text: string): string | undefined {
  return typedArgsByText.get(text);
}

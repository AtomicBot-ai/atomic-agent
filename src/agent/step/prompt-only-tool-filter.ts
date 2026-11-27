// Import-free: the runtime marks a turn's filter, the step reads the mark.

const promptOnlyFilters = new WeakSet<(name: string) => boolean>();

/**
 * Mark a turn's `toolFilter` as prompt-only: it hides tools from the
 * prompt catalog and the native wire, and dispatch refuses them, but the
 * step does not narrow the grammar for it (`stepGrammarToolNames`). The
 * base grammar then goes out byte-identical, as it did before the filter
 * existed. Use it only for a filter that hides a few names on a turn that
 * had no filter at all (the board card tools on a chat turn, ATO-2497):
 * the grammar may still admit them, and a call to one gets the hidden
 * tool's refusal at dispatch.
 */
export function promptOnlyToolFilter(
  filter: (name: string) => boolean,
): (name: string) => boolean {
  promptOnlyFilters.add(filter);
  return filter;
}

export function isPromptOnlyToolFilter(filter: (name: string) => boolean): boolean {
  return promptOnlyFilters.has(filter);
}

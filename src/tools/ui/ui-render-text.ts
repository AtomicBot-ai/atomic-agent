import type { UiField, UiSpec } from "./ui-render-spec.js";

/**
 * The plain-text form of a `ui.render` spec (ATO-2457). It is the call's
 * result, so the model reads what it showed, and the terminal's tool card
 * prints it whole (tool-card-ui-text.tsx): the person there answers by
 * typing, by number or in words. The desktop draws the spec itself.
 */

function fieldLine(f: UiField): string {
  const kind = f.type === "select" ? `one of: ${(f.options ?? []).join(", ")}` : f.type;
  const flags = [kind, ...(f.required ? ["required"] : [])].join(", ");
  const start = f.value !== undefined && f.value !== "" ? ` [${f.value}]` : f.placeholder ? ` e.g. ${f.placeholder}` : "";
  return `  - ${f.label} (${flags})${start}`;
}

export function uiSpecText(spec: UiSpec): string {
  const lines: string[] = [];
  const head = spec.kind === "decision" ? "Choice" : spec.kind === "form" ? "Form" : "Cards";
  lines.push(`${head}: ${spec.title}`);
  if (spec.text) lines.push(spec.text);
  if (spec.kind === "decision") {
    (spec.options ?? []).forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${o.description ? `: ${o.description}` : ""}`));
  } else if (spec.kind === "form") {
    for (const f of spec.fields ?? []) lines.push(fieldLine(f));
    lines.push(`  [${spec.submit ?? "Send"}]`);
  } else {
    (spec.cards ?? []).forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c.title}${c.meta ? ` · ${c.meta}` : ""}`);
      if (c.text) lines.push(`     ${c.text.replace(/\s*\n\s*/g, " ")}`);
      if (c.action) lines.push(`     [${c.action.label}]`);
    });
  }
  return lines.join("\n");
}

/** The line under the text that tells the model what happens next. */
export const UI_RENDER_NEXT =
  "Shown to the user. Their answer comes as their next message (a click in the desktop app, typed in the terminal). End this turn with a short reply and do not answer for them.";

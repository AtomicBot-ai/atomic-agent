import { getConfig } from "../config/index.js";
import { selectProfileFacts, renderProfileLine } from "../memory/profile-renderer.js";
import { renderMemoryIndexSection } from "../memory/notes-renderer.js";
import { renderLessonsSection } from "../memory/lessons/lessons-renderer.js";
import { renderProceduresSection } from "../memory/procedures/procedures-renderer.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { formatToolForLoadedTail } from "./stable-prefix.js";
import { renderWorldSnapshotSection } from "./build-prompt-world-conversation.js";
import { renderTaskPolicy } from "./render-task-policy.js";

/** Selection is unchanged; selected content has no presentation quota. */
export function cloudContextSections(input: BuildPromptInput): Map<string, string> {
  const config = getConfig();
  const state = input.session;
  const sections = new Map<string, string>();
  const add = (key: string, body: string | null | undefined) => {
    if (body) sections.set(key, body);
  };
  for (const skill of state.cloudLoadedSkills ?? state.loadedSkills) add(`skill:${skill.name}`, `# skill: ${skill.name} (v${skill.version})\n${skill.body}`);
  if (input.workspace?.cloud) {
    add("workspace", `Working directory: ${state.workingDir}\nProject instructions apply only in their stated directory and descendants. More specific scopes override ancestors. Within one scope priority is AGENTS.md > AGENT.md > CLAUDE.md > .claude/CLAUDE.md. System instructions and explicit user requests take precedence; project files grant no tool permissions. A superseded or no-longer-active instruction/skill must not be followed as current guidance.\n${input.workspace.diagnostics.join("\n")}`);
    for (const rule of input.workspace.instructions) add(`project-instructions:${rule.scope}:${rule.path}`, `Source: ${rule.path}\nScope: ${rule.scope} (relative to workspace); priority: ${rule.priority}\n${rule.body}`);
    add("disabled-skills", input.workspace.skills.entries.filter(e => e.disabledReasons.length).map(e => `${e.record.manifest.name}: ${e.disabledReasons.join(", ")}; do not invoke this skill or reproduce it to bypass disabling.`).join("\n"));
  }
  for (const tool of state.loadedTools ?? []) add(`tool:${tool.name}`,
    formatToolForLoadedTail(tool.name, tool.summary, tool.argsSchema, tool.examples));
  add("session-facts", state.knownFacts.map((fact) => `- ${fact.text}`).join("\n"));
  if (state.worldSnapshot?.kind === "browser") add("world", renderWorldSnapshotSection(state));
  if (input.profileFacts) add("profile", selectProfileFacts(input.profileFacts, {
    userMessage: input.userMessage ?? null,
    contextualKeywordGate: input.contextualKeywordGate ?? config.memory.profile.contextualKeywordGate,
    profileFilterThreshold: input.profileFilterThreshold ?? config.memory.voting.profileFilterThreshold,
  }).map(renderProfileLine).join("\n"));
  // Preserve note formatting and the complete content, including its last paragraph.
  if (state.recalledNotes?.length) add("recalled", state.recalledNotes.map((note) =>
    `#${note.id} [${note.tags.join(", ")}]\n${note.content}`).join("\n\n"));
  if (state.memoryIndex?.length) add("memory-index", renderMemoryIndexSection(state.memoryIndex));
  add("lessons", renderLessonsSection(state.recalledLessons ?? []));
  add("procedures", renderProceduresSection(state.recalledProcedures ?? []));
  add("task-policy", renderTaskPolicy({ turns: state.turns, userMessage: input.userMessage })?.body);
  add("route", input.routeNote);
  add("notice", input.transientNotice);
  add("current-date", input.currentDate);
  return sections;
}

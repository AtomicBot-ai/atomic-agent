import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { applyNavSlot } from "../app-key-bindings.js";
import { useMouseCommands } from "../mouse/mouse-context.js";
import { MouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import {
  getCurrentSection,
  getDefaultTabForSection,
  SECTION_ORDER,
  type TuiSection,
} from "../section.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { getAppVersion } from "../../version.js";

interface StatusBarProps {
  state: TuiState;
}

/**
 * One-row operator status bar. Replaces the legacy `header-line` +
 * `status-line` + `footer-line` trio: only signal that needs to be
 * visible at every glance stays on screen — current section and a
 * short session id when one exists. Verbose details (full cwd, llama
 * URL, KV cache %, tools ok/err counters, approval flag) live in the
 * Observe / Manage sections instead.
 *
 * Turn status (idle / working spinner) and LLM health (`● llm gemma`)
 * used to live here too — they moved into the `PromptShell` meta-row
 * so the operator's eyes stay near the input area instead of jumping
 * between the top bar and the prompt to read the live signal. See
 * [src/tui/components/prompt-meta-status.tsx](src/tui/components/prompt-meta-status.tsx).
 */
export function StatusBar({ state }: StatusBarProps): ReactElement {
  const section = getCurrentSection(state);
  return (
    <Box>
      <Text color={theme.colors.accentSoft} bold>
        atomic-agent
      </Text>
      <Text color={theme.colors.muted}> v{getAppVersion()}</Text>
      <Sep />
      <SectionPills active={section} />
      <SessionTag sessionId={state.session.sessionId} />
    </Box>
  );
}

const SECTION_LABELS: Record<TuiSection, string> = {
  run: "Run",
  observe: "Observe",
  manage: "Manage",
};

/**
 * The Run / Observe / Manage switcher. Each pill is its own `<Box>`
 * rather than one flat `<Text>` run so the mouse layer can measure it:
 * a click lands on the pill the operator actually pointed at instead of
 * being reverse-engineered from label widths, which would break the
 * next time a label changes.
 */
function SectionPills({ active }: { active: TuiSection }): ReactElement {
  return (
    <Box flexWrap="wrap">
      {SECTION_ORDER.map((id, idx) => (
        <Box key={id} flexShrink={0}>
          <SectionPill id={id} active={active === id} />
          {idx < SECTION_ORDER.length - 1 ? (
            <Text color={theme.colors.muted}>
              {"  "}
              {theme.glyphs.dotSeparator}
              {"  "}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

function SectionPill({
  id,
  active,
}: {
  id: TuiSection;
  active: boolean;
}): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text
      color={active ? theme.colors.accentSoft : theme.colors.muted}
      bold={active}
    >
      {active ? `${theme.glyphs.chevronRight} ` : "  "}
      {SECTION_LABELS[id]}
    </Text>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // Clicking the section you are already in is a no-op rather
        // than a reset — it would otherwise throw away the sub-tab the
        // operator navigated to.
        if (!active) {
          applyNavSlot(
            mouse.dispatch,
            id === "run"
              ? { kind: "run" }
              : { kind: "debug-tab", tab: getDefaultTabForSection(id) },
          );
        }
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}

interface SessionTagProps {
  sessionId: string | null;
}

function SessionTag({ sessionId }: SessionTagProps): ReactElement | null {
  if (!sessionId) return null;
  return (
    <Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {theme.glyphs.pipeSeparator}
        {"  "}
        session{" "}
      </Text>
      <Text>{shortenId(sessionId)}</Text>
    </Text>
  );
}

function Sep(): ReactElement {
  return (
    <Text color={theme.colors.muted}>
      {"  "}
      {theme.glyphs.pipeSeparator}
      {"  "}
    </Text>
  );
}

function shortenId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}…`;
}

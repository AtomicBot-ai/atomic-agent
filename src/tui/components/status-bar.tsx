import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  getCurrentSection,
  SECTION_ORDER,
  type TuiSection,
} from "../section.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

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

function SectionPills({ active }: { active: TuiSection }): ReactElement {
  return (
    <Text>
      {SECTION_ORDER.map((id, idx) => {
        const isActive = id === active;
        return (
          <Text key={id}>
            <Text
              color={isActive ? theme.colors.accentSoft : theme.colors.muted}
              bold={isActive}
            >
              {isActive ? `${theme.glyphs.chevronRight} ` : "  "}
              {SECTION_LABELS[id]}
            </Text>
            {idx < SECTION_ORDER.length - 1 ? (
              <Text color={theme.colors.muted}>
                {"  "}
                {theme.glyphs.dotSeparator}
                {"  "}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Text>
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

import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { SkillInstallConfirmState } from "../skills/skills-panel-state.js";

export interface SkillsInstallConfirmProps {
  confirm: SkillInstallConfirmState;
  installing: boolean;
}

const MAX_FINDINGS_SHOWN = 6;

/**
 * Pre-install confirmation overlay shown when a staged skill's security
 * scan returns a non-`ok` verdict. Lists the findings so the operator
 * can review before committing. `y` installs, `n`/Esc cancels.
 */
export function SkillsInstallConfirm(
  props: SkillsInstallConfirmProps,
): ReactElement {
  const { confirm, installing } = props;
  const danger = confirm.verdict === "dangerous";
  const borderColor = danger ? theme.colors.error : theme.colors.warn;
  const shown = confirm.findings.slice(0, MAX_FINDINGS_SHOWN);
  const hidden = confirm.findings.length - shown.length;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text color={borderColor} bold>
        Security scan: {confirm.verdict.toUpperCase()}
      </Text>
      <Text color={theme.colors.muted}>install {confirm.identifier}?</Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((f, idx) => (
          <Text key={`${f.file}:${f.line}:${idx}`}>
            <Text
              color={
                f.severity === "dangerous"
                  ? theme.colors.error
                  : theme.colors.warn
              }
            >
              [{f.rule}]
            </Text>{" "}
            <Text color={theme.colors.muted}>
              {f.file}:{f.line}
            </Text>{" "}
            {f.excerpt}
          </Text>
        ))}
        {hidden > 0 ? (
          <Text color={theme.colors.muted}>… {hidden} more</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        {installing ? (
          <Text color={theme.colors.muted}>installing…</Text>
        ) : (
          <Text color={theme.colors.muted}>
            {danger
              ? "[y] install anyway (risk acknowledged)  [n] cancel"
              : "[y] install  [n] cancel"}
          </Text>
        )}
      </Box>
    </Box>
  );
}

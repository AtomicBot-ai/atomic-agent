import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { SkillRemoveConfirmState } from "../skills/skills-panel-state.js";

export interface SkillsRemoveConfirmProps {
  confirm: SkillRemoveConfirmState;
}

/**
 * Uninstall confirmation overlay. Deletes the global skill directory on
 * `y`/Enter, cancels on `n`/Esc. Bundled starters get an extra warning
 * because the bootstrap seeder re-copies them on the next launch — for
 * those, `disable` is usually what the operator actually wants.
 */
export function SkillsRemoveConfirm(
  props: SkillsRemoveConfirmProps,
): ReactElement {
  const { confirm } = props;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.error}
      paddingX={1}
    >
      <Text color={theme.colors.error} bold>
        Remove skill
      </Text>
      <Text color={theme.colors.muted}>
        delete global skill {confirm.name}?
      </Text>
      {confirm.isStarter ? (
        <Box marginTop={1}>
          <Text color={theme.colors.warn}>
            ! bundled starter — it will be re-created on the next start. Use
            disable (e) to hide it permanently instead.
          </Text>
        </Box>
      ) : null}
      {confirm.error ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>! {confirm.error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {confirm.submitting ? (
          <Text color={theme.colors.muted}>removing…</Text>
        ) : (
          <Text color={theme.colors.muted}>[y] delete · [n] cancel</Text>
        )}
      </Box>
    </Box>
  );
}

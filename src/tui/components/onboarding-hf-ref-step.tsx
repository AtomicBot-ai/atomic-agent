import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { MultiLineEditor } from "./multi-line-editor.js";

/**
 * Name a model on Hugging Face. Whatever the operator has on the
 * clipboard — the repo page, a link straight to one `.gguf`, or the id
 * on its own — should work, so the examples show all three rather than
 * teaching one canonical form.
 *
 * Everything that can go wrong here (a repo with no GGUF in it, a gated
 * one, a typo) is reported on this screen, because this is the screen
 * that asked the question.
 */
export function OnboardingHuggingFaceRefStep(props: {
  value: string;
  busy: boolean;
  error: string | null;
  onChange(value: string): void;
  onSubmit(value: string): void;
  onBack(): void;
}): ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        Which model? <Text color={theme.colors.muted}>(it has to be a GGUF build)</Text>
      </Text>
      <Text color={theme.colors.muted}>
        unsloth/Qwen3.5-4B-GGUF · https://huggingface.co/owner/repo · a link to one .gguf
      </Text>
      <Box marginTop={1}>
        <MultiLineEditor
          value={props.value}
          focus={!props.busy}
          disabled={props.busy}
          placeholder="owner/repo"
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          onEscape={props.onBack}
        />
      </Box>
      {props.busy ? (
        <Text color={theme.colors.muted}>asking huggingface.co…</Text>
      ) : null}
      {props.error ? (
        <Box marginTop={1} width={72}>
          <Text color={theme.colors.error} wrap="wrap">
            {props.error}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { ProvidersPanelState } from "../providers/providers-panel-state.js";
import { ProvidersWizard } from "./providers-wizard.js";
import { SUBSCRIPTION_CLI_KIND } from "../../config/provider-auth-mode.js";

export function ProvidersPanel(props: {
  panel: ProvidersPanelState;
}): ReactElement {
  if (props.panel.wizard !== null) {
    return <ProvidersWizard wizard={props.panel.wizard} />;
  }

  if (props.panel.removeConfirm !== null) {
    const id = props.panel.removeConfirm.id;
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.colors.error}
        paddingX={1}
        marginY={1}
        width="100%"
      >
        <Text bold color={theme.colors.error}>
          Remove provider {id}?
        </Text>
        <Text color={theme.colors.muted}>y confirm · n/Esc cancel</Text>
      </Box>
    );
  }

  const lines: string[] = ["Providers (text LLM + embeddings)", ""];
  if (props.panel.statusLine) {
    lines.push(props.panel.statusLine, "");
  }
  if (props.panel.rows.length === 0) {
    lines.push("(no providers — press n to add OpenRouter or OpenAI-compatible)");
  } else {
    props.panel.rows.forEach((row, i) => {
      const mark = i === props.panel.cursor ? ">" : " ";
      const flags = [
        row.isActiveText ? "TEXT*" : "",
        row.isActiveEmbedding ? "EMB*" : "",
        row.kind === SUBSCRIPTION_CLI_KIND
          ? "cli auth"
          : row.hasApiKey
            ? "key"
            : "no-key",
      ]
        .filter(Boolean)
        .join(" ");
      const models = [
        row.chatModel ? `chat:${row.chatModel}` : "",
        row.embeddingModel ? `embed:${row.embeddingModel}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `${mark} ${row.id} [${row.kind}] ${flags}${models ? ` · ${models}` : ""}`,
      );
    });
  }
  lines.push(
    "",
    "j/k move · n add · c configure cloud · d remove",
    "t active text · e active embedding · r refresh",
  );

  return (
    <Box flexDirection="column" width="100%">
      <Text>{lines.join("\n")}</Text>
    </Box>
  );
}

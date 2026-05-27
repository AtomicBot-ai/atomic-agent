import { Box, Text, useInput } from "ink";
import { useCallback, useState, type ReactElement } from "react";
import { handleProvidersWizardKey } from "../providers/providers-wizard-key-bindings.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import { saveProviderWizardToConfig } from "../providers/save-provider-wizard.js";
import { theme } from "../theme/theme.js";
import { ProvidersWizard } from "./providers-wizard.js";

export type CloudProviderOnboardingOutcome = "saved_cloud" | "aborted";

export function CloudProviderOnboarding(props: {
  onFinished(outcome: CloudProviderOnboardingOutcome): void;
  onBack(): void;
}): ReactElement {
  const [wizard, setWizard] = useState<ProvidersWizardState>(() =>
    createProvidersWizardState("add"),
  );
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    (nextWizard: ProvidersWizardState) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        saveProviderWizardToConfig(nextWizard);
        props.onFinished("saved_cloud");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setWizard({ ...nextWizard, error: message, submitting: false });
        setSubmitting(false);
      }
    },
    [props, submitting],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      props.onFinished("aborted");
      return;
    }
    const activeWizard = { ...wizard, submitting };
    const result = handleProvidersWizardKey(input, key, activeWizard);
    if (!result.handled) return;
    if ("closed" in result) {
      props.onBack();
      return;
    }
    if (result.submit) {
      submit(result.wizard);
      return;
    }
    setWizard(result.wizard);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.colors.accentSoft}>
        Cloud LLM provider setup
      </Text>
      <Text color={theme.colors.muted}>
        Configure a cloud text provider now. Esc returns to backend choice.
      </Text>
      <ProvidersWizard wizard={{ ...wizard, submitting }} />
    </Box>
  );
}

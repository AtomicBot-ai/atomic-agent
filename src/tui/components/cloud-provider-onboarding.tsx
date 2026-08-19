import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { handleProvidersWizardKey } from "../providers/providers-wizard-key-bindings.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import { saveProviderWizardToConfig } from "../providers/save-provider-wizard.js";
import { verifyWizardBeforeSave } from "../providers/verify-wizard-before-save.js";
import { theme } from "../theme/theme.js";
import { ProvidersWizard } from "./providers-wizard.js";

export type CloudProviderOnboardingOutcome = "saved_cloud" | "aborted";

export function CloudProviderOnboarding(props: {
  /** `notice` carries a key that was saved without a completed check. */
  onFinished(outcome: CloudProviderOnboardingOutcome, notice?: string): void;
  onBack(): void;
}): ReactElement {
  const [wizard, setWizard] = useState<ProvidersWizardState>(() =>
    createProvidersWizardState("add"),
  );
  const [submitting, setSubmitting] = useState(false);
  const verifyAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    return () => {
      alive.current = false;
      verifyAbort.current?.abort();
    };
  }, []);

  const submit = useCallback(
    async (nextWizard: ProvidersWizardState) => {
      if (submitting) return;
      setSubmitting(true);
      const abort = new AbortController();
      verifyAbort.current = abort;
      try {
        // First run goes through the same gate as the Providers tab, so
        // a dead key cannot be the one the agent starts life with.
        const gate = await verifyWizardBeforeSave(nextWizard, {
          signal: abort.signal,
        });
        if (!alive.current) return;
        if (!gate.proceed) {
          setWizard({ ...nextWizard, error: gate.error, submitting: false });
          setSubmitting(false);
          return;
        }
        saveProviderWizardToConfig(nextWizard);
        props.onFinished("saved_cloud", gate.warning ?? undefined);
      } catch (err) {
        if (!alive.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setWizard({ ...nextWizard, error: message, submitting: false });
        setSubmitting(false);
      } finally {
        if (verifyAbort.current === abort) verifyAbort.current = null;
      }
    },
    [props, submitting],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      verifyAbort.current?.abort();
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
    if ("cancelSubmit" in result && result.cancelSubmit) {
      verifyAbort.current?.abort();
      verifyAbort.current = null;
      setSubmitting(false);
      setWizard({
        ...wizard,
        submitting: false,
        error: "Key check cancelled — press Enter to try again.",
      });
      return;
    }
    if ("submit" in result && result.submit) {
      void submit(result.wizard);
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

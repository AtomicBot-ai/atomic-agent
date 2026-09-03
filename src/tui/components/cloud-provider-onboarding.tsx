import { Box, Text, useInput, type Key } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { returnKey } from "../mouse/synthetic-key.js";
import { handleProvidersWizardKey } from "../providers/providers-wizard-key-bindings.js";
import type { WizardMouseRoute } from "../providers/route-wizard-key.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import { saveProviderWizardToConfig } from "../providers/save-provider-wizard.js";
import { verifyWizardBeforeSave } from "../providers/verify-wizard-before-save.js";
import { probeWizardContract } from "../providers/probe-wizard-contract.js";
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

  /**
   * Whether the check this controller belongs to may still touch the
   * screen or the config. Asked again after every await, at both exits.
   *
   * `alive` alone answers a different question: Esc and Ctrl+C both end
   * a check without unmounting anything, so a mounted component says
   * nothing about whether its operator still wants the answer. Nor does
   * a verdict — `verifyProviderKey` samples the signal at the top of
   * each probe and in the fetch catch, so an abort landing between the
   * response arriving and `classifyVerifyResponse` returning still comes
   * back as an ordinary `ok`/`rate_limited`. The Providers-tab twin
   * carries this guard in `completeWizard` for the same reason.
   *
   * A run superseded by the operator's retry is covered because
   * `cancelSubmit` is the only thing that frees the wizard for a second
   * check and it aborts first: no cancel, no second run.
   */
  const checkStillWanted = useCallback(
    (abort: AbortController): boolean =>
      alive.current && !abort.signal.aborted,
    [],
  );

  const submit = useCallback(
    async (nextWizard: ProvidersWizardState) => {
      // Re-entry is guarded on the ref, not on `submitting`: that state
      // is captured in this closure, and the cancel handler resets it
      // while the check it cancelled is still resolving, so Enter after
      // Esc read a stale `false`. So did two key events drained from
      // stdin in one turn, which started two checks racing to save the
      // same wizard — and neither was cancelled, so no post-await check
      // could tell them apart. The ref is written before the first await
      // and cleared only by the run that owns it, or by a cancel.
      if (verifyAbort.current) return;
      setSubmitting(true);
      const abort = new AbortController();
      verifyAbort.current = abort;
      try {
        // First run goes through the same gate as the Providers tab, so
        // a dead key cannot be the one the agent starts life with.
        const gate = await verifyWizardBeforeSave(nextWizard, {
          signal: abort.signal,
        });
        if (!checkStillWanted(abort)) return;
        if (!gate.proceed) {
          setWizard({ ...nextWizard, error: gate.error, submitting: false });
          setSubmitting(false);
          return;
        }
        // The key is good; whether the route can run a turn is a
        // separate question, and first-run is exactly where getting it
        // wrong costs the most — the operator's first message is
        // otherwise the test. Advisory only: it cannot stop the save,
        // and it rides the same abort, so Esc still abandons the whole
        // submit with nothing written.
        const contract = await probeWizardContract(nextWizard, {
          signal: abort.signal,
        });
        if (!checkStillWanted(abort)) return;
        saveProviderWizardToConfig(nextWizard);
        const notes = [gate.warning, contract.warning].filter(
          (note): note is string => Boolean(note),
        );
        props.onFinished(
          "saved_cloud",
          notes.length > 0 ? notes.join(" ") : undefined,
        );
      } catch (err) {
        // An abandoned run does not get to report a failure either: it
        // would paint over the screen the operator was handed back, and
        // free `submitting` under a check that is still running.
        if (!checkStillWanted(abort)) return;
        const message = err instanceof Error ? err.message : String(err);
        setWizard({ ...nextWizard, error: message, submitting: false });
        setSubmitting(false);
      } finally {
        if (verifyAbort.current === abort) verifyAbort.current = null;
      }
    },
    [checkStillWanted, props],
  );

  /**
   * The one key-routing path, for both drivers: `useInput` passes the
   * live keystroke, a row click passes the Enter it stands for. The
   * wizard to act on is an argument rather than the closure's state
   * because the click path must act on the wizard its frame drew (see
   * `WizardMouseRoute`) — which here is `{ ...wizard, submitting }`,
   * the object the render below hands `ProvidersWizard`.
   */
  const routeKey = useCallback(
    (input: string, key: Key, activeWizard: ProvidersWizardState): void => {
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
          ...activeWizard,
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
    },
    [props, submit],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      verifyAbort.current?.abort();
      props.onFinished("aborted");
      return;
    }
    routeKey(input, key, { ...wizard, submitting });
  });

  /**
   * Row clicks act on this screen's wizard, which lives in the state
   * above — the default store route would target `providersPanel.wizard`,
   * a slice this screen never writes, and every click would be a no-op
   * or drive somebody else's wizard.
   */
  const mouseRoute = useMemo<WizardMouseRoute>(
    () => ({
      select: (_mouse, frameWizard, cursor) =>
        setWizard({ ...frameWizard, cursor }),
      activate: (_mouse, frameWizard) => routeKey("", returnKey(), frameWizard),
    }),
    [routeKey],
  );

  return (
    <Box flexDirection="column" padding={1}>
      {/* Ink, not a ground: `accent`, for the reason `renderLineField` gives. */}
      <Text bold color={theme.colors.accent}>
        Cloud LLM provider setup
      </Text>
      <Text color={theme.colors.muted}>
        Configure a cloud text provider now. Esc returns to backend choice.
      </Text>
      <ProvidersWizard wizard={{ ...wizard, submitting }} mouseRoute={mouseRoute} />
    </Box>
  );
}

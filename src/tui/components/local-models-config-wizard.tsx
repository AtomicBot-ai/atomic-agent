import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useState, type ReactElement } from "react";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import {
  normalizeLocalLlmBaseUrl,
  persistUserLocalModelsConfig,
  persistUserLocalLlmUrl,
} from "../persist-user-local-models-config.js";
import { theme } from "../theme/theme.js";
import { MultiLineEditor } from "./multi-line-editor.js";

export type LocalModelsWizardOutcome =
  | "saved_external"
  | "saved_managed"
  | "skipped"
  | "aborted";

export interface LocalModelsConfigWizardProps {
  initialUrl: string;
  probeError: string | null;
  onFinished(outcome: LocalModelsWizardOutcome): void;
}

type WizardPhase = "pick" | "url";

interface WizardOption {
  label: string;
  action: "external" | "managed";
}

const PICK_OPTIONS: readonly WizardOption[] = [
  { label: "Enter external URL (current mode)", action: "external" },
  {
    label: "Managed mode — pick a model in the Models tab to download",
    action: "managed",
  },
];

/**
 * First-run Ink screen when llama-server `/health` is unreachable.
 * Pick external URL flow or switch to managed mode, then exit.
 */
export function LocalModelsConfigWizard({
  initialUrl,
  probeError,
  onFinished,
}: LocalModelsConfigWizardProps): ReactElement {
  const app = useApp();
  const [phase, setPhase] = useState<WizardPhase>("pick");
  const [cursor, setCursor] = useState(0);
  const [line, setLine] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const finish = useCallback(
    (outcome: LocalModelsWizardOutcome) => {
      onFinished(outcome);
      app.exit();
    },
    [app, onFinished],
  );

  const commitPick = useCallback(
    (action: WizardOption["action"]) => {
      if (action === "external") {
        setPhase("url");
        return;
      }
      persistUserLocalModelsConfig({ mode: "managed" });
      finish("saved_managed");
    },
    [finish],
  );

  useInput(
    (input, key) => {
      if (phase !== "pick") return;
      if (key.ctrl && input === "c") {
        finish("aborted");
        return;
      }
      if (key.escape) {
        finish("skipped");
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => (c - 1 + PICK_OPTIONS.length) % PICK_OPTIONS.length);
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((c) => (c + 1) % PICK_OPTIONS.length);
        return;
      }
      if (key.return) {
        const opt = PICK_OPTIONS[cursor];
        if (opt) commitPick(opt.action);
        return;
      }
      if (input === "1" || input === "2") {
        const idx = Number(input) - 1;
        const opt = PICK_OPTIONS[idx];
        if (opt) {
          setCursor(idx);
          commitPick(opt.action);
        }
      }
    },
    { isActive: phase === "pick" },
  );

  const trySave = useCallback(
    async (bufferOverride?: string) => {
      if (busy) return;
      setBusy(true);
      setHint(null);
      const source = bufferOverride ?? line;
      try {
        const base = normalizeLocalLlmBaseUrl(source);
        const health = await checkLlamaServer({
          url: base,
          retries: 0,
          backoffMs: 0,
          timeoutMs: 5000,
        });
        if (!health.reachable) {
          setHint(health.error ?? "health check failed");
          return;
        }
        persistUserLocalLlmUrl(base);
        finish("saved_external");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setHint(msg);
      } finally {
        setBusy(false);
      }
    },
    [busy, finish, line],
  );

  if (phase === "pick") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={theme.colors.accentSoft}>
          llama-server not reachable
        </Text>
        {probeError ? (
          <Text color={theme.colors.muted}>last error: {probeError}</Text>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {PICK_OPTIONS.map((opt, idx) => {
            const selected = idx === cursor;
            return (
              <Text key={opt.action} color={selected ? theme.colors.accent : undefined}>
                {selected ? "› " : "  "}
                [{idx + 1}] {opt.label}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            ↑/↓ (j/k) move · Enter select · 1-2 shortcut · Esc skip · Ctrl+C exit
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.colors.accentSoft}>
        llama-server not reachable
      </Text>
      {probeError ? (
        <Text color={theme.colors.muted}>last error: {probeError}</Text>
      ) : null}
      <Text>
        Set the HTTP base URL of your running{" "}
        <Text bold>llama-server</Text> (must answer GET /health).
      </Text>
      <Box marginTop={1}>
        <MultiLineEditor
          value={line}
          focus={!busy}
          disabled={busy}
          placeholder="http://127.0.0.1:8080"
          onChange={setLine}
          onSubmit={(buffer) => {
            void trySave(buffer);
          }}
          onEscape={() => finish("skipped")}
          onInterrupt={() => {
            if (!busy) finish("aborted");
          }}
        />
      </Box>
      {busy ? <Text color={theme.colors.muted}>probing /health…</Text> : null}
      {hint ? <Text color="red">{hint}</Text> : null}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          Enter: test & save to config · Esc: skip · Ctrl+C: exit
        </Text>
      </Box>
    </Box>
  );
}

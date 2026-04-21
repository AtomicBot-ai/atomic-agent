import { Box, Text, useApp } from "ink";
import { useCallback, useState, type ReactElement } from "react";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import { theme } from "../theme/theme.js";
import { MultiLineEditor } from "./multi-line-editor.js";
import { normalizeLlamaBaseUrl, persistUserLlamaUrl } from "../persist-user-llama-url.js";

export type LlamaWizardOutcome = "saved" | "skipped" | "aborted";

export interface LlamaConfigWizardProps {
  initialUrl: string;
  probeError: string | null;
  onFinished(outcome: LlamaWizardOutcome): void;
}

/**
 * First-run Ink screen shown before the main TUI alt buffer when
 * llama-server `/health` is unreachable. Enter runs a probe + persists;
 * Esc skips; Ctrl+C aborts the whole `tui` command.
 */
export function LlamaConfigWizard({
  initialUrl,
  probeError,
  onFinished,
}: LlamaConfigWizardProps): ReactElement {
  const app = useApp();
  const [line, setLine] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const finish = useCallback(
    (outcome: LlamaWizardOutcome) => {
      onFinished(outcome);
      app.exit();
    },
    [app, onFinished],
  );

  const trySave = useCallback(async (bufferOverride?: string) => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    const source = bufferOverride ?? line;
    try {
      const base = normalizeLlamaBaseUrl(source);
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
      persistUserLlamaUrl(base);
      finish("saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setHint(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, finish, line]);

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

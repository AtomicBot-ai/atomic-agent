import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useState, type ReactElement } from "react";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import {
  normalizeLocalLlmBaseUrl,
  persistUserLocalModelsConfig,
  persistUserRemoteLlmUrls,
} from "../persist-user-local-models-config.js";
import { theme } from "../theme/theme.js";
import { CloudProviderOnboarding } from "./cloud-provider-onboarding.js";
import { MultiLineEditor } from "./multi-line-editor.js";

export type LocalModelsWizardOutcome =
  | "saved_external"
  | "saved_managed"
  | "saved_cloud"
  | "skipped"
  | "aborted";

export interface LocalModelsConfigWizardProps {
  initialUrl: string;
  probeError: string | null;
  /**
   * Whether the user had already opted into a local backend before this run.
   * `false` on a fresh install, where the probe failed against a default URL
   * nobody chose — there the screen is a setup prompt, not a fault report,
   * and leading with "not reachable" plus a raw ECONNREFUSED reads as if the
   * install is broken. `true` keeps the honest diagnostic for the user whose
   * configured server really did stop answering.
   */
  hadConfiguredBackend?: boolean;
  onFinished(outcome: LocalModelsWizardOutcome): void;
}

type WizardPhase = "pick" | "remote-chat-url" | "remote-embedding-url" | "cloud";

interface WizardOption {
  label: string;
  action: "cloud" | "external" | "managed";
}

const PICK_OPTIONS: readonly WizardOption[] = [
  {
    label: "Local models (llama.cpp) — download and run locally",
    action: "managed",
  },
  { label: "Cloud models — configure API key and pick a model", action: "cloud" },
  {
    label: "Remote llama.cpp — enter an existing llama-server URL",
    action: "external",
  },
];

/**
 * First-run Ink screen when llama-server `/health` is unreachable.
 * Pick a local, cloud, or remote llama.cpp flow, then exit.
 */
export function LocalModelsConfigWizard({
  initialUrl,
  probeError,
  hadConfiguredBackend = false,
  onFinished,
}: LocalModelsConfigWizardProps): ReactElement {
  const app = useApp();
  const [phase, setPhase] = useState<WizardPhase>("pick");
  const [cursor, setCursor] = useState(0);
  const [chatUrlLine, setChatUrlLine] = useState(initialUrl);
  const [embeddingUrlLine, setEmbeddingUrlLine] = useState("");
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
      if (action === "cloud") {
        setPhase("cloud");
        return;
      }
      if (action === "external") {
        setPhase("remote-chat-url");
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
      if (input === "1" || input === "2" || input === "3") {
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

  const trySaveChatUrl = useCallback(
    async (bufferOverride?: string) => {
      if (busy) return;
      setBusy(true);
      setHint(null);
      const source = bufferOverride ?? chatUrlLine;
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
        setChatUrlLine(base);
        setPhase("remote-embedding-url");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setHint(msg);
      } finally {
        setBusy(false);
      }
    },
    [busy, chatUrlLine],
  );

  const trySaveEmbeddingUrl = useCallback(
    async (bufferOverride?: string) => {
      if (busy) return;
      setBusy(true);
      setHint(null);
      const source = bufferOverride ?? embeddingUrlLine;
      try {
        const chatUrl = normalizeLocalLlmBaseUrl(chatUrlLine);
        if (source.trim().length === 0) {
          persistUserRemoteLlmUrls({ chatUrl });
          finish("saved_external");
          return;
        }
        const embeddingUrl = normalizeLocalLlmBaseUrl(source);
        const health = await checkLlamaServer({
          url: embeddingUrl,
          retries: 0,
          backoffMs: 0,
          timeoutMs: 5000,
        });
        if (!health.reachable) {
          setHint(health.error ?? "health check failed");
          return;
        }
        persistUserRemoteLlmUrls({ chatUrl, embeddingUrl });
        finish("saved_external");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setHint(msg);
      } finally {
        setBusy(false);
      }
    },
    [busy, chatUrlLine, embeddingUrlLine, finish],
  );

  if (phase === "pick") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={theme.colors.accentSoft}>
          {hadConfiguredBackend
            ? "llama-server not reachable"
            : "Choose how atomic-agent should run models"}
        </Text>
        {hadConfiguredBackend && probeError ? (
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
            ↑/↓ (j/k) move · Enter select · 1-3 shortcut · Esc skip · Ctrl+C exit
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase === "cloud") {
    return (
      <CloudProviderOnboarding
        onFinished={finish}
        onBack={() => {
          setPhase("pick");
        }}
      />
    );
  }

  const isEmbeddingStep = phase === "remote-embedding-url";
  const editorValue = isEmbeddingStep ? embeddingUrlLine : chatUrlLine;
  const setEditorValue = isEmbeddingStep ? setEmbeddingUrlLine : setChatUrlLine;
  const submitEditor = isEmbeddingStep ? trySaveEmbeddingUrl : trySaveChatUrl;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.colors.accentSoft}>
        llama-server not reachable
      </Text>
      {probeError ? (
        <Text color={theme.colors.muted}>last error: {probeError}</Text>
      ) : null}
      <Text>
        {isEmbeddingStep
          ? "Set the HTTP base URL of your embedding-only "
          : "Set the HTTP base URL of your chat "}
        <Text bold>llama-server</Text> (must answer GET /health).
      </Text>
      {isEmbeddingStep ? (
        <Text color={theme.colors.muted}>
          Optional: leave empty to continue without hybrid embedding recall.
        </Text>
      ) : null}
      <Box marginTop={1}>
        <MultiLineEditor
          value={editorValue}
          focus={!busy}
          disabled={busy}
          placeholder={
            isEmbeddingStep ? "http://127.0.0.1:19092" : "http://127.0.0.1:8080"
          }
          onChange={setEditorValue}
          onSubmit={(buffer) => {
            void submitEditor(buffer);
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
          {isEmbeddingStep
            ? "Enter: test & save, empty Enter skips embeddings · Esc: skip · Ctrl+C: exit"
            : "Enter: test & continue to embedding URL · Esc: skip · Ctrl+C: exit"}
        </Text>
      </Box>
    </Box>
  );
}

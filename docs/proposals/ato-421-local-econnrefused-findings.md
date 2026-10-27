# ATO-421: local engine refuses connections (findings)

Status: findings, no code change
Owner: src/local-llm/

About 480 users see the managed local model never answer, with `ECONNREFUSED` on the local address. This note records what the code on `main` (v0.6.12) shows. No Sentry or PostHog data was available, so the cause is not pinned down and nothing was changed.

## What the code rules out

- Not an IPv6 `localhost` mix-up. Every managed URL is built as `http://127.0.0.1:<port>` (`src/config/load-config.ts`, `src/config/llm-provider-commands.ts`), and llama-server is started with `--host 127.0.0.1` (`src/local-llm/server/daemon-lifecycle.ts`). The word `localhost` in error reports is the host class from `src/error-reporting/classify-transport-host.ts`, not the URL.
- Not a port mismatch on Atomic Core. `loadCoreSession` asks Core for the configured port and rejects a session on any other port (`src/local-llm/core/core-sessions.ts`).
- Not one window stopping another window's model. Only the last live session stops the daemon with `stopOnExit`, and the desktop's child processes count as the desktop's own session (`src/local-llm/server/session-registry.ts`, ATO-416).
- Not Atomic Core retiring under the agent. The agent runs Core with the `cli` owner scope. The client-lease retirement (`app-lease.ts` in atomic-chat-core) applies to the app-owned Core only.

## What `ECONNREFUSED` means here

Nothing is listening on the model's port: the llama-server process is gone or was never started. Since ATO-772, a turn that hits this while the managed process is certainly dead ends after an 8-second grace with `local_engine_down` and the start command (`src/agent/turn/turn-recovery.ts`). Before ATO-772 it waited out the whole outage budget (about five minutes), which reads as "never answers". Main therefore already turns the symptom into a clear message. What is not known is why the process is gone.

## Likely causes, in the order to check

1. The process died after it started: a crash on load or during generation, an out-of-memory kill, or the Mac sleeping. `server-fault.ts` reads the current run's log for these. ATO-334 (#873) restarts after out-of-memory with half the window.
2. The engine cannot run on this machine at all. A macOS 15 or older Mac with the current TurboQuant build (minimum macOS 26, ATO-116, #947) or a Windows GPU build that crashes on load (ATO-344/372, #858) both look like a model that never comes up.
3. The model was never started. For example, `localModels.mode` is `external` with nothing at the URL, or the first-run start failed and the chat was used anyway.

## Data needed to decide

From Sentry, for the ATO-421 issue: the release (before or after ATO-772), the `local_engine_down` share, OS and OS version (especially macOS below 26), engine (`atomic-core` or `llama-server`), how long after the model start the first refusal came, and the last lines of `llama-server.log` where the event carries them. If most events come from macOS below 26 or from Windows GPU builds, #947 and #858 are the fix. If they predate ATO-772, the fix has already shipped.

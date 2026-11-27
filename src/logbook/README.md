# Logbook

Status: current
Owner: src/logbook/

A day journal from screenshots (ATO-2363), described only by a model on this computer. Precedents: OpenClaw's logbook plugin (state in `<state-dir>/logbook/`) and Screenpipe; the difference here is that no screenshot ever reaches a cloud model. Screenshots and their descriptions are made locally; notes you ask about go to your active model, and `logbook.query` asks first when that model is not on this computer (below).

## Switch

Off by default. [Settings](logbook-settings.ts) live in `<stateDir>/logbook/settings.json` (`enabled`, `intervalMinutes` 1..60 default 5, `retentionDays` 1..365 default 14, `pausedUntil`, `excludeApps`), not in config.json, so there is no config version bump and the CLI can change them while the agent runs. `atomic-agent logbook start|stop|pause|resume|status|today|show|clear|exclude|standup` ([logbook-command.ts](../cli/logbook-command.ts)) writes it. The TUI top bar shows `● logbook` while it is on and `◌ logbook paused` during a pause ([logbook-chip.tsx](../tui/components/logbook-chip.tsx)), re-read every 5 s.

## Capture loop

[logbook-sidecar.ts](logbook-sidecar.ts) is a scheduler sidecar ([runtime-logbook.ts](../runtime/composition/runtime-logbook.ts)), so only the process that leads the scheduler captures, and only a TUI process builds it (`indicatorVisible`, from `analyticsSurface === "tui"`): the TUI top bar is the one visible recording mark, so `serve`, the desktop's sidecar and one-shot CLI runs never capture, whatever the settings say. Each tick re-reads settings; one capture per interval, never two at once; a frame described after a stop or pause is dropped. Retention deletes old day files once an hour, on or off. macOS only: the runtime builds no sidecar elsewhere, because there is no front-app check yet.

[logbook-capture.ts](logbook-capture.ts), per frame: probe the front app; skip it when [logbook-skip.ts](logbook-skip.ts) says so (password managers, login and security prompts, a locked screen, system settings, Atomic Agent, script runners, an unidentified app, the person's `excludeApps`); `screencapture -x` into `<stateDir>/logbook/frames/` (0700); probe again and throw the picture away if a protected app came to the front; shrink to 1280 px; describe with the local model (one or two sentences, no secrets asked for, then masked with the secret detector and capped at 400 chars); delete the picture in every case. Leftover frames from a crash are removed before the first capture.

[logbook-local-vision.ts](logbook-local-vision.ts): a provider is used only when its config entry is on loopback (`llama-server` with a loopback `url`, or none and a loopback `localModels.url`; any other kind with a loopback `baseUrl`, such as Ollama or LM Studio) and its model can see (`capabilities.vision`). The active provider is tried first. No such provider: no screenshot, and `status.json` says why. There is no cloud fallback.

## Storage and reading

[logbook-store.ts](logbook-store.ts): one JSON line per note (`at`, `app`, `bundleId`, `text`) in `<stateDir>/logbook/YYYY-MM-DD.jsonl` (0600), by local day. No image is stored. Delete whole days (`clear --all|--day|--before`) or a time range of one day (`clear --day <d> --from HH:MM --to HH:MM`). [logbook-status.ts](logbook-status.ts) keeps the loop's last outcome in `status.json`.

[logbook-query.ts](logbook-query.ts) turns `day` (today, yesterday, YYYY-MM-DD), `part` (morning 0-12, afternoon 12-18, evening 18-24), `from`/`to` and `contains` into a window; over the limit it samples evenly. The `logbook.query` tool ([tool](../tools/logbook/logbook-query-tool.ts)) is read-only, framed as untrusted outside data (the notes describe whatever was on screen), asks under `logbook_cloud` (silent only at full trust, never settled by the risk reviewer) when the model serving the step or any model in `llm.fallback.chain` is not loopback by the test above (`logbookNotesStayLocal`; a loopback model never asks), and its descriptor is offered only while the logbook is on or keeps notes (`GATED_TOOLS.logbook`). The [standup recipe](../recipes/standup-recipe.ts) asks the agent to call it.

Checks: `npx vitest run src/logbook src/tools/logbook src/cli/logbook-command.test.ts src/recipes/standup-recipe.test.ts`.

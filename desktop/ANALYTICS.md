# Desktop analytics and error reports

What the desktop shell sends, how it is gated, and what it never sends. The
code is in `main/analytics/` (events), `main/sentry/` (error reports),
`renderer/analytics-acts.js` and `renderer/analytics.js` (the window's half),
and `preload/preload.ts` (`window.atomic.track` / `window.atomic.reportError`).

## The switch

- `analytics.enabled` in the desktop state dir's `config.json` (default true).
- If the desktop config does not set it, but the terminal agent's
  `~/.atomic-agent/config.json` says `analytics.enabled: false`, the desktop
  treats analytics as off and tells the agent it spawns the same.
- A config file that exists but cannot be parsed counts as off.
- Settings › Privacy applies live, no restart. Turning it off: the config
  write happens first; only if it succeeded is `analytics_disabled` sent and
  flushed (2 s at most), and then sending stops and the queue is dropped. A
  failed write changes nothing and sends nothing.
- With analytics off, the analytics code reads no config files.
- Test and dev runs send nothing and write nothing to the real home: VITEST,
  `NODE_ENV=test|development`, `--dev`, `--smoke*`, `--first-run-probe`,
  `--models`, `--remote-debugging-port*`, `--fake-ram=*`,
  `ATOMIC_DESKTOP_ANALYTICS=off`, and any unpackaged build (unless
  `ATOMIC_DESKTOP_ANALYTICS=on`). `ATOMIC_DESKTOP_ANALYTICS_LOG=1` echoes
  each event to stderr.

## Identity

- One install id per machine, shared with the terminal agent:
  `$ATOMIC_AGENT_INSTALL_ID_FILE`, else `~/.atomic-agent-install-id` (one
  UUID line, written atomically).
- Resolved once at startup, before the agent is spawned, in this order: the
  shared file; the `installId` in `~/.atomic-agent/analytics.json` (skipped
  when the terminal config opted out); the desktop state dir's
  `analytics.json`; a new UUID. The shared file is written only when
  analytics is on and the run is not a test or dev run.
- Once-flags live in `<desktop state dir>/desktop-analytics.json`
  (`installedAt`, `modelConfiguredSent`, `sessionOpen`). On a desktop that
  existed before this file (an upgrade) it starts with
  `modelConfiguredSent: true` and `installedAt: null`, so no fake first setup
  is reported and `days_since_install` is omitted.

## Environment passed to the agent

`agentEnv()` (`main/state-dir.ts`) adds:

| Variable | Value |
|---|---|
| `ATOMIC_AGENT_SURFACE` | `desktop` |
| `ATOMIC_AGENT_INSTALL_CHANNEL` | `dmg` / `exe` / `appimage` / `deb` |
| `ATOMIC_AGENT_DESKTOP_VERSION` | the app version, when known |
| `ATOMIC_AGENT_ANALYTICS` | `off` on a test or dev run, or when the terminal opt-out is inherited |
| `ATOMIC_AGENT_INSTALL_ID_FILE` | `<desktop state dir>/install-id` on a test or dev run; otherwise inherited unchanged |

## Global properties (every event)

`surface: desktop`, `platform`, `arch`, `desktop_version`, `install_channel`,
`run_mode` (`local` / `cloud` / `fusion`, when known). The transport adds
`$ip: 0.0.0.0`, `$geoip_disable: true`, `$lib: atomic-agent-desktop`.

## Event catalogue

`main/analytics/catalog.ts` is the one allowlist; value lists are in
`catalog-values.ts`. Unknown events and properties are dropped; an enum value
outside its list becomes `other` (or the property's fallback) or is dropped;
strings are at most 64 characters of `[a-zA-Z0-9_.:-]`. The renderer may only
send `ui` events.

| Group | Main process | Renderer |
|---|---|---|
| Lifecycle | `app_opened`, `app_ready`, `agent_start_failed`, `agent_restarted` (manual / switch / other), `window_crashed`, `app_closed`, `debug_report_saved`, `analytics_disabled` | |
| Setup | `provider_key_checked` (ok / rejected / unreachable / payment_required), `model_configured` | `onboarding_step`, `onboarding_skipped`, `model_picked`, `provider_setup_started`, `provider_setup_failed`, `custom_endpoint_tested` |
| Models and backend | `model_download_started`, `model_download_finished`, `hf_lookup`, `llama_runtime_updated`, `local_backend_started`, `backend_switched`, `fusion_configured` | |
| Chat | `chat_turn_ui` | `message_action`, `approval_answered`, `coding_mode_changed`, `plan_handoff` |
| Features | `voice_used`, `voice_setup`, `task_created`, `task_action`, `skill_installed`, `skill_action`, `telegram_setup` (enable / token_saved / token_cleared / owner_cleared), `import_run`, `workspace_chosen` | `ui_action`, `slash_command_used`, `settings_pane_viewed`, `session_action`, `mcp_server_added`, `mcp_server_action` |

Notes on specific properties:

- `ui_action.action`: the act's verb plus allowlisted tails only
  (`renderer/analytics-acts.js`); main accepts camelCase segments, at most
  three, and refuses any segment that looks like an id (a UUID, a hex run
  containing digits, four or more digits, or a bare number other than the
  Fusion worker count in `runmode:workers:1`..`8`). Capped at 200 per app
  session.
- `model_picked.host_ram_gb`: `"8"` (12 GB or less), `"16"` (24 or less),
  `"32"` (48 or less), `"64"`, or null. `model_id` is a curated catalogue id,
  else `custom`.
- `quant`: an upper-cased GGUF tag (`Q4_K_M`, `IQ3_XXS`, `F16`, `BF16`,
  `MXFP4`), else `unknown`. `locale`: `en` or `en-US` shaped, else dropped.
- `backend_switched`: only for an explicit switch (`cli:switchBackend`,
  `cli:enterFusion`) or when the effective run mode actually changed.
- `model_configured` and `analytics_disabled` are runtime events in the
  agent's schema; the shell sends them because the bundled agent does not
  under `atag serve`. `model_configured.provider` is `llama.cpp` for the
  managed local backend, a preset id for cloud, `custom` for a custom
  endpoint; `kind` is local / cloud / custom. Once per desktop state dir.

Transport: PostHog `/batch/` over `fetch`, batched in memory, flushed every
10 s; at quit up to five batches of 100, bounded at 2 s in total (also when
no agent is running).

## Error reports (Sentry)

- A hand-built envelope per error (`main/sentry/`), no SDK and no Electron
  crashReporter: minidumps carry process memory (chat text, keys) and
  absolute module paths, so none are produced or uploaded.
- Caught: main-process uncaught exceptions and rejections, renderer
  `error` / `unhandledrejection`, `render-process-gone`, `child-process-gone`,
  `unresponsive`, `did-fail-load` (main frame, error code only),
  `preload-error`, and the agent exiting unexpectedly (tags only).
- Scrubbing: the message is dropped (no message type is allowlisted); the
  type is kept only when it matches `SomethingError` / `SomethingException`
  or is one of the shell's own names, else `Error`; a renderer value that is
  not an `Error` is `NonError`. The stack's `Name: message` header is cut off
  before frames are read; each frame keeps file basename, line, column and
  function only; at most 30 frames.
- Every event: `platform: node`, `sdk.settings.infer_ip: never`,
  `user: {id: <install id>, ip_address: null}`, tags `surface`, `component`,
  `desktop_version`, `install_channel`, `run_mode`, `platform`, `arch`, plus
  `kind` / `reason` / `exit_code` enums. At most 30 reports per session,
  3 per signature.
- DSN: `ATOMIC_DESKTOP_SENTRY_DSN`, else the agent's. Same switch as
  analytics.

## Never sent

Message or prompt text, error messages, stderr, file paths, URLs (custom
endpoints, Hugging Face repo or file names), API keys, tokens or headers,
session / task / memory ids, MCP server names, skill names, chat titles,
voice transcripts, slash command arguments, process argv or environment, the
IP address (`$ip` is `0.0.0.0`, GeoIP is off).

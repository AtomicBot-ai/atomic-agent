# OS tools

Status: current
Owner: src/tools/os/

The registry wires filesystem, shell, web, git, process and document tools. Preserve dispatch approval, read scope, declared-input protection, restore manifests and detached shell-job semantics. Paths are resolved relative to workingDir with supported home expansion. Project location resolution searches known project sources; it is not an unrestricted arbitrary-disk scan.

Web search/fetch has provider-specific extraction, challenge detection and HTTP retry/timeout boundaries. Reading a page and browser interaction are different operations; do not silently substitute navigation for text retrieval. SSRF and response limits belong to dispatch/transport guards.

Read [tool instructions](../AGENTS.md), [contracts](../docs/contracts.md), [OS registry](index.ts), [fetch](web/web-fetch.ts), [search](web-search/index.ts), [project location](fs/fs-locate-project.ts), and [shell](shell/shell.ts). Tests live beside each tool; run affected tools/os tests and the resource-class/schema completeness tests for catalog changes.

## Operation owners

- [Filesystem](fs/README.md): operations, input/read/approval guards, restore store and project location.
- [Shell](shell/README.md): execution, timeout/detach and job registry; existing [command guard](shell-command-guard/index.ts) retains policy rules and its adjacent test.
- [Web/HTTP](web/README.md): fetch/extraction/challenges/SSRF and request transports; [web search](web-search/index.ts) retains provider orchestration and consumes shared HTTP helpers.
- Existing [archive](archive/index.ts), [document reading](read-document/index.ts), [git](git/README.md) and [process tools](proc/index.ts) retain their owners.

Root index intentionally composes and exports registrations in the previous order. Clipboard/email/notify/window platform tools and expand-home remain root operations/shared path support; they do not acquire filesystem/shell/web state. Tool names, descriptors, schemas and agent resource classes are unchanged.

## Screen control (macOS)

[`screen/`](screen/index.ts) owns `os.screen.capture`, `os.screen.click`, `os.screen.type` and `os.screen.key` (ATO-525). They are opt-in: registered, and kept in the prompt, only when `tools.screen.enabled` is `true` (default `false`, read at start) and the host is macOS; Windows and Linux are ATO-527. No new dependency: `screencapture` and `sips` make the picture, one constant JXA program (`osascript -l JavaScript`) posts CoreGraphics mouse and keyboard events. What it acts on travels as JSON in `ATOMIC_SCREEN_PAYLOAD`, never spliced into script source, and the child gets an allow-listed environment.

- Capture saves a JPEG under `.atomic-screens/` in the working folder, long side capped at 1280 px, and reports the image-pixel-per-point scale (and region origin). Tool results are text, so a model sees the picture through `vision.describe` on that path; a model that cannot see gets `vision.describe`'s usual refusal. A Screen Recording grant missing (`CGPreflightScreenCaptureAccess`) or an empty capture returns a message naming the host app and the System Settings pane.
- Click takes the image's pixel x,y; the session's last capture maps them back to points (an explicit `scale` overrides it). Type sends text as Unicode key events, at most 2000 characters per call. Key parses chords such as `cmd+shift+t` into ANSI key codes.
- Every input call first probes Accessibility (`AXIsProcessTrusted`) and the frontmost app: no grant means an actionable error and no prompt. Then it asks as `screen_control` (silent from level 4, like `shell`; grantable per session), with a preview naming the action, the screen point and the frontmost app; typed text shows its length and first 40 characters unless it looks like a token. The action refuses if another app came to the front after the approval.
- All four share one serial resource class, so a batched click and capture run in emitted order. Nothing stops the model from typing into the terminal that runs the agent; the per-call approval preview is the guard.

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

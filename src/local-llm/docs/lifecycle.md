# Managed server ownership

Status: current
Owner: src/local-llm/

External mode connects to an operator-provided llama-server. Managed mode uses model/backend installation, launch records and daemon lifecycle. The server process and model weights remain separate from the TypeScript runtime.

Preserve launch ownership, port checks, records, health/model capability probes, restart behavior and stopOnExit. A live daemon discovered through a record is not necessarily a process this caller may kill. Capability/window/prefix-reuse decisions come from server/GGUF metadata and platform selection. Throughput is measured when available rather than fabricated.

Sources: [daemon lifecycle](../server/daemon-lifecycle.ts), [launch guard](../server/daemon-launch-guard.ts), [port holder](../server/port-holder.ts), [GGUF metadata](../catalog/gguf-metadata.ts), [backend selection](../backend/platform-assets.ts). Tests: [lifecycle](../server/daemon-lifecycle.test.ts), [metadata](../catalog/gguf-metadata.test.ts).

## Atomic Core engine

`localModels.managed.engine` selects `llama-server` (the compatible default for existing configurations) or `atomic-core`. Choose it with `atomic-agent models engine atomic-core` or `/model engine atomic-core` in the TUI, with local models stopped. The same downloaded GGUFs, native completion/grammar protocol, context sizing and optional embedding model remain available. `models engine llama-server` switches back without deleting model weights.

`models update` installs the host-supported Core release and asks Core's backend catalog to select and install the inference binary. `models engine check` checks release metadata without installing. Core updates are explicit; `managed.autoUpdate` continues to apply only to the legacy engine. A newer release outside the supported version list is reported as requiring a newer Agent build. Startup with an installed Core does not download an engine or run a synthetic generation.

The host follows Atomic Chat's authenticated control contract: a private, CLI-scoped Core in `<models data dir>/core/versions/<version>/data`, exact version/protocol handshake, client registration with heartbeats, backend catalog/install, model load/unload and download progress events. CLI scope lets a one-shot `models start` leave a warm model available. Telemetry is disabled for this managed Core. The public Core API listener is not enabled.

Model inference goes directly to the port and key returned by Core, preserving `/completion`, `/props`, `/apply-template` and `/slots`. Session keys stay in owner-only records and are used only for matching loopback endpoints. Core owns its children: normal teardown and cancellation use authenticated control operations rather than sending signals to a recorded model PID.

Installations verify GitHub SHA256SUMS and the executable version before activation. Failed or cancelled downloads leave the current install intact. Mutating engine operations are serialized across frontends; checks do not acquire the long operation lock. Updates refuse while Core has model sessions. Interrupted operations can recover a dead owner through an exclusive acquisition gate; a crash during that brief gate requires removing the named stale gate with Agent closed.

[Core adapter](../core/core-client.ts), [installation](../core/core-install.ts), [session lifecycle](../core/core-sessions.ts), [contract tests](../core/core-contract.test.ts), [cancellation tests](../core/core-sessions.test.ts).

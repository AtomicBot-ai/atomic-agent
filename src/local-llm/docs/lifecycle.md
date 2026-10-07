# Managed server ownership

Status: current
Owner: src/local-llm/

External mode connects to an operator-provided llama-server. Managed mode uses model/backend installation, launch records and daemon lifecycle. The server process and model weights remain separate from the TypeScript runtime.

Preserve launch ownership, port checks, records, health/model capability probes, restart behavior and stopOnExit. A live daemon discovered through a record is not necessarily a process this caller may kill. Capability/window/prefix-reuse decisions come from server/GGUF metadata and platform selection. Throughput is measured when available rather than fabricated.

Sources: [daemon lifecycle](../server/daemon-lifecycle.ts), [launch guard](../server/daemon-launch-guard.ts), [port holder](../server/port-holder.ts), [GGUF metadata](../catalog/gguf-metadata.ts), [backend selection](../backend/platform-assets.ts). Tests: [lifecycle](../server/daemon-lifecycle.test.ts), [metadata](../catalog/gguf-metadata.test.ts).

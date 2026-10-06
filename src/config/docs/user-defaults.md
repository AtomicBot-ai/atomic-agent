# User configuration defaults

Status: current
Owner: src/config/

Checked snapshot of primitive USER_CONFIG_DEFAULTS values for config version 74. Environment overrides and migrations can change an installed value. This is the documented default surface checked by the defaults test; the parser and [schema](../config-schema.ts) remain the implementation authority. Objects and array contents are not flattened into invented config keys. Read [compatibility](compatibility.md) for migration and precedence.

## version

- `version` (default `74`).

## localModels

- `localModels.url` (default `"http://127.0.0.1:8080"`).
- `localModels.mode` (default `"external"`).
- `localModels.completionMaxTokens` (default `16384`).
- `localModels.useServerTemplate` (default `"auto"`).
- `localModels.thinking` (default `"auto"`).
- `localModels.reasoningBudgetTokens` (default `1500`).
- `localModels.managed.modelId` (default `null`).
- `localModels.managed.port` (default `19091`).
- `localModels.managed.dataDirOverride` (default `null`).
- `localModels.managed.autoUpdate` (default `true`).
- `localModels.managed.stopOnExit` (default `true`).
- `localModels.managed.autoRestart` (default `true`).
- `localModels.managed.device` (default `"auto"`).
- `localModels.managed.backendVariant` (default `"auto"`).
- `localModels.managed.contextSize` (default `0`).
- `localModels.managed.parallel` (default `"auto"`).
- `localModels.managed.swaFull` (default `"auto"`).
- `localModels.embeddings.enabled` (default `false`).
- `localModels.embeddings.modelId` (default `null`).
- `localModels.embeddings.port` (default `19092`).
- `localModels.embeddings.url` (default `"http://127.0.0.1:19092"`).
- `localModels.download.connections` (default `16`).
- `localModels.download.hfEndpoint` (default `"https://huggingface.co"`).

## log

- `log.level` (default `"info"`).

## agent

- `agent.tokenBudget` (default `3000`).
- `agent.maxSteps` (default `25`).
- `agent.providerWait.enabled` (default `true`).
- `agent.providerWait.maxWaitMs` (default `300000`).
- `agent.task.maxSteps` (default `1000`).
- `agent.task.maxDurationMs` (default `7200000`).
- `agent.task.autoContinue` (default `true`).
- `agent.toolTimeoutMs` (default `60000`).
- `agent.readScope` (default `"working-dir"`).
- `agent.approvalLevel` (default `1`).
- `agent.conversationMaxTokens` (default `0`).
- `agent.conversationMaxPairs` (default `200`).
- `agent.nameSessions` (default `true`).
- `agent.conversationLowWater` (default `0.65`).
- `agent.sessionSectionsMaxTokens` (default `0`).
- `agent.worldSnapshotMaxTokens` (default `8000`).

## http

- `http.enabled` (default `true`).
- `http.approvalMode` (default `"never"`).
- `http.hostAllowlist` (default `null`).
- `http.maxResponseBytes` (default `1048576`).
- `http.defaultTimeoutMs` (default `30000`).

## web

- `web.search.enabled` (default `true`).
- `web.search.provider` (default `"exa"`).
- `web.search.maxResults` (default `8`).
- `web.search.timeoutMs` (default `15000`).
- `web.search.cacheTtlMinutes` (default `60`).
- `web.search.persistCache` (default `true`).
- `web.search.searxng.instanceUrl` (default `null`).
- `web.search.exa.endpoint` (default `"https://mcp.exa.ai/mcp"`).
- `web.search.exa.apiEndpoint` (default `"https://api.exa.ai/search"`).
- `web.search.exa.apiKeyEnv` (default `"EXA_API_KEY"`).
- `web.search.brave.apiKeyEnv` (default `"BRAVE_SEARCH_API_KEY"`).
- `web.fetch.timeoutMs` (default `30000`).
- `web.fetch.connectTimeoutMs` (default `10000`).
- `web.fetch.maxRetries` (default `2`).
- `web.fetch.retryBaseDelayMs` (default `500`).
- `web.fetch.retryMaxDelayMs` (default `5000`).

## tools

- `tools.shell.defaultTimeoutMs` (default `600000`).
- `tools.shell.jobMaxMs` (default `3600000`).
- `tools.shell.maxJobs` (default `3`).

## sessions

- `sessions.retention.enabled` (default `false`).
- `sessions.retention.maxAgeDays` (default `90`).
- `sessions.retention.maxRows` (default `null`).

## tracing

- `tracing.trace.enabled` (default `null`).
- `tracing.trace.maxBytesPerSession` (default `10485760`).

## memory

- `memory.profile.enabled` (default `true`).
- `memory.profile.maxTokens` (default `512`).
- `memory.profile.contextualKeywordGate` (default `true`).
- `memory.profile.maxEntries` (default `500`).
- `memory.reflection.enabled` (default `true`).
- `memory.reflection.timeoutMs` (default `60000`).
- `memory.reflection.maxFactsPerCall` (default `3`).
- `memory.reflection.autoStoreNotes` (default `true`).
- `memory.reflection.maxNotesPerCall` (default `2`).
- `memory.reflection.typedNotes.enabled` (default `false`).
- `memory.reflection.anySpeaker` (default `false`).
- `memory.reflection.segmentation.enabled` (default `false`).
- `memory.reflection.segmentation.triggerEveryTurns` (default `3`).
- `memory.reflection.segmentation.windowTurns` (default `5`).
- `memory.notes.enabled` (default `true`).
- `memory.notes.maxEntries` (default `1000`).
- `memory.notes.maxContentChars` (default `4000`).
- `memory.notes.recallDefaultK` (default `5`).
- `memory.recallInjection.enabled` (default `true`).
- `memory.recallInjection.k` (default `3`).
- `memory.recallInjection.previewChars` (default `160`).
- `memory.recallInjection.maxTokens` (default `400`).
- `memory.index.enabled` (default `true`).
- `memory.index.limit` (default `20`).
- `memory.index.previewChars` (default `60`).
- `memory.index.maxTokens` (default `300`).
- `memory.dedup.enabled` (default `true`).
- `memory.dedup.fts5Threshold` (default `0.85`).
- `memory.eviction.utilityWeighted` (default `true`).
- `memory.eviction.maxAgeMs` (default `2592000000`).
- `memory.embeddings.enabled` (default `false`).
- `memory.embeddings.fts5Weight` (default `0.5`).
- `memory.embeddings.vectorWeight` (default `0.5`).
- `memory.embeddings.bruteForceCeiling` (default `200`).
- `memory.links.enabled` (default `true`).
- `memory.links.autoGenerate` (default `true`).
- `memory.links.expansionDepth` (default `1`).
- `memory.links.maxExpanded` (default `12`).
- `memory.links.maxLinksPerCall` (default `4`).
- `memory.links.minCandidates` (default `2`).
- `memory.links.generatorTimeoutMs` (default `60000`).
- `memory.evolution.enabled` (default `true`).
- `memory.evolution.maxPerWrite` (default `2`).
- `memory.evolution.leaseMs` (default `60000`).
- `memory.lessons.enabled` (default `true`).
- `memory.lessons.recallK` (default `2`).
- `memory.lessons.maxTokens` (default `300`).
- `memory.lessons.indexLimit` (default `20`).
- `memory.lessons.maxEntries` (default `500`).
- `memory.lessons.deprecationAgeMs` (default `2592000000`).
- `memory.procedures.enabled` (default `true`).
- `memory.procedures.recallK` (default `2`).
- `memory.procedures.maxTokens` (default `400`).
- `memory.procedures.indexLimit` (default `20`).
- `memory.procedures.maxEntries` (default `500`).
- `memory.procedures.deprecationAgeMs` (default `2592000000`).
- `memory.consolidation.enabled` (default `true`).
- `memory.consolidation.intervalMs` (default `21600000`).
- `memory.consolidation.cooldownMs` (default `86400000`).
- `memory.consolidation.minClusterSize` (default `3`).
- `memory.consolidation.maxClustersPerTick` (default `5`).
- `memory.consolidation.requireSharedTag` (default `true`).
- `memory.consolidation.distillTimeoutMs` (default `45000`).
- `memory.voting.enabled` (default `true`).
- `memory.voting.maxVotePerItem` (default `50`).
- `memory.voting.signalDecay` (default `0.95`).
- `memory.voting.scoreBlend` (default `0.6`).
- `memory.voting.eventLogMaxRows` (default `50000`).
- `memory.voting.profileFilterThreshold` (default `3`).
- `memory.retrieve.rewriter.enabled` (default `true`).
- `memory.retrieve.rewriter.timeoutMs` (default `10000`).
- `memory.retrieve.rewriter.historyTurns` (default `3`).
- `memory.retrieve.rewriter.gateMode` (default `"heuristic"`).
- `memory.retrieve.rewriter.embeddingGate.threshold` (default `0.65`).
- `memory.retrieve.rewriter.embeddingGate.exemplars` (default `null`).

## vision

- `vision.enabled` (default `true`).
- `vision.autoDetect` (default `true`).
- `vision.maxImageBytes` (default `8388608`).
- `vision.maxImagesPerCall` (default `4`).

## skills

- `skills.catalogTokenBudget` (default `512`).
- `skills.clawhub.enabled` (default `true`).
- `skills.clawhub.apiBase` (default `"https://clawhub.ai"`).
- `skills.clawhub.browseLimit` (default `100`).
- `skills.clawhub.nonSuspiciousOnly` (default `true`).

## tui

- `tui.theme` (default `"auto"`).
- `tui.whileBusySubmit` (default `"steer"`).
- `tui.mouse` (default `true`).
- `tui.notify.enabled` (default `true`).
- `tui.notify.minDurationMs` (default `30000`).
- `tui.onboarding.completedAt` (default `null`).
- `tui.onboarding.importOfferedAt` (default `null`).
- `tui.onboarding.introSeenAt` (default `null`).
- `tui.onboarding.localSetupSeenAt` (default `null`).
- `tui.onboarding.proposedSecondBackendAt` (default `null`).
- `tui.onboarding.skippedAt` (default `null`).

## analytics

- `analytics.enabled` (default `true`).

## telegram

- `telegram.enabled` (default `false`).
- `telegram.ownerUserId` (default `null`).
- `telegram.parseMode` (default `"html"`).
- `telegram.progressIndicator` (default `true`).

## discord

- `discord.enabled` (default `false`).

## notifications

- `notifications.downloads.channel` (default `null`).

## atomicMail

- `atomicMail.address` (default `null`).
- `atomicMail.accountId` (default `null`).
- `atomicMail.ownerEmail` (default `null`).
- `atomicMail.ownerVerifiedAt` (default `null`).
- `atomicMail.pendingVerification` (default `null`).

## git

- `git.remoteSync` (default `false`).

## composio

- `composio.enabled` (default `true`).
- `composio.apiKeyEnv` (default `"COMPOSIO_API_KEY"`).
- `composio.userId` (default `null`).
- `composio.sessionId` (default `null`).
- `composio.mcpUrl` (default `null`).

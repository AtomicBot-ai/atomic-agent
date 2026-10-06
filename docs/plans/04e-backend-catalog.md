# 04e: backend и catalog local-llm

Status: verified
Owner: repository maintainers

[Этап 04](04-local-llm-tools-os.md). После общей приёмки OS: 1042 suites / 12445 passed / 4 прежних skips, type debt 878. Пользователь разрешил параллельную разработку; downloads и server выполняются отдельными владельцами, один интегратор обновляет общие входы, внешние consumers, документацию и ledger.

## Цель и карта

Собрать backend acquisition/platform/hardware и model metadata по ответственности. Общая injective old/new карта сохранена в `/tmp/atomic-stage04-local-llm-move-map.json`; этот срез владеет только её backend и catalog строками.

- backend: 11 source + 10 tests — backend-installer, staging/version, ensure-latest-backend, cpu-backend-fallback, platform-assets, Windows/Linux ARM64 variants, gpu-devices, gpu-memory-budget, nvidia-smi-vram.
- catalog: 8 source + 6 tests + gguf-metadata.fixtures.ts — models-catalog, GGUF metadata, huggingface API/endpoint/fit/model-def/ref/resolve. Fixture не является runtime metadata implementation.
- Root index.ts — намеренный публичный контракт; backend-paths — общий disk layout; chat-templates — source/SEA asset resolver с привязкой к глубине файла. Они остаются на месте. Backend consume server update/fallback; catalog имеет type-only server/context-size dependency. Не запрещать существующие подтверждённые связи целыми каталогами.

## Контракты и порядок

Читать local-llm/config/runtime/TUI инструкции и guides/lifecycle/downloads. Сохранять bytes всех алгоритмов/constants/URLs/schema/export names/order: platform selection, asset release cache/TTL/rate limits/staging/rollback, GPU facts, GGUF IO bounds/cache/prefix policies, curated/custom IDs, HF repo/path/hidden shards/MTP/mmproj и RAM warning semantics. Не запускать реальные downloads, backend install/server/GPU probes; не менять package/dependencies/config/defaults/persisted layout.

До moves отдельно устранить шесть существующих diagnostics: два явных проверенных доступа devices[0] устраняют три unchecked-index cases без изменения expect calls; три fixture GpuDevice получают freeMemMiB:0, соответствующий parse default для неизвестного свободного объёма. Существующие budget/pick calculations используют totalMemMiB; все прежние поля/значения и assertions остаются прежними. Без casts, allowances или compiler options. Ledger reduce выполняет интегратор.

Common before snapshot: `/tmp/atomic-stage04cde-before`. После cleanup сохранить owned-only snapshot и repairs manifest; 36 modules переносить строго по общей карте. AST mover меняет только import/export/import-type/dynamic/mock module literals; одинаковые URL/test data не менять. Все outgoing edges получают общие конечные paths даже если соседний agent ещё не закончил перенос. Сохранить точные positions/substitutions и source proof. Все outside/root consumers принадлежат интегратору; новых barrels и старых forwarding modules нет.

README обоих owners объясняет state/resources/seams и проверки. Focused backend/catalog suites запускать после разрешения imports; interim missing paths не считать behavioral failures или green acceptance. Итог: lint/type/import/docs/source proof, config/LLM/CLI/TUI seams, build path smoke и full CI принимает интегратор. 04 verified только после общей приёмки; реальные platform/manual/network проверки остаются явно непроверенными.

[Итоговая приёмка параллельной фазы и этапа 04](../testing/stage-04-validation.md).

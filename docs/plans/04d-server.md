# Этап 04d: server lifecycle и политика ресурсов

Status: verified
Owner: repository maintainers

[Общий этап](04-local-llm-tools-os.md). Определён после приёмки OS; реализация выполняется параллельно с downloads и catalog/backend по общей карте. Итоговые внешние imports, root index, type ledger и общую приёмку обновляет один интегратор.

## Область и механизм

Перенести 11 source modules и 11 соседних tests из корня local-llm в server/: daemon-lifecycle, daemon-launch-guard, port-holder, port-reclaim, managed-api-key, session-registry, server-fault, log-tail, worker-slots, context-size, swa-full. Последние три принадлежат запуску: они рассчитывают context/KV budget, стоимость SWA/prefix reuse и число worker slots. Root index, backend-paths и chat-templates сохраняют свой контракт и расположение.

Перенос механический: только import/export/import() type/dynamic/mock/require module literals. Сохранять external/managed distinction, launch records и ownership перед kill/reclaim; port/session gates; owner-only API key/Windows ACL; health/model readiness; chat/embedding startup/shutdown order, throughput reuse basis/age, stopOnExit, отмену, context/SWA/slot formulas, persisted paths, argv/env и все остальные literals. Существующий daemon monolith не разделять на алгоритмы в этом срезе. Серверные tests не имеют зарегистрированного type debt; fixture cleanup не нужен.

## Последовательность

1. Использовать общий snapshot /tmp/atomic-stage04cde-before; зафиксировать exact map и module-literal edits для 22 файлов.
2. Перенести только server owner; свои outgoing paths направить на существующие исходные locations других owners. После остальных переносов интегратор ретаргетит cross-owner и external consumers.
3. Создать English server/README: entry points, state/resource ownership, lifecycle/resource policies, cross-domain seams и настоящие checks. Общие docs/scripts/ledger не редактировать.
4. Сравнить все 22 исходника/test bytes со snapshot после применения только зафиксированных module-literal substitutions; остальное должно совпасть точно.
5. После интеграции проверить server suites и affected CLI/TUI/LLM/config/memory/runtime/prompt seams, production lint/type debt/import cycles/docs/full CI. До integration не считать ожидаемые missing cross-owner imports ошибкой алгоритма или успешной проверкой.

## Приёмка

22 старых modules отсутствуют без forwarding/barrels; тела и assertions совпадают, root API/форматы/пути/процессная политика сохраняются. 0 новых type errors/runtime cycles/ownership exceptions. Evidence и verified status только после итоговых checks интегратора. Реальные daemon launch/kill, network downloads, GPU/platform probes и пользовательское состояние не используются для проверки; existing mocks/temporary fixtures достаточны для этого mechanical slice. Platform/manual checks остаются отдельно.

[Итоговая приёмка параллельной фазы и этапа 04](../testing/stage-04-validation.md).

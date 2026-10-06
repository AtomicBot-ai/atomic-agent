# Этап 04c: downloads local-llm

Status: verified
Owner: repository maintainers

[Этап 04](04-local-llm-tools-os.md). OS принят; downloads подготавливается параллельно server/catalog/backend. Один интегратор обновляет общие consumers, public index, документацию и debt ledger и выполняет итоговую приёмку.

## Цель и границы

Собрать 17 source modules и 12 suites из фактической карты в `src/local-llm/downloads/`, сохранив exports, worker argv/env, durable paths, transfer/resume/pair алгоритмы и tool/UI contracts. Model installer использует прежний общий transfer; backend installer остаётся отдельным владельцем. Root backend-paths/chat-templates/index сохраняют свою ответственность; новые barrels/forwarding modules не создаются.

## Последовательность

1. Отдельно исправить 16 existing diagnostics в fixtures: unused import, mutable typed callback holders, проверенные array accesses и недостающие normalized job fields. Сохранить прежние явные значения/expect calls без casts/allowances/options.
2. Сохранить post-fixture snapshot, выполнить 29 механических переносов. Менять только AST module literals, учитывая общую конечную карту cross-owner imports. Передать old/new/position manifest и exact fixture-repair records интегратору; внешние consumers не менять параллельными агентами.
3. Создать английский README с transfer, persisted jobs/partial/notify, detached worker/pair, catalog/settings и ownership ресурсов. Подтвердить описания текущими исходниками.
4. Проверить exact bodies после literal substitutions и неизменность всех прежних expect calls. Выполнить доступные download/model-installer suites; промежуточные missing cross-owner imports не выдавать за финальную проверку.

## Приёмка

После интеграции проходят focused downloads, CLI/runtime self-invocation/notifications/TUI seams и общий lint/type/import/docs/full CI runner. Долг уменьшается только по реально устранённым cases; нет новых SCC/allowances. Worker запускается через прежний `models pull-worker`, detached job не заменяется из-за открытия UI, partial/resume/pair сохраняются при restart. Никаких настоящих downloads, installs/server starts, network verification, dependency/public API/default/persisted-format изменений. Status verified ставится только после общей evidence.

[Итоговая приёмка параллельной фазы и этапа 04](../testing/stage-04-validation.md).

# Срез 05a: общая проверка значений конфигурации

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Leaf `src/config/config-primitives.ts` получает два coercers и девять scalar parsers. Bodies и класс ошибки сохраняются; composing schema импортирует только используемые functions и сохраняет прежние девять public exports. Existing consumers продолжают работать без массовой замены imports.

[Приёмка 05a](../testing/stage-05a-validation.md) выполнена; следующий [05b](05b-session-rail-config.md) specified, implementation не начата.

## Работы и приёмка

1. До extraction snapshot всех src/scripts/docs, defaults, 369 scalar cases, 76 file-parser cases, protected/package/compiler hashes.
2. Перенести functions с комментариями; не менять user/runtime types, defaults, миграции, USER_CONFIG_VERSION=74, env precedence и parseUserConfigFile.
3. Сравнить AST statements/bodies и public export names, scalar/default/file outputs и все остальные TS/TSX bytes с snapshot. Ошибки сохраняют identity, field/reason/message; сохранить различия null/undefined/zero, bool aliases и numeric string coercion.
4. Зафиксировать direct boundary leaf → composing schema/root API через import checker, включая type/dynamic imports; сначала negative failure, затем positive/negative self-tests. Error-owner import и schema → primitives разрешены. Это direct boundary, не transitive proof всех возможных импортов.
5. Существующие config tests и cross-owner seams, lint, full test types без нового долга, imports/docs/self-tests/quarantine/diff, build и full test:ci. Новые behavioral tests только при существенном пробеле; не дублировать implementation.
6. Записать фактическую приёмку; только после неё уточнить следующий domain slice. Parallel agents исследуют config callers и tool prototype без изменения общих файлов; extraction и integration имеют отдельные write sets.

## Границы

Этот срез не закрывает весь этап 05. Остальные parsers, domain types/default blocks/migrations и canonical tool contracts ещё предстоит разделить. Test ledger не rebased; protected `.pr-review-56/` и EVIDENCE_ROUTER_MODEL.md сохраняются. Runtime assembly, prompt/catalog text и algorithms не меняются.

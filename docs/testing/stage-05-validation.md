# Итоговая приёмка этапа 05: конфигурация и контракты

Status: current
Owner: repository maintainers

[План 05](../plans/05-config-tool-contracts.md), [последний блок и подробные проверки](stage-05l-validation.md). Этап организует ownership без изменения пользовательских форматов, defaults или алгоритмов; stage04 physical moves и stage00 instructions уже приняты отдельно.

## Результат

Root config-schema.ts сокращён с 6055 до 1521 строк. Доменные owners охватывают scalar values, session rail, webhooks/MCP, agent/execution/provider waiting, web, full memory/localModels, TUI/channels/integrations, HTTP/tools/skills/retention/tracing. [Карта config](../../src/config/README.md) ведёт к типам/default factories/two-phase parsers и совместимости. Root намеренно сохраняет whole-file assembly, порядок валидации, version74, ENV defaults и public compatibility API. Сохраняются mutable default references, getter/error order и отличие отсутствующего блока от явного значения; перенос не превращён в новую migration engine.

13 core filesystem operations имеют единый import-free metadata owner и чистые parsers по фактической границе. Пять contextual pipelines остаются у execution. [Карта FS](../../src/tools/os/fs/docs/contracts.md) объясняет конкретные owners; [global gate](../../src/tools/tool-contract-conformance.test.ts) ловит рассогласование canonical projections и missing/orphan/duplicate static facets. [Runtime seam](../../src/runtime/tool-contract-composition.test.ts) проверяет feature gates, deliberate wrappers и MCP boundaries. Никакой массовой генерации всех tool contracts, registry или policy из readonly нет.

## Совместимость и конечные проверки

Whole-stage old/current configuration comparison: 1602 values/version/error/default/export cases и 26 reference/getter scenarios identical. Полные defaults/ENV/version/result order сохранены. Все 87 публичных TypeScript symbols bidirectionally assignable; ordered recursive shapes и optional/readonly fields unchanged. Existing config migration/default/load and consumer suites проходят в полном runner. Field literals, captured defaults и migration seams дополнительно подтверждены source proofs отдельных блоков.

Final filesystem catalog/registration/roles/read-target/approval/native wire/strict-null/loaded schemas и 18 stable prefixes byte-identical. 05l existing production changes ограничены 12 operation consumers и 3 catalog/schema/class projections; остальные 2405 existing non-Markdown source files совпадают с immutable baseline. Protected .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md (24812 hashes), package/lock/compiler/CI/grammars сохранены. Обновлённые guide routes проверены для prompt/tool/migration/MCP UI/download.

Full PR-equivalent: 1059 suites, 12792 tests passed, 4 existing skips. lint/build passed; imports1386 modules/4987 edges/0 cycles/0 exceptions, checker self-tests188 passed; quarantine0 active/2 released, self-test8 passed. Test type gate848 explicit existing diagnostics, no new errors; stage05 сократил прежнюю базу856→848 исправлением genuine fixtures, без новых allowances. Подробные причины ранних failures и повторные проверки записаны в acceptance каждого блока и [05l](stage-05l-validation.md). Документы проверяются после сохранения статусов и следующего плана.

## Оставшиеся ограничения

Три существовавших Git descriptor duplicates сохранены точно: каталог88 entries/85 names. [Behavioral follow-up](../proposals/tool-catalog-deduplication.md) требует выбрать единое описание с проверкой discovery/native wire/cache. Это явный ограниченный долг, не «чистый каталог». Остальные tool families пока имеют свои прежние metadata owners; global gate доказывает presence/format/taxonomy, semantic equality — только для canonical13. Runtime JSON Schema не заменяет contextual/security validation.

Оставшийся типовой долг и4 existing skips видны; не выполнялись live provider/GPU/platform eval или одинаковый набор агентных задач для измерения скорости/качества. Уменьшение размера schema/context и улучшение навигации не объявляется измеренной производительностью. Следующие два этапа:06 runtime contract/composition/lifecycle, затем07 agent loop/recovery/policies/progress и итоговая оценка. Новые slices05 и переписывание остальных семейств для закрытия этапа не нужны.

Final documentation check: active links/metadata/pointers/archive coverage и instruction budgets проходят; 19 instruction files, maximum chain8093/24576 bytes. Docs self-test11 и git diff --check passed. Этап05 и05l verified; следующий [план06](../plans/06-runtime-composition.md) specified, без implementation.

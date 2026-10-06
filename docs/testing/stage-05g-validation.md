# Приёмка 05g: конфигурация web search/fetch

Status: verified
Owner: repository maintainers

[План 05g](../plans/05g-web-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06 после [05f](stage-05f-validation.md). Production/test/read-only agents работали параллельно с раздельными write sets; integrator владел снимками, dependency policy, guides и приёмкой.

## Результат

web-config.ts содержит три прежних публичных типа, два public helpers, fresh search/fetch default factories и internal two-phase composition API. Provider и raw provider-settings references готовятся в прежней ранней позиции; остальные search fields и fetch нормализуются в прежних поздних позициях. Каждый из 16 прежних fallback выражений отдельно получает текущий default через explicit lookup; short-circuiting и повторные searxng getter reads сохранены. Schema 5365 → 5124 строки, owner 305.

Корень сохраняет прежние type/helper exports; config/index, load-config, tools и остальные consumers не менялись. Defaults values/order/nested freshness, USER_CONFIG_VERSION=74, migrations/env precedence и runtime behavior сохранены. Из scalar imports root удалён только ставший unused parseNonNegativeBoundedInt; его публичный re-export остался. Search providers/cache/cooldowns и fetch/SSRF/retries/network/configless defaults остаются отдельными runtime owners.

## Доказательства и тесты

Snapshot /tmp/atomic-stage05g-before сделан после verified 05f до edits. Production proof сравнивает весь остальной root text после ровно 11 recorded transformations и нового import/export блока; три types/two helpers/owned comments exact. Fresh default literals/order/comments прежние. Early four statements и late search/fetch expressions эквивалентны после записанных raw/prepared aliases и 16 default-lookup substitutions; field/validation order совпадает. Private APIs/construction намеренно изменены, whole-parser byte identity не утверждается.

Actual old/new differential: 105 whole-root/direct-helper cases и пять reference/getter/ordering scenarios byte-identical. Включены full defaults/results/errors/class identity, invalid-field precedence, current-default getter timing, within-call nested/whole-web replacement, early raw reference retention, repeated searxng reads и finally restore. Совпали также 369 scalar cases и 76 version/file outputs с USER_CONFIG_DEFAULTS/ENV_DEFAULTS. Compiled smoke подтвердил root/owner function identity, nested freshness, error phase precedence и fallback order.

Parent proof: 87 root public names, 11 intentional owner exports; 2381 прочих прежних TS/TSX files неизменны, ровно два новых source/test файла. Package/lock/compiler/test-debt, protected .pr-review-56/EVIDENCE_ROUTER_MODEL.md hashes неизменны. Existing tests не редактировались; allowances/casts/dependencies не добавлены.

34 новых tests закрывают phase/default seams: early provider precedence против webhook/agent/http/late search/fetch, disabled validation, root/direct fallback omission/null/empty/order, exact errors, accepted non-URL/whitespace strings и permissive blocks, separate lookup/short-circuiting, within-call defaults replacement и repeated searxng reads. Initial checks поймали unused root import и несовместимый typed test object с Record input; оба исправлены удалением unused binding и concrete record fixture, без allowances. Final source/tests проверены заново.

## Проверки

- Existing schema: 219 passed; new suite: 34 passed.
- Focused config/CLI/OS registration/web/web-search: 45 suites, 855 tests passed.
- Full test:ci final: 1047 suites, 12564 passed, 4 existing platform/GC skips, exit 0, 47.76 s.
- lint/build и compiled smoke passed.
- typecheck:tests final: 2384 roots, 105 test TSX, прежние 854 explicit diagnostics, no new errors; ledger/compiler/checker unchanged.
- imports:check: 1357 modules, 4880 edges, 0 runtime SCC/exceptions. Self-test 72 passed: семь new fixtures, negatives сначала отказали на прежней policy; root/type/dynamic/tool/execution/transport edges запрещены, scalar/error inward edges разрешены. Rule ограничивает direct source dependencies, не bare packages/transitive loading.
- Docs self-test 11 passed; docs:check instruction budgets/links/metadata/pointers и diff passed после acceptance/next-plan save. Quarantine 0 active/2 released; registry/checker unchanged.

Artifacts /tmp/atomic-stage05g-{before,production-proof.mjs,production-extraction.json,proof.mjs,web-capture.mjs,web-before.json,web-after.json,*-tests.txt,*-types*.txt}. New captures/tests parse synthetic input, без live providers/user credentials/network. Full runner использует существующие approved HTTP/installation fixtures. No paid/GPU/manual platform eval; агентная скорость/качество не измерялась. Differential не исчерпывает все inputs; exact source proofs и existing seams дополняют его. 05g verified; весь этап 05 ещё in-progress.

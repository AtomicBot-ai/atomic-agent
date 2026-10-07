# Приёмка 05i: весь домен конфигурации localModels

Status: verified
Owner: repository maintainers

[План 05i](../plans/05i-local-models-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06 после [05h](stage-05h-validation.md). Production extraction, meaningful tests и независимый differential/research выполнялись параллельно с раздельными write sets; integrator владел snapshots, dependency policy, документацией, отдельным fixture fix и общей приёмкой.

## Результат и механизм

Весь stored localModels domain теперь принадлежит src/config/local-models/: types/defaults/parser, без обязательного barrel. config-schema.ts: 3885 → 3222 строки; owners: 314/39/426 строк. Разные ordered runtime/user shapes сохранены; пять прежних публичных типов и семь validators доступны через прежние root exports. Defaults создаются свежими mutable objects/arrays один раз на прежнем месте root construction.

10 ранних declarations сохраняют custom-model parsing перед managed selection, embedding port перед enabled, затем download/mode/URL. Root LLM-provider composition остаётся между ними и поздними completion/template/thinking/reasoning fields. Captured aliases позволяют сохранить llmBlock буквально прежним. Поэтому invalid providers по-прежнему опережают late completion errors, но уступают early managed/embedding/download errors.

20 current-default lookup sites остаются в прежних expressions/branches. Три private resolvers получают lazy thunk; pre-v41 auto-update и explicit parallel auto не читают defaults. Pre-v63 pin migration, same-file custom selection, unknown nonempty embedding IDs, ignored tensor/custom default arrays, derived embedding URL и repeated dataDirOverride reads сохранены. Process/download/catalog algorithms, environment precedence и consumers не менялись.

Embedding lifecycle JSDoc перенесён к embedding type; download comment остался своим. Generic bounded-positive orphan и общий parseUserConfigFile JSDoc удержаны в root. Остальные owned comments переносятся без изменения утверждений; defaults/version/validation policy не исправлялись попутно.

## Доказательства

Fresh /tmp/atomic-stage05i-before снят после verified 05h до production writes: полный src/scripts/docs/CI/package/compiler snapshot и 24812 protected hashes. Actual old graph запускается из snapshot, не из переписанного source. Source proof/manifest фиксируют 31 root transformation: весь остальной root text exact, пять named types/семь validators/три constants exact, две ordered shape expansions, fresh default literal/order/comments, 10 early statements и late literal эквивалентны после recorded aliases/thunk substitutions. Три private bodies меняют только явный источник defaults; whole-parser byte identity не заявляется.

Независимый differential: 545 whole/direct/version cases и 20 reference/getter scenarios byte-identical. Включены supported/future versions, 40/41 и 62/63, custom models, bounds/null/permissive URL/HF path behavior, 15 defect precedence pairs, conditional default reads, repeated raw accesses, nested/whole defaults replacement, early retained outputs и ignored array/URL defaults. Все mutations восстановлены в finally. Дополнительно actual fresh old/new совпали на 369 scalar cases, 76 file/version outputs и полных USER_CONFIG_DEFAULTS/ENV_DEFAULTS.

Parent proof: все 87 root public names сохранены; owners types/defaults/parser имеют 7/1/10 intentional exports. 2385 прочих прежних TS/TSX byte-identical; ровно четыре новых production/test files. Два отдельно проверенных existing-test изменения описаны ниже. config/index/load-config, прочие concrete helpers/consumers, package/lock/compiler/CI/checker, protected hashes неизменны. Import allowlists конкретные, без blanket directory permissions или exceptions.

38 новых tests закрывают фазовые/migration/default seams, 12 multi-invalid pairs, same-file selection, lazy lookups, fresh arrays/outputs, raw/default getter timing и прежние HF/embedding semantics. Scalar suites и существующие assertions не переписаны. Compiled smoke подтвердил семь root/owner helper identities, fresh nested defaults, v41/v63 boundaries и derived embedding URL.

## Два изменения тестовой инфраструктуры

agents-md-defaults.test.ts получил только одну inventory entry для нового types owner. Все остальные statements, claim regexes/resolvers/judge/floors/allowlists/assertions exact. Actual coverage остаётся 23 schema claims (root 1, memory 22; новый owner пока 0 распознаваемых claims) и 207 Markdown claims. Во временную копию нового owner добавлена ложная JSDoc claim parallel default 8; checker ожидаемо отверг её: «localModels.managed.parallel documented 8, ships auto», exit 1. Repository types/defaults не мутировались при negative check.

Первый type gate показал NEW/RESOLVED для одной прежней TS2741: после named type extraction TypeScript изменил порядок none/basic/parallel union в сообщении. Это прежний missing kind в contextual userModels fixture model-strict-tools.test.ts, не новая несовместимость production. Добавлен только kind:chat в одном literal; assertions и strictEntry остальных тестов unchanged. Затем gate обнаружил ровно одну resolved diagnostic, без новых. Официальный reduce удалил только её: debt 854 → 853. Proof сравнивает весь прежний fingerprint multiset минус эту запись, TypeScript/compiler options unchanged; rootFiles inventory обновлён до фактических 2392 sources, включая файлы предыдущих срезов. Новых allowances/casts нет.

## Проверки и ограничения

- Existing schema: 219 passed; new localModels suite: 38 passed.
- Focused config/CLI/TUI persistence/catalog/backend/server/profile/fixture final: 40 suites, 852 tests passed. Первый sandbox run отказал loopback HTTP и завершился с 14 failed/10 errors; повтор с разрешёнными existing local HTTP fixtures прошёл. Assertions/source ради sandbox не изменялись.
- Full test:ci: 1049 suites, 12642 passed, 4 existing skips, exit 0, 39.38 s. Полный runner запускался после focused/type fixes.
- lint/build и compiled smoke passed. Final typecheck:tests: 2392 roots, 105 test TSX, 853 explicit debt diagnostics, no new errors.
- imports:check: 1363 modules, 4901 local edges, 0 runtime cycles/exceptions. Self-test: 94 fixtures passed, 13 новых tests для source/type/dynamic edges и positive composition. Первые negative fixtures отказали на прежней policy, затем прошли с новыми правилами. Types imports только type-only; owned types нельзя загрузить runtime из defaults/parser. Bare packages/transitive loading остаются вне scope.
- Docs self-test: 11 passed; docs:check budgets/links/metadata/pointers и diff passed после сохранения приёмки/следующего плана. Quarantine: 0 active/2 released, без исключения новых tests.

Artifacts /tmp/atomic-stage05i-{before,production-proof.mjs,production-extraction.json,proof.mjs,local-models-capture.mjs,local-models-before.json,local-models-after.json,*scalars-defaults.json,*types*.txt,*tests*.txt,doc-negative.txt}. Captures используют synthetic inputs, не user credentials/live model servers/download jobs. Full runner использует existing approved HTTP/installation fixtures. Paid/GPU/manual platform eval и измерение качества/скорости агента не выполнялись; differential дополняется source proofs и existing integration seams и не исчерпывает все possible inputs.

05i verified; весь 05 ещё in-progress. Следующая согласованная группа — [05j: TUI, каналы и интеграции](../plans/05j-frontend-integration-config.md), specified; implementation ещё не начата.

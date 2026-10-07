# Приёмка 05a: scalar config validation

Status: verified
Owner: repository maintainers

[План 05a](../plans/05a-config-primitives.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06. Extraction agent владел двумя config modules; два read-only agents исследовали callers/следующий domain и tool prototype; integrator владел baseline, import gate, общими проверками и документацией.

## Изменение и совместимость

11 функций перенесены в config-primitives: два coercers и девять scalar parsers. Leaf использует только существующий config-validation-error; schema импортирует десять используемых функций и re-export девяти прежних public parsers. Coercers не появились в schema API. Schema сократилась с 6055 до 5902 строк, leaf — 179 строк. Это первый owner, не завершение разделения большой схемы.

Source proof сравнил bodies/signatures всех 11 функций и все оставшиеся AST statements схемы, 87 public export names и 2370 остальных TS/TSX files. Extraction proof дополнительно проверил весь unmoved schema text и комментарии функций. Defaults, migrations, version=74, env precedence, config/index, consumers, tests, prompt/tool literals и runtime assembly не изменены. Неправильно расположенный старый JSDoc о closed bounds оставлен в schema; его исправление не смешано с переносом.

До переноса snapshot /tmp/atomic-stage05a-before сохранил src/scripts/docs, package/compiler config и protected hashes. 369 scalar cases сравнивают значения либо точные error name/message/field/reason/instanceof; 76 file-parser cases включают undefined, пустой объект и каждую входную версию 1–74, сравнивая успешный результат либо отказ. Это differential baseline, не утверждение, что все версии обязаны приниматься. USER_CONFIG_DEFAULTS/ENV_DEFAULTS сравниваются целиком. Все результаты после extraction совпали. Проверка включает safe-string versus unsafe-number asymmetry, numeric notation, whitespace, bounds, null/undefined/bool aliases. Compiled smoke подтвердил identity девяти parser functions через old API и leaf, приватность coercers на old API и существующий класс/поля/точный текст ошибки.

Protected hashes .pr-review-56/EVIDENCE_ROUTER_MODEL.md/package/lock/compiler configs сохранены. Ledger и tests не исправлялись, dependencies не добавлялись. Differential/proof scripts лежат в /tmp/atomic-stage05a-{values.mts,proof.mjs,primitive-proof.mjs}; они не являются новым обязательным repo tooling.

## Проверки

- Focused existing config/CLI/TUI: 24 suites, 534 tests passed; отдельно extraction agent config-schema: 219 tests passed.
- Full test:ci: 1042 suites, 12445 passed, 4 existing platform/GC skips; exit 0, 52.93 s. Использован разрешённый runner с loopback/home-fixture доступом; карантин не расширялся.
- lint и build проходят. dist config entry/leaf compatibility smoke проходит.
- typecheck:tests: 2372 roots, 105 test TSX, прежние 856 explicit diagnostics, no new errors; reduce/capture/rebase не выполнялись.
- imports:check: 1350 modules, 4857 edges, 0 runtime SCC, 0 exceptions. Добавлены schema → leaf и leaf → error-owner edges; исходные consumers не retargeted.
- imports:self-test: 41 fixtures. Новые negatives сначала упали при старой policy, затем static/type/dynamic backedges блокируются; positive error-owner/inward composition разрешены. Это прямой запрет leaf → schema/index, не доказательство всей transitive isolation.
- docs self-tests 11, type self-tests 11, quarantine self-tests 8 passed; quarantine 0 active/2 released. Active docs/check и git diff --check прошли; новые acceptance/next-plan документы дополнительно проверены после сохранения.

## Ограничения и следующий срез

Live models/downloads/GPU/provider eval и ручной terminal QA не запускались: production behavior не менялось, проверены существующие fixtures и построенные entry modules. Differential cases не исчерпывают все possible raw values; unchanged bodies и existing suites дают дополнительное доказательство. Уменьшение контекста есть по структуре, скорость/качество работы агента ещё не измерялись.

05a verified; [05b](../plans/05b-session-rail-config.md) specified, implementation не начата. Этап 05 остаётся in-progress: domain blocks/defaults/migrations и tool contracts ещё предстоят.

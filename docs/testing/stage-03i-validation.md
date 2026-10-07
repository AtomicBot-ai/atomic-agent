# Приёмка 03i и завершение организации TUI

Status: verified
Owner: repository maintainers

[План среза](../plans/03i-tui-completion.md), [этап 03](../plans/03-tui-organization.md). Проверено 2026-10-06 после 03h.

## Структура и неизменность поведения

57 files moved: theme/observe — 5 production; chat — 19 production и 16 tests; coding-mode/session-rail/context — 10 production и 7 tests. Старые пути удалены, все consumers/mocks/type/dynamic literals retargeted; новых forwarding modules/barrels нет. Shared LogoVariant/WordmarkPlacement выделены в logo-types.ts, definitions и существующие splash-fit exports сохранены; документация типа перенесена с ним. Общий Logo больше не импортирует chat layout даже через types.

Чат, observation, theme chooser, context controls, coding stance и session rail получили guides. Уже локальные privacy/integrations/swarm/telegram остаются в прежней структуре и получили маршруты к views/state/input/operations/resources/tests. Components содержит 35 production modules: 18 named shared primitives и 17 shell composition modules. Generic editor/list/logo/formatting отделены от compositor views; sidebar/status/debug/composer вправе соединять функции. Root global state/actions/reducers/router/submit/TuiApp/ChatOrchestrator и approval/terminal composition сохранены намеренно, с явными ссылками из guides.

Snapshots и manifests /tmp/atomic-stage03i-* проверены отдельно для каждой группы. Итоговый proof сравнил все 2371 TS/TSX modules: только записанные module literals, shared type relocation и девять fixture repairs. Все прежние expect calls неизменны. Compiler options/TypeScript version и package/package-lock/protected hashes сохранены. Runtime API, алгоритмы, config defaults/версии, prompt literals и .pr-review-56/EVIDENCE_ROUTER_MODEL.md не изменены этим срезом.

## Fixtures и checks

До moves исправлены пять неполных chat session fixtures через fakeSession с прежними explicit values; callbacks switch-back стали полными typed; configure-fallback использует действительные MouseProvider props и не содержит unused vi; context view/state fixtures получили недостающие поля с neutral defaults. Assertions не менялись, casts/новые allowances не вводились. Type gate обнаружил ровно 10 resolved cases, reduce уменьшил 902 → 892. Никакого capture/rebase или ослабления checks.

Fixture checks: 9 suites / 88 tests; shared aliases: 4 / 28; theme/observe composition: 10 / 179; controls/context/rail: 20 / 211. Первый chat-selected запуск захватил также root chat-orchestrator suites: 23 suites / 327 tests passed, два daemon-restart tests failed под sandbox. Проверка свободного порта в port-reclaim.canBind использует TCP listener; sandbox отказ воспринимается как занятый порт. Тесты/production для обхода этого не изменены. Итоговый full runner с разрешёнными существующими loopback fixtures прошёл, включая эти случаи.

Full test:ci: 1042 suites passed; 12445 tests passed, 4 existing platform/GC skips; exit 0. Production lint passed. typecheck:tests: 2371 roots, 105 test TSX, 892 debt, no new errors. imports:check: 1349 production modules, 4855 local edges, 0 runtime SCC, 0 exceptions.

Shared import gate расширен на named editor/logo/chip/formatting primitives, row-window и theme. Семь новых positive/negative fixtures проверяют typed chat dependency, context handler, chooser, domain formatting и разрешённые shared/shell seams. Новый negative logo case сначала падал при старой политике; после расширения 32 import fixtures passed. Test-type self-tests 11, docs self-tests 11, quarantine self-tests 8 passed; registry 0 active / 2 released. Active docs/link budgets и git diff --check проходят. Это проверка прямых зависимостей, не утверждение о transitive isolation всех mouse/context-menu contracts.

## Границы доказательства и результат этапа

Нет отдельных ThemePicker/observe renderer suites, ручного terminal/platform QA, hosted CI/optional-canvas leg или живых provider/installer/channel operations. Configure-fallback suite проверяет action contract/label, не настоящий click. Существующий test type debt 892 остаётся явным; перемещения не означают его полное устранение или измеренное ускорение работы агента. Pre-existing context-usage facade остаётся без изменений.

Весь этап 03 verified: MCP → providers/LLM → onboarding → local-models UI → memory/tasks → skills/import → issue-report/uninstall → update → remaining owners/shared boundary проверены отдельными срезами, затем полным набором. Следующий этап — [04: local-llm/tools/os](../plans/04-local-llm-tools-os.md); здесь создан только его подробный план, implementation не начата.

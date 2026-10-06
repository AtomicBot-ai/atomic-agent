# Срез 05b: конфигурация списка сессий

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05a](../testing/stage-05a-validation.md). [Приёмка 05b](../testing/stage-05b-validation.md) выполнена; parallel read-only research не расширяло write set этого среза. База: 856 test diagnostics, 0 SCC/exceptions; full suite 1042/12445/4 skips.

## Контекст и выбор

SessionRailConfig хранит порядок и закреплённые session ids в пользовательском JSON. Parser нормализует эти списки; актуальность ids и отображение принадлежат TUI. Это замкнутый domain block с одной runtime dependency — ConfigValidationError. LocalModels, agent task/providerWait и прочие TUI blocks зависят от defaults/version helpers, поэтому их extraction требует отдельной схемы сборки и сейчас не включается.

## Точный write set и работы

Прочитать config инструкции/README/compatibility, текущие schema/default/file parser и session-rail TUI инструкции/guide по его persistence seam. До изменения сохранить src/debt/protected/package snapshot, root exports/types, defaults/version matrix и raw session-rail outputs/errors.

Новый src/config/session-rail-config.ts получает ровно SessionRailConfig, parseSessionRailConfig и private parseSessionIdList с прежними bodies/signatures. Перенести принадлежащие им comments; соседние misplaced onboarding/notify comments не присваивать автоматически новому owner. Leaf импортирует existing error class напрямую; schema импортирует type/parser и сохраняет прежние named exports. config/index public exports и consumers не изменять. Defaults/parseUserConfigFile assembly остаются в schema; leaf не импортирует root defaults или index. Не создавать forwarder files/новый barrel.

Сохранить fresh empty arrays для отсутствующего/null whole block, object/array distinction, точные error fields/messages, nonarray list refusal, filtering nonstring/empty ids, first-occurrence dedup/order и whitespace-only ids. Parser не проверяет UUID, не читает sessions и не удаляет stale ids: это отдельное UI read/write поведение.

## Приёмка

AST/source/body/export proof, raw-result/error identity differential, untouched source/default/version/protected/package comparisons. Существующие src/config/config-schema.test.ts (sessionRail v58/v59), src/tui/session-rail/persist-session-rail.test.ts, src/tui/rail-session-list.test.ts и src/tui/session-rail/session-rail-order.test.ts. Production lint, unchanged full test-type debt, imports/docs/diff/build и full test:ci. Meaningful gap tests только по actual missing seam; не зеркалировать parser. При добавлении owner boundary — negative fixture до policy и positive composition/error-owner fixture, включая type imports. Записать фактическую приёмку.

Следующий domain/default/migration slice и подробный os.fs.hash prototype определяются после этого результата. Read-only research может выполняться параллельно; schema/default/public exports/ledger и final acceptance принадлежат одному integrator. Этот срез не закрывает этап 05 и не начинает runtime/agent-loop refactor.

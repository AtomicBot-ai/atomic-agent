# Срез 05d: конфигурация вебхуков

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05c](../testing/stage-05c-validation.md); [приёмка 05d](../testing/stage-05d-validation.md) выполнена. Следующий [05e MCP config](05e-mcp-config.md) in-progress. Production extraction, тесты и общая integration имеют отдельные parallel write sets. База: 856 diagnostics, 0 SCC/exceptions; full suite 1043/12471/4 existing skips.

## Цель и выбор

WebhookConfig и весь parser карты/session modes/schedule (~150 строк с comments) образуют самостоятельный domain block. Его runtime dependencies — ConfigValidationError и parseNonEmptyString; TaskSchedule нужен только как type. Root defaults/version/migrations не используются в leaf. Это следующий meaningful owner вместо произвольного деления схемы по строкам. Shared URL/list validators и MCP server config остаются отдельными последующими кандидатами; defaults-dependent blocks требуют явного интерфейса сборки.

## Точный write set

Новый src/config/webhook-config.ts получает WebhookConfig, parseWebhookMap и private parseWebhookSchedule с прежними declarations/bodies/comments. Импортировать existing error, primitive validator и type TaskSchedule из concrete owner; не импортировать root/index/defaults/tasks runtime/HTTP. Schema импортирует type/parser и сохраняет прежние exports; прежний TaskSchedule import удалить только если не осталось других uses. config/index type exports, consumers, USER_CONFIG_DEFAULTS.webhooks={} и parseUserConfigFile assembly остаются прежними.

Добавить src/config/webhook-config.test.ts для обнаруженного gap: config-schema tests не покрывают webhook parser, а HTTP harness получает уже typed конфигурацию. Config guide/compatibility, detailed evidence/roadmap принадлежат integrator. При добавлении owner boundary обновить import checker с предварительным negative и positive fixtures; без exceptions. HTTP/tasks source не переносить.

## Контракты и проверки

До extraction snapshot src/debt/package/protected/defaults/root public exports и actual webhook outputs/errors. Preserve map/block absence/null handling, accepted names regex [a-zA-Z0-9_-]+, template whitespace/nonempty semantics, default ephemeral/persistent/named mode, named requiring sessionId и optional sessionId/secret absence versus explicit empty refusal. Optional schedule null/undefined отсутствует в normalized output; at требует finite number, interval positive integer, cron nonempty expression и прежний optional tz treatment. Parser проверяет форму; canonical cron/dispatch validation остаётся TaskRunner, не добавлять новый runtime tasks dependency.

Существующие конфигурация/load/file/CLI seams и src/http/route-webhooks.test.ts; новые meaningful tests проверяют actual parser/root composition, normalization/error identity, named-session requirement и schedule shapes/deferred validation. Не зеркалировать каждую строку functions. Credentials в fixtures синтетические; ошибки/logging не менять попутно.

AST/source/type/export proof, root defaults/version/protected/other-source equality и old/new differential. Lint, no new type debt, imports 0 SCC/exceptions, docs/diff/build, relevant checker self-tests и full test:ci. Record actual checks и лишь затем verified. No capture/rebase/casts/new allowances/dependencies/config version bump. Подробный следующий domain/default/migration или contract-family plan уточнить после результата; не считать весь 05 завершённым.

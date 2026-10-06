# Срез 05g: конфигурация web search/fetch

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05f](../testing/stage-05f-validation.md); implementation завершена; [приёмка](../testing/stage-05g-validation.md). База: 854 explicit diagnostics, 0 runtime SCC/exceptions, full runner 1046 suites / 12530 passed / 4 existing skips.

## Цель и решение

Выделить search/fetch как целый configuration domain: публичные типы, default construction, provider/fallback validation и normalization. Root сохраняет overall config assembly/migrations, потребители — прежние импорты. Runtime search providers, fetch/SSRF/network/cache и их отдельные configless defaults не переносить.

Нынешний provider проверяется рано, до webhooks/localModels/LLM и return-object agent/http. Остальные search fields проверяются внутри return.web.search, fetch — следом. Один ранний parseWebConfig изменил бы precedence ошибок. Поэтому сохраняем две фазы: подготовка provider/subblock references на прежнем раннем месте и normalization на прежних поздних местах.

USER_CONFIG_DEFAULTS mutable. Для этого domain нужен lookup thunk, а не cached nested object: каждое прежнее fallback expression отдельно читает текущий default и сохраняет short-circuiting. Raw/default getters могут заменить web defaults внутри одного parse call; перенос не должен менять порядок этих чтений. Searxng instanceUrl при отсутствии остаётся null, даже если default мутирован в nonnull.

## Write sets и API

Production: только новый src/config/web-config.ts и src/config/config-schema.ts. Owner получает WebSearchProviderName/WebSearchConfig/WebFetchConfig, прежние parseWebSearchProviderName/parseWebSearchFallback с exact bodies, две fresh factories createWebSearchDefaults/createWebFetchDefaults и internal composition API:

- prepareWebSearchInputs(raw, readDefaults) валидирует provider, затем сохраняет raw/searxng/exa/brave references в нынешнем порядке; не валидирует остальные fields заранее;
- parseWebSearchConfig(prepared, readDefaults) нормализует прежний поздний search object literal;
- parseWebFetchConfig(raw, readDefaults) нормализует прежний поздний fetch object literal.

Exact signatures/PreparedWebSearchInputs type фиксируются после нового baseline и чтения actual types. Concrete owner exports намеренные; root сохраняет ровно прежние три type и два parser exports, index не меняется. Owner imports только existing scalar/error parents; никаких config-schema/index/tools/provider/runtime imports. Type-only backedges тоже запрещены.

Root оставляет web/search/fetch casts/??{} на прежних местах; contiguous provider/subblock preparation заменяет early helper, поздние search/fetch literals — parser calls. Defaults literals заменяются factories на прежних позициях. Lookup dependencies передаются как ()=>USER_CONFIG_DEFAULTS.web.search/fetch; каждое прежнее fallback читает thunk отдельно. Не кешировать повторные raw.instanceUrl accesses и не destructure defaults заранее. Move owned comments намеренно, без захвата соседних orphan comments.

Types сохраняют ordered mutable fields/nested properties/arrays. Factories возвращают прежние значения и key order, с fresh nested objects/fallback arrays при каждом вызове; корень вызывает их один раз при construction. Default search: true/exa/8/15000/60/true/[duckduckgo], searxng.instanceUrl=null, прежние Exa endpoints/API-key-env и Brave API-key-env. Fetch: 30000/10000/2/500/5000. Источник точных literals — baseline schema, не пересказ плана.

Integrator владеет guides/compatibility/boundaries/plans/evidence/snapshots. Test agent — новым web-config.test.ts; existing test bodies/values не переписывать. Config index/load-config/consumers, tools provider-name union и fetch configless fallback bytes сохраняются. No version bump, dependencies, defaults/algorithms changes или allowances. Не переносить HTTP tools settings попутно.

## Контракты и доказательства

До writes — новый full source/debt/protected/default/type/export snapshot после verified 05f. Research captures не считать acceptance baseline. Сравнить whole-root/direct helpers: все providers, fallback exclusion/dedup/order, absent/null/empty lists и blocks, bounds/coercion/error class/path/message, whitespace/non-URL strings. Полные defaults/ENV_DEFAULTS/version/public API/prompt/catalog/protected сохраняются.

Отдельно закрепить precedence invalid pairs: provider раньше webhooks; webhooks/agent/http раньше позднего search; search раньше fetch. Captures должны проверить raw/default getter event sequences и within-call nested/whole-web default replacement с finally restore.

Сохранить permissive casts: primitive/array/Class blocks без relevant fields сейчас могут нормализоваться, plain-object restriction не добавлять. Search/fetch outputs всегда fresh; undefined direct fallback даёт [], null direct fallback отвергается, root null использует default, explicit [] сохраняет пустоту. Provider names exact lowercase. Search validation выполняется и при enabled=false; прежние bounds 1..20 results, 0..1440 TTL, fetch retries 0..5. Не добавлять cross-field timeout/retry comparisons. Endpoints/API-key-env — nonempty strings, не URL/env identifier validators; не подменять parseUrl.

AST/source proof допускает explicit raw/prepared/default-lookup substitutions и factories, но проверяет прежние types/helper bodies/default values/order, раннюю последовательность и поздние object field order/validation expressions. Весь остальной root text и другие production source bytes неизменны. Не заявлять byte-identical whole parser. New owner root/tools backedges запрещены с предварительными negative и positive static/type/dynamic fixtures; no exceptions.

## Проверки и завершение

Новый purposeful suite: owner/root function/error identity, две фазы/precedence, lookup timing, omission/null/empty и fresh nested references. Existing config/schema/file/load/agents-md-defaults, CLI config commands, OS registration/search tool/provider/orchestrator/cache/cooldown/HTTP, fetch/SSRF/challenge/extract seams по actual dependencies. Network/native fixtures — established approved full runner; не отключать их ради sandbox.

Lint/types без новых diagnostics, imports 0 SCC/exceptions, docs/diff/quarantine/build, затронутые checker self-tests и full test:ci. Если type printing выявит старую неполную fixture, исправление отдельно обосновать и reduce только реально устранённый долг; не обновлять fingerprints как allowances. После evidence отметить 05g verified и только затем specify следующий meaningful domain/tool-family по фактическому состоянию. Весь 05 остаётся in-progress; этапы runtime/agent-loop ещё не начинаются.


## Фактическая приёмка

[Доказательства](../testing/stage-05g-validation.md): root 5365 → 5124; 1047 suites / 12564 passed / 4 existing skips; 854 diagnostics без новых ошибок; 0 SCC/exceptions; lint/build/docs/proofs passed. Overall 05 остаётся in-progress.

Следующий [05h: весь memory configuration domain](05h-memory-config.md) specified после приёмки.

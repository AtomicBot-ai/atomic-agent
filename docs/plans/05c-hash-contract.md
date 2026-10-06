# Срез 05c: общий контракт os.fs.hash

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Начат после [приёмки 05b](../testing/stage-05b-validation.md). Это pilot одной filesystem operation; остальные contract families и config domains остаются planned.

[Приёмка 05c](../testing/stage-05c-validation.md) выполнена; следующий [05d webhook config](05d-webhook-config.md) specified, implementation не начата.

## Цель и write sets

Создать dependency-free fs-hash-contract.ts рядом с filesystem owner: name/definition metadata, descriptor projection, JSON schema, resourceClass и прежний parser аргументов. Потоковое вычисление digest и файловый I/O остаются в fs-hash.ts. Descriptor/JSON schema/classification выбирают явные поля contract на прежних позициях, без generic catalog factory или дополнительных public barrels.

Production write set: new src/tools/os/fs/fs-hash-contract.ts, fs-hash.ts, src/prompt/default-tool-descriptors-a.ts, default-tool-args-schemas.ts и src/agent/tool-resource-class.ts. Прежние HashAlgorithm/HashEncoding exports из fs-hash сохраняются. parseArgs может получить имя parseHashArgs, тела parsers и вычисления сохраняются. Closed enum tuples могут задавать типы/schema; literal parser comparisons не переписывать одновременно.

Roles, read-target mapping, OS index/registration order, ToolRegistry/MCP overwrite behavior и security guards остаются прежними. Leaf не импортирует execution/registry/prompt/agent/config types: ToolRegistry → coerce-tool-args → default-tool-args-schemas уже существует и обратный import создаёт риск цикла. Metadata projection не распространяет parser/class/default поля в prompt/wire/definition.

## Совместимость и доказательства

До production edits snapshot src/package/debt/protected и actual outputs: весь catalog/schema/class/role order, 45 OS registration calls до Map dedup, public runtime exports, 18 prefixes (roles × transports × profiles), loaded hash, plain/strict wire/widened args и read targets. After capture в новом каталоге должен совпасть byte-for-byte, включая key/enum/property order. ArgsSchema/summary/definition description сохраняются, grammar literals не меняются.

Runtime algorithm принимает uppercase и null defaults, encoding uppercase отвергает; path не должен быть пустым/нестроковым. JSON schema шире по длине path и уже по casing/null, поэтому не заменять imperative parser schema validation. Зафиксировать эти реальные различия тестами actual tool.run на temporary files и точными errors; прежние шесть digest tests не менять.

New fs-hash-contract.test.ts проверяет actual catalog, schema, captured registrations и classification. Test-local inspector до построения Map обнаруживает missing/duplicate descriptors и registrations, missing/changed schema, unknown/wrong class и definition/projection disagreement. Независимые negative fixture assertions обязательны; inspector не становится runtime factory. Explicit role admissions и read targets проверяются отдельно, не выводятся из readonly/class.

Parallel write sets: extraction agent владеет пятью production files; test agent — new seam test и additions to existing hash test; integrator — baseline/proofs/scripts/guides/ledger/plans/final validation. Shared files не редактируются одновременно.

## Приёмка

Exact parser/execution bodies и untouched modules/defaults/protected comparison, public type exports и serialized-output equality. Existing hash/OS composition/schema/prefix/roles/tool-view/read-scope/class/batch/coercion/unknown-argument/OpenAI adapter checks. Production lint, no new test debt, imports 0 SCC/exceptions, docs/diff/build, quarantine и full test:ci. Если import gate добавляется, сначала negative failure и positive inward fixture; applies also to types. Записать фактический результат; только тогда 05c verified.

Не меняются cancellations, buffer behavior, approvals, dynamic MCP schemas, strict conversion и terminal dispatch. No live provider/GPU/model eval required для static metadata equality и real temporary-file hash checks; это не измерение качества агента. После приёмки уточнить следующий meaningful config domain (кандидат webhook map/session/schedule) и дальнейшее расширение contracts.

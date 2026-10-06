# Приёмка 05c: общий контракт os.fs.hash

Status: verified
Owner: repository maintainers

[План 05c](../plans/05c-hash-contract.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06 после [05b](stage-05b-validation.md). Production agent владел contract leaf/четырьмя consumers; test agent — seam и compatibility tests; integrator — before capture/proofs/import gate/guides/общими проверками. Пересекающихся write sets не было.

## Результат и совместимость

Import-free fs-hash-contract.ts объединяет definition metadata, descriptor projection, JSON schema, pure_read class, args types и прежний parser. fs-hash.ts сохраняет streaming I/O и public HashAlgorithm/HashEncoding type exports. Descriptor-A/schema Map/class Map и definition выбирают явные projections на прежних местах. parseArgs переименован в parseHashArgs; три parser bodies, run body modulo этого identifier и computeDigest сохранены. Union types/default literals/literal comparisons прежние; text schema не генерируется. Это общий owner одного инструмента, не универсальная factory и не устранение всех повторов внутри parser/schema/text.

Roles/read targets/OS index/registration order, approval/read guards, config/default/version, registry overwrite и dynamic MCP не менялись. Security/role политика не выводится автоматически из readonly/class. Runtime null defaults/uppercase algorithm и case-sensitive encoding сохранены, JSON schema не заменяет parser.

## Доказательства

Свежий acceptance snapshot /tmp/atomic-stage05c-before снят после verified 05b и до production edits. 37 outputs после переноса совпали byte-for-byte: все 88 descriptors и schemas, class/role order, 45 OS registration calls до Map overwrite, public runtime exports, loaded hash, read-target projections, 18 prefixes (role × transport × profile), plain/strict wire payload и widened argument metadata. No golden refresh.

Source proof подтвердил exact recorded edits четырёх consumers и восемь moved declarations modulo parser name/двух новых exports; другой proof — три parser bodies/run/computeDigest, zero leaf imports, шесть прежних hash test calls и 2368 прочих TS/TSX modules. Package/lock/compiler/debt/.pr-review-56/EVIDENCE_ROUTER_MODEL.md hashes неизменны. 69 actual tool.run cases с real temporary file совпали; before outcomes дополнительно сверены с исполнением старого source snapshot, независимо от concurrent writes.

Новый composition gate использует actual catalog/schema/class и registerOsTools sequence до построения Map. 16 cases обнаруживают missing/duplicate descriptor/registration, missing/changed schema, unknown/wrong class, changed definition/projection/schema override и проверяют explicit roles/read targets. Old descriptor/schema literal expectations не дают всем consumers незаметно дрейфовать вместе. Десять real-tool compatibility cases закрепляют null/default/casing и точные errors; прежние шесть digest tests сохранены. Global registry replacement semantics не менялись. Test-local inspector не входит в production runtime.

Artifacts: /tmp/atomic-stage05c-{before,after-contract-outputs,proof.mjs,hash-production-proof.mjs,hash-production-edits.json,hash-values.mts,old-hash-values.mts,*-tests.txt}; baseline renderer /tmp/atomic-stage05-hash-baseline.mjs. Отдельный initial extraction script lookup failed до записей, guard исправлен; production recovery не требовалось.

## Проверки

- Focused integrated tools/prompt/agent/OpenAI/read-scope: 16 suites, 483 tests passed. Agent focused new/existing hash: 32 passed.
- Full test:ci: 1043 suites, 12471 passed, 4 existing platform/GC skips; exit 0, 50.68 s. Разрешённый loopback/home-fixture runner; quarantine прежний.
- lint/build passed; compiled execution/schema/class linkage и parser compatibility smoke passed.
- typecheck:tests: 2375 roots, 105 test TSX; прежние 856 diagnostics, no new errors. Allowances/options/ledger не менялись; capture/reduce/rebase не выполнялись.
- imports:check: 1352 modules, 4863 edges, 0 runtime SCC, 0 exceptions. Leaf source import-free; gate запрещает любой direct src dependency, включая types/dynamic literals. Bare packages вне graph rule; source proof проверяет полное отсутствие imports в текущем leaf.
- imports:self-test: 49 fixtures; три negatives сначала failed без policy, затем запрещены prompt/schema, taxonomy types и dynamic execution imports; positive inward dependencies разрешены. Docs budgets/links/metadata/self-tests и diff проходят после acceptance/next-plan сохранения. Type/quarantine checker code не менялся и их прежние self-tests не повторялись; quarantine check 0 active/2 released сохранён.

## Ограничения

No live provider/GPU/download/model eval или manual terminal QA. Real digest tests используют temporary files; baseline registration не вызывает tools/provider/server. Исследовательский capture Exa выдал existing missing-key warning при construction, сетевого запроса не было. Структурная согласованность пилота не доказывает согласованность остальных families или улучшение качества агента.

05c verified; [05d](../plans/05d-webhook-config.md) specified. Весь 05 остаётся in-progress: другие domains/defaults/migrations и расширение tool contracts ещё предстоят.

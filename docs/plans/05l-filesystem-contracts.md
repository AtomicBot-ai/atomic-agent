# Срез 05l: filesystem contracts и итоговая приёмка этапа 05

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05k](../testing/stage-05k-validation.md); implementation и итоговая приёмка завершены; [evidence](../testing/stage-05l-validation.md). База: root schema 1521 строка, 848 explicit test type diagnostics, 0 runtime cycles/exceptions, full runner 1055 suites / 12747 passed / 4 existing skips. Это последний согласованный блок этапа 05: contracts, conformance gate и финальная приёмка выполняются вместе, без отдельных 05m/05n.

## Где мы и конечный результат

05c уже установил импортно свободный канонический контракт os.fs.hash: определение, описание для модели, JSON Schema, классификация и чистый parser сходятся в fs-hash-contract.ts. Однако остальные инструменты повторяют данные в execution, prompt descriptors, schema map и resource taxonomy. Доменные config owners завершаются 05k; root schema намеренно сохраняет сборку, версии, ENV и небольшие общие настройки.

05l расширяет prototype до всей самостоятельной core FS family и закрепляет общую проверку catalog/registrations/schema/class/tier/roles. Другие семейства получают проверку наличия/формата представлений и фактического taxonomy lookup; семантическое равенство без canonical owner не заявляется. После общей API/migration/navigation приёмки этап 05 закрывается. Следующий план только 06: runtime composition.

## 1. Замкнутая family: 13 core filesystem tools

Вся текущая ответственность src/tools/os/fs/README.md:

- Read/discovery: read, list, glob, grep, hash, diff, watch.
- Mutation/recovery: write, edit, patch, trash, restore.
- Project location: locate_project.

Итого 13 tools, из них hash уже перенесён; 12 новых contracts. read_document находится в os/read-document/, archive.list/read_entry/extract — в os/archive/: это отдельные extraction/backend owners, которые участвуют в глобальной conformance-проверке, но их алгоритмы и metadata ownership в этом блоке не перестраиваются. Нельзя назвать результат «все os.fs.* перенесены»: семейство ограничено core fs/.

## 2. Конкретные production modules и направление зависимостей

Добавить рядом с исполнением по одному описательному leaf:

src/tools/os/fs/fs-{read,list,glob,grep,diff,watch,write,edit,patch,trash,restore,locate-project}-contract.ts.

Существующий fs-hash-contract.ts сохраняется владельцем hash. Не создавать aggregate runtime catalog, обязательный index.ts или пустой AGENTS.md. Количество файлов отражает самостоятельные contracts операций, а не произвольный лимит строк.

Каждый leaf экспортирует OS_FS_<OP>_CONTRACT, с теми же полями, что hash:
name, description, readonly, resourceClass, descriptor, argsJsonSchema.

Сохраняются не только значения, но порядок descriptor/schema properties/required/enum, string literals, tier omission против explicit tier, examples и порядок каталога. Независимое metadata не импортирует registry, execution, prompt, agent, config/index, компрессор или IO. Использовать локальные точные literals JSON Schema; не импортировать default-tool-args-schemas ради obj/stringSchema. Named projections в consumers остаются явными; registry registration order не генерировать.

Execution получает definition.name/description/readonly из своего owner; DEFAULT_TOOL_DESCRIPTORS_A вставляет .descriptor на прежнее место; default-tool-args-schemas выбирает .argsJsonSchema на прежнем месте; tool-resource-class выбирает .resourceClass. Tool roles, read targets, approval category mapping остаются явными политиками своих владельцев, проверенными seam tests. Их нельзя вычислять из readonly или resourceClass.

### Parser ownership без сдвига IO/ошибок

Чистые замкнутые bodies и типы переносить в соответствующий contract с прежними literals/errors/order: read, edit, diff; inline blocks write/trash/restore можно извлечь в parseWriteArgs/parseTrashArgs/parseRestoreArgs только с exact исходным getter-порядком. Hash parser без изменений.

Для list: parser, нормализация extensions и compileGlob чистые, но normaliseExt ещё используется форматированием. Перенести его один раз и сделать intentional internal export в list-contract; execution импортирует тот же helper, без второй копии. DEFAULT_MAX_ENTRIES также используется output budgets: импорт единственного constant допустим. Entry rendering/types оставляются в execution.

Для glob/grep: нынешние parseArgs зависят от resolveUserPath (осуществляет home/platform path policy); не импортировать этот owner обратно в metadata. Сохранить parseArgs в execution в этом механическом блоке, либо отдельный fs-*-args.ts с единственным inward import ../expand-home.js, только если before-source proof подтверждает body unchanged. Рекомендация — оставить эти два parsers по существующему месту, явно связать их behavior tests с canonical wire schema. Нет обязанности объявить весь runtime parser автоматически порождённым из JSON Schema.

locate_project parseArgs использует node:path.basename и normalizeForMatch из fs-locate-project-sources.ts, в котором живёт filesystem discovery. Оставить parser там, не импортировать discovery execution в contract и не копировать normalizeForMatch. Canonical args wire contract + текущий parser seam tests достаточны.

watch: async parseArgs делает path validation → resolveUserPath → await stat (catch превращает любой отказ stat в path-does-not-exist) → timeout/recursive/events/ignoreInitial/maxEvents/stopAfterFirst. Оставить effectful parseArgs в execution; при желании вынести только уже чистые parseTimeout/parseEvents/parseMaxEvents и WatchArgs/WatchEvent в contract, сохранив точное место вызовов ПОСЛЕ stat. Public WatchEvent из execution остаётся compatible reexport. Нельзя читать остальные raw fields до stat, переносить stat из try/catch или менять missing-path-versus-invalid-timeout precedence.

patch: async parseArgs сначала читает ОБА patch и patchPath, выбирает inline patch либо await readFile(patchPath), и лишь затем читает apply/rootDir/fuzzFactor/stripComponents. Оставить pipeline в execution; допустим перенос чистого parseNonNegativeInt/args type в contract с теми же calls. Не захватывать поздние options до чтения patch-файла. Patch parser, dry-run/apply/input guard/approval/restore/output algorithms не переписывать.

Так boundary честно сохраняет contextual validation у IO владельца. Это намеренные исключения из pure parser extraction, а не conformance exemption для metadata/roles/schemas.

## 3. Exact write sets

Production:

- 12 новых fs-*-contract.ts выше; существующий hash-contract только если required internal generic fixture types действительно нужны, иначе byte-identical.
- 12 corresponding fs-*.ts: only definition projection imports, exact parser/type/helper extraction и compatible old exports; не execution algorithms.
- src/prompt/default-tool-descriptors-a.ts.
- src/prompt/default-tool-args-schemas.ts.
- src/agent/tool-resource-class.ts.

No edits tool-registry/roles/read-target policy/approval algorithms/os index/runtime bootstrap/grammar/LLM adapters/config owners/load-config/package/dependencies. Их existing tests используются как evidence. fs-locate-project-sources/restore-store/input-guard/patch-preview/shell files untouched.

Tests (выбрать точные имена до writes):

- src/tools/os/fs/fs-read-contracts.test.ts и fs-operation-contracts.test.ts — canonical family projections и parser semantics; negative conformance fixtures в общем gate.
- Новые narrow parser seam tests рядом либо расширить existing соответствующие *.test.ts, только где существенные gaps.
- src/tools/tool-contract-conformance.test.ts — full static catalog/registration/schema/class/tier/role inspection и negative fixtures.
- src/runtime/tool-contract-composition.test.ts — фактический runtime registration/config-filter seam, если coverage нельзя достоверно получить existing bootstrap/filter tests.
- src/prompt/default-tool-args-schemas.test.ts и существующие role/tool-view/OpenAI tests только при необходимом новом assertion, не golden rebaseline.

Документация/integrator:

- src/tools/os/fs/README.md, src/tools/docs/contracts.md, src/tools/README.md, src/prompt/README.md, src/agent/README.md.
- docs/plans/05l-filesystem-contracts.md, docs/testing/stage-05l-validation.md, docs/testing/stage-05-validation.md.
- docs/plans/05-config-tool-contracts.md и project-reorganization.md с verified только после приёмки.
- scripts/check-imports.mjs и scripts/check-imports.selftest.mjs: запрет metadata → composing/execution owners с positive/negative fixture. Не invent новый checker.

Не требуется новая npm command: gate входит в уже configured Vitest/full PR CI. Не добавлять production API только для тестового enumeration.

## 4. Общий conformance gate: что он доказывает

Инспектор получает реальные массивы descriptor/registration ДО name Map, lookup JSON schemas, taxonomy queries и role queries. Возвращает actionable issues с tool name и facet; test-only, без production validation layer. Не заменять фактические registrars самостоятельно набранным массивом фальшивых definitions.

Full static fixture вызывает existing registrars/builders: registerOsTools, buildBrowserTools, registerVerifyTools, registerGithubTools, registerSkillTools, buildToolViewTool, registerMemoryTools, registerVisionTools, registerTaskTools, buildFusionDelegateTool; reply/finish definitions и 4 MCP meta builders из mcp-resource-tools/mcp-prompt-tools. Хранить RecordingRegistry registrations array до Map как в 05c. Все family options включены, stores/registry создаются на disposable state paths с typed actual objects; никакие run не вызываются. Browser/provider/fusion dependencies typed explicit fakes без casts/allowances, approval handler throws при вызове. Для MCP meta можно использовать actual McpManager с zero servers (constructor безопасен), без start/connect; это не dynamic server fixture. Persist web cache выключен.

Фактическое runtime wiring проверяется separately от fixture: existing bootstrap seam либо новый isolated runtime test с skipLlamaHealthCheck/fake BrowserBackend и включёнными memory/tasks/vision settings. У runtime регистрируются read-scope wrappers через повторный registry.register: это НАМЕРЕННАЯ decoration, поэтому нельзя назвать все события register static duplicates. Static duplicates ловятся unwrapped registrars fixture; runtime итог сравнивается с соответствующим gated expected set. Если interception нужен до Map, phase «static registration» и «confineReads decoration» должны различаться явным known caller/phase, не глобальным ignore duplicate name. MCP hot reload/replacement также отдельный lifecycle, не static duplicate.

Проверки глобального каталога:

1. Unique static descriptors с тремя точно зафиксированными существовавшими Git duplicate исключениями (полные ordered fingerprints и позиции, owner/reason), unique static registrations before Map; missing/orphan names обнаруживаются по union, не только foreach descriptors. Actual descriptor/schema order закреплён before snapshot.
2. Все static descriptors имеют схему, она equals attached argsJsonSchema; object properties/required/additionalProperties имеют shipped shape. Для семейства exact canonical projections + независимый baseline literal/snapshot (все consumers могут ошибочно измениться вместе).
3. Schema-only orphan names тоже выявляются. Private schema Map не экспортировать в production ради теста: test-only TS AST inventory читает существующие Map tuple key expressions (string literal или imported canonical.name), разрешает imported canonical name из проверенного leaf. Не eval arbitrary code/regex runtime parsers; unsupported key expression должен fail с местом, а не silently skip.
4. Все built-in registered names имеют известный static resourceClass, не unknown; class matches canonical contracts для core 13; остальные получают формат и actual lookup, без недоказанного semantic equality. Unknown synthetic name по-прежнему fail-closed; dynamic resolver не override static class. Не требовать readonly↔pure_read equivalence: browser/vision/verify/fusion имеют специальную execution/batching политику.
5. tier undefined означает frequent, rare означает discovery; другие значения отклоняются. Rare и outside-role descriptor доступен through tool.view; frequent in-role load отказ сохраняется. Tests не выводят role из tier/class.
6. Все TOOL_ROLES проверяют ordered descriptorsForRole/partitionByRole и loaded union, wire + grammar names. Имя вне роли может загрузиться; enum/filter order сохраняется. Prefix rules verify./mcp. не требуют, чтобы каждый потенциальный dynamic name присутствовал в static fixture.
7. Explicit exceptions inventory в тесте/guide содержит имя/категорию, owner и reason; selector ограничен, no catch-all startsWith exemptions для static built-ins. Unused exception, new orphan и неожиданное расширение prefix fail.

### Обязательные intentional cases

- Исправление исходного read-only предположения: reply/finish входят в DEFAULT_TOOL_DESCRIPTORS, зарегистрированы и имеют default JSON schema. Adapter supplies native terminal schema overrides и role bypass/dedup; reply ends turn, finish session; builder finish admission false. Это named transport exception, не missing descriptor.
- Conditional registration: memory profile/notes/lessons/procedures; tasks требуют tasks.enabled && agentToolsEnabled; vision enabled + provider wired; browser bootstrap only when config.browser.enabled. Проверять positive и disabled instance, а не требовать весь static catalog в каждом runtime.
- Catalog visibility и registration gates не всегда равны: webSearch/email/github/fusion definitions остаются registered, descriptor filter зависит от доступности/режима. Browser: фактический bootstrap сейчас conditional; старый comment filter-disabled-tools о «stay registered» нельзя взять за доказательство current behavior.
- MCP meta static 4 names появляются после enabled start/live add, meta registration once; static descriptors gated mcp availability. Server-qualified MCP tools имеют external schemas/dynamic class/refresh; separate dynamic fixture проверяет lifecycle and replacement, не требует canonical built-in metadata owner.
- Unknown caller-injected tools/third-party definitions не в static fixture; unknown class remains conservative. Не дать custom injection скрыть отсутствующий shipped registration.
- Core role truth: builder reads кроме locate_project; builder writes write/edit/patch/restore, но НЕ trash. Orchestrator reads including locate_project, без mutation; full допускает всё. Archive reads исключены у builder и включены у orchestrator — покрываются глобально, хотя вне extraction.
- Core read scope: read/list/hash/watch path; glob cwd wins path и отсутствующий аргумент даёт[]; grep path; diff only aPath/bPath, не text sides. locate_project intentionally no READ_TOOL_TARGETS mapping (bounded search current/ancestor/recent/configured roots). Не добавлять mapping ради uniformity. Archive/read_document mappings сохраняются.
- Approval categories: write/edit/patch/restore fs_write workspace/home/trust_config/other, trash fs_trash/trust_config/other, archive.extract fs_write_home/other. fusion solo независимо ordinary categories; не нормализовать исключение к mutation classifier.

## 5. Behaviour tests и negative proofs

Основой остаются existing fs/registry/args/coercion/input/restore/read-scope/class/batch/role/tool-view/strict-schema suites. New cases только seams, которые unit helper без registration/schema не проверяет.

Family coverage:

- read offset/limit/lineNumbers and byte default; list pattern/extensions/sort and listing helper reuse.
- glob cwd-over-path/workingDir default/filter array/sort; grep path default, regex string, glob string-or-array, output mode/context defaults and integer handling.
- edit empty replacement allowed, equal old/new rejected; diff path/text alternatives and labels; errors/getter order unchanged.
- write eager path+content reads before validation, mode permissive default and overwrite===true; input guard/approval before actual writes, existing request/declared inputs unchanged.
- trash array max500; runtime String(v) coercion deliberately broader than wire string array; no native personal Trash invoked. Mock native action through existing seam, temp paths only.
- restore no-store/lookup/path/approval precedence and recovery bookkeeping unchanged.
- watch missing path plus invalid timeout yields existing missing-path error; timeout1..60000 cap, max-events cap10000, events case/empty/duplicate rules; suffix raw getters not read until awaited stat succeeds.
- patch inline patch wins patchPath after both raw getters; patchPath IO failure precedes invalid later fuzz/root fields; no premature apply/options getter capture; dry-run/apply/error/restore existing checks.
- locate_project pasted Windows/POSIX path-segment normalization, NFC/lowercase and limit1..25 defaults8; no roots IO moved into metadata.
- hash null algorithm/encoding defaults, uppercase algorithm accepted while wire lowercase enum; encoding remains case-sensitive.

Negative inspector fixtures must demonstrably fail: missing/duplicate descriptor, missing/duplicate static registration, missing/schema-only orphan schema, wrong required/enum/additionalProperties/order, descriptor args schema mismatch, readonly/description/class mismatch, unknown class, unknown tier, broken rare discovery, role accidental trash/locate admission change, filtered disabled name still advertised, unscoped exception and unused exception. Avoid asserting runtime must accept every schema-valid value (custom guards enforce nonempty/path exclusivity/security) or vice versa; document intentional schema/runtime widening with concrete cases.

## 6. Baseline и механический proof до/после

Fresh immutable snapshot после acceptance05k, ДО первых writes. Не reuse исходный05c snapshot как текущий baseline. Capture full src, public runtime and TS type exports, package/lock/compiler config, debt ledger, protected artifacts.

Pin full catalog+JSON schemas+classes+approval categories+role order, static registration call arrays, default/strict native wire schemas, role loaded cases и stable prefixes для всех трёх roles, используемых transport paths и существующих profile fixtures (точный состав фиксируется до writes), плюс representative loaded core tool for each rare family and out-of-role locate/trash. Verify key order as serialized bytes; no golden regeneration to silence change. Existing prompt literals/grammar untouched.

Source proof per owned declaration: exact metadata text/schema literals, parser bodies/helper tokens/defaults/errors/types/comment ownership; allowed AST identifier/import substitutions и named projections only. For extracted inline blocks proof restores block at original location, keeping raw getter/evaluation order. List shared helper only moves once. Async watch/patch non-owned remainder byte-identical aside from imported pure helper calls if used. All source files outside exact write set byte-identical, включая config/version/ENV/migrations, OS register order, roles/read scope/approval guards.

No algorithm fixes/schema tightening/default/version changes mixed with migration. Any observed bug becomes explicitly recorded later behavioral task, not unexplained before/after difference.

## 7. Проверки и закрытие всего этапа 05

Focused fs + core conformance + runtime composition + prompt/schema/roles/tool-view/read-scope/coercion/classification/batch/OpenAI/plain-strict seams pass. Full acceptance: npm run lint; typecheck:tests (no new allowance; genuine corrections reduce ledger); imports:check + changed checker self-tests; docs:check; npm run build; quarantine registry/self-tests and npm run test:ci. Actual counts/skips/log exit captured, no duplicate full runner in parallel. No new cycles/ownership exceptions/dependencies.

Final stage05 config acceptance сравнивает immutable pre05 shipped config contract и final owners, а не только последнюю маленькую slice:

- Public named exports runtime identity/signatures/types shapes, order/optionality user/runtime differences, ConfigValidationError identity/field/messages.
- USER_CONFIG_VERSION74/SUPPORTED_INPUT_VERSIONS acceptance and historical branch thresholds, default objects/identity/keyorder/fresh factories, mutable defaults callbacks, ENV precedence and persisted JSON unchanged.
- Existing full schema/load/config-file suites плюс owned migration matrices: reasoning/localModels pre41, memory v22/v65, HTTP24/25, presence-driven approval, legacy trace merge, config aliases and known keys. Existing root migration/composition responsibilities уже проверены срезами05a–05k и намеренно остаются в root; не переносить их ещё раз ради нулевого размера schema. Использовать existing acceptance evidence плюс final API/version/default diff и существующие suites: не создавать новую универсальную migration engine или исчерпывающий второй snapshot всех старых slices ради финальной галочки.
- Root schema documented as explicit composition/version/ENV compatibility owner; leaving log/analytics small settings inline intentional. Existing public imports stay supported; new internal consumers can go directly to actual owner.
- Five navigation exercises with measured sources/check commands: изменить prompt; добавить FS tool; изменить version migration; MCP UI fix; изменить model download. Дополнительно config policy change and rare/out-of-role tool metadata change show bounded owner routes, не требуют читать весь catalog/schema. Записать фактические чтения/неясности, не объявлять измеренное ускорение заранее.
- Existing first-stage instruction-loading fresh-session proof не подменять текущей сессией. Если новых automatic instructions нет, достаточно подтвердить routes и сохранённые budgets; повторить fresh load только при действительном изменении instructions.
- Review final diff/protected files, API/production literals/default/version hashes; document evidence limitations/external evals, которые не запускались. Нет API/algorithm claim без проверки.

После всех критериев: 05l verified, этап05 verified, общий маршрут обновлён; сохранить stage-05-validation с фактическими config/tool boundaries и доказательствами. Затем специфицировать один этап06 runtime contract/composition/lifecycle. Stop criteria достигнуты, когда13 core contracts имеют одного metadata owner и проверенные parser exceptions, глобальный gate ловит нарушения всех static representations с именованными exceptions, финальная config/API/version/routes matrix и integration checks проходят. Полное переписывание остальных tool contracts, zero test debt, монорепозиторий и agent loop decomposition НЕ являются остатком этапа05; после этих критериев работу05 завершить, не искать новый alphabet slice.

## Уточнения по фактической реализации

Три старых Git duplicates не удаляются: это поведенческое изменение stable prefix/discovery/native wire. Gate запрещает изменение/расширение/неиспользуемые исключения; [отдельное предложение](../proposals/tool-catalog-deduplication.md) описывает устранение. Canonical leaf не заменяет независимый before/after baseline: иначе все consumers могли бы ошибиться вместе. Final evidence фиксирует эти пределы без заявления чистого каталога.

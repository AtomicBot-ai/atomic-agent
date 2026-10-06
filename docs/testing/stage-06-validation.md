# Приёмка 06: runtime contract и сборка ресурсов

Status: verified
Owner: src/runtime/

Проверяется [план06](../plans/06-runtime-composition.md). Fresh immutable baseline после verified05: bootstrap4319 строк; конфигурация, package/compiler/CI, grammars и type debt848 сохранены отдельно до edits. Две параллельные волны переносили независимые новые owners; только integrator изменял bootstrap/checker/docs. Universal failed-start rollback, перестановка shutdown и алгоритмы AgentLoop не входили в работу.

## Результат и механизм

Публичные RuntimeEventHandlers, CreateAgentRuntimeOptions и AgentRuntime перенесены в runtime-contract.ts с прежними declarations/comments/member order и type-only dependencies. Bootstrap сохраняет пять прежних public symbols: три type exports, createAgentRuntime и managedLocalLlmHealthFailureHint. Нет нового публичного barrel.

13 construction owners выделяют observability, traces, local profile, inference, memory stores/services, lifecycle, skills, tool/MCP catalog, sessions, turn service, tasks и channels. Bootstrap сохраняет последовательные phases, AgentLoop deps и стабильный façade. Первоначальные состояния вроде catalog/cache/trace maps и shutdown flag находятся у своего owner; forward references читаются late. Каждый SQLite handle имеет named ownership: derived memory stores borrow notes connection, Profile/Lesson/Procedure own отдельные connections даже в одном файле.

Для refresh сохранены live skills/dropped/tool descriptors и loop grammar/provider capabilities. Public runtime.grammar остаётся snapshot, local profile manager имеет отдельную grammar. Already-locked sidecar executeTurn не входит повторно в FIFO; public runTurn входит. Task registration остаётся перед fusion/read confinement; consolidator.start перед channels; scheduler.start после channels. Shutdown order, grace1500, concurrent second-call return и существующая граница failed-start cleanup сохранены.

Generic reverse disposer и параллельный runtime startup отвергнуты: они меняют доступ к shared resources и порядок закрытия. Параллельность применена к работе разработчиков над disjoint files. [Lifecycle](../../src/runtime/docs/lifecycle.md) и [отдельные follow-ups](../proposals/runtime-grammar-and-lifecycle.md) не обещают универсального rollback или полного producer drain.

## Доказательство эквивалентности

42 ordered root relocations восстановлены из двух immutable snapshots. Phase/helper bodies, literals/error text/key order/comments сверены exact text или TypeScript AST с явным списком dependency substitutions. Независимый source proof: exact3 interfaces/43 type-only imports;29 trace/telemetry statements+2 helpers;6 inference phases/634 unchanged lines+2 helper groups;27 memory checks;9 skill/tool spans/35 statements;5 session/turn phases/597 wave1 lines и8 исходных turn declarations;6 task/channel checks. Root import pruning основан только на unused-import diagnostics; whitespace-only normalization и раннее чтение initialGrammar отдельно записаны.

Owned prose corrections ограничены фактическими утверждениями: ProcedureStore owns connection; MCP refresh работает без restart и meta tools conditional-on-servers; root phases больше не один implementation file; approval callback читает options.handlers поздно. TypeScript algorithms остальных2435 прежних non-Markdown source files byte-identical. AgentLoop/step/batch, config/default/version/migrations, prompt literals, tool schemas/classes/roles/wire, protected24812 hashes, package/lock/compiler/CI/grammars и debt registry byte-identical.

Actual disposable runtime до/после: export names, ordered property descriptors/getter flags, boot grammar, effective descriptors и registry order совпали побайтово. TypeScript proof: exact declaration text плюс bidirectional assignability по прежним domain type identities.54 catalog artifacts, включая18 stable prefixes для3 roles ×2 transports ×3 profiles, совпали с принятым05 baseline. Источник config не изменён;1602 cases/26 scenarios предыдущей приёмки сохраняются как baseline, новый config experiment не заявляется.

Import checker запрещает composition→bootstrap, runtime-contract→implementation, runtime-loading type contract и external consumer→composition, включая type/dynamic imports.33 новых negative/positive fixtures сначала обнаружили отсутствие guard, затем общий набор221 прошёл; исключения в ledger не добавлялись.

## Проверки

Первая coherent wave1:50 suites/333 tests passed; public facade/type proof passed. После wave2: runtime/sidecar/HTTP seams56 suites/380 passed; полный PR runner1072 suites/12884 passed/4 existing skips. lint/build passed; types2452 roots/105TSX/848 existing/no new errors; imports1400 modules/5162 local edges/0cycles/0exceptions; checker221, quarantine0 active/2 released и self-test8 passed.

Финальная приёмка:1074 suites/12889 tests passed/4 existing skips; types2454 roots/105TSX/848 explicit existing debt/no new errors; lint/build passed; imports1400 modules/5162 edges/0cycles/0exceptions. Whole-bootstrap3 tests подтвердили26 distinct runtime resource identities, работоспособность второго после shutdown первого, deferred persistence/trace isolation и ordered startup/early seed error. Ещё2 tests подтвердили actual MCP rejection после открытия stores/no later phases/no implicit close и actual consolidator.start →channel assignments/shutdown refs →scheduler.start. После уточнения последней fault fixture targeted16/16 и окончательный type gate прошли; source proof и facade/type comparison тоже проходят.

Documents: active links/metadata/pointers/archive coverage и instruction budgets проходят;19 instruction files, max chain8093/24576 bytes. Docs self-test11; imports self-test221; quarantine0active/2released+self-test8; git diff --check passed. Bootstrap4319→644 строки, contract556;13 recipe owners с13 adjacent suites плюс2 whole-bootstrap suites. Source relocation отделена от новых meaningful assertions; API/config/prompt/алгоритмы не изменены.

## Честные ограничения и исправленные сбои

Во время wiring обнаружились пропущенный localBackend binding и лишние imports; исправлены до успешного facade/lint. Channels component сначала потерял внутренний mutable façade type intersection при сохранённом public readonly contract; intersection восстановлен без casts/смены API. Новые test fixtures уточнены по реальным interfaces (включая shell endAll result и capture full shell handle на registrar boundary вместо narrow delete-hook argument). Первый неверный вызов scoped test runner завершился Usage error; приведённые успешные counts относятся к исправленным командам. Нет новых type allowances или any/as-unknown мостов.

Live GPU/provider/platform eval и одинаковые задачи разработки для измерения продуктивности не выполнялись. Уменьшение bootstrap и новые маршруты не объявляются измеренным ускорением. Agent instructions не менялись, поэтому новую сессию для проверки обновлённой автозагрузки не выдаём за выполненную. Остаются848 type diagnostics и4 existing skips; historical lifecycle и grammar limitations вынесены отдельно.

## Навигация

Пять маршрутов проверены по реальным файлам: bootstrap tool integration → tool-catalog/composition seam; provider hot swap → inference/local-profile/fallback seams; sidecar locked turn → turn-service/controller/sidecar concurrency; memory sub-call cancellation → memory-services/subcall seams; channel/store race → lifecycle/tasks/channels/bootstrap tests. Каждый начинается с [runtime guide](../../src/runtime/README.md) и [component routes](../../src/runtime/composition/README.md), затем требует только нужные mechanism docs. Архив и весь старый bootstrap не являются обязательным чтением.

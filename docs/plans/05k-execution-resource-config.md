# Срез 05k: оставшиеся политики выполнения, инструментов и ресурсов

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05j](../testing/stage-05j-validation.md); implementation завершена, [приёмка](../testing/stage-05k-validation.md) выполнена. Следующий [05l](05l-filesystem-contracts.md) specified; весь 05 ещё in-progress. Исходная база: root schema 2471 строка, 853 explicit test type diagnostics, 0 runtime cycles/exceptions, full runner 1052 suites / 12695 passed / 4 existing skips. Исследование фактических зависимостей уточнило всю оставшуюся группу config policies ниже; перед writes нужен fresh acceptance snapshot.

## Цель и конечная граница config decomposition

Одним согласованным срезом вынести оставшиеся содержательные config responsibilities: весь agent policy, outbound HTTP, shell/vision/project settings, skill sources, session retention и tracing. Root сохраняет composition/version histories/acceptance, known-key handling, ENV_DEFAULTS/bootstrap, маленькие log/analytics settings и существующие compatibility wrappers. Цель — завершить доменную организацию config, не довести root до нуля строк и не создать отдельный план на каждый scalar.

Ресурсы, их security enforcement и env precedence остаются current runtime/tool/session owners. Не переносить execution, approval gate/grants, LLM calls, retention deletion, trace writers, shell processes, vision inference или skill installation. Этот срез не runtime06 и не agent-loop07.

## Write sets и параллельность

Общий integrator: src/config/config-schema.ts, guides/plans/evidence/checker-policy/source-inventory. config/index.ts/load-config/current consumers и existing leaf owners byte-identical. Public names/type shapes/default/environment precedence/version74 и test debt853 не меняются без отдельно обоснованной genuine fixture correction/reduce.

Disjoint production ownership в3 agents:

- A — полный agent domain, новый src/config/agent/agent-types.ts, agent-defaults.ts, agent-parser.ts; новый agent-config.test.ts рядом. Runtime agent nested type около190 строк и user около77, плюс helpers/default/parser — согласованный directory вместо нового файла порядка500 строк. Нет mandatory index.
- B — новый src/config/http-config.ts и src/config/tool-config.ts; meaningful новый tool-policy-config.test.ts. tool-config owns stored shell settings и linked tool operation settings vision/project roots, с отдельными named types/factories/parsers на каждом root slot, не combined eager parse.
- C — новые src/config/skills-config.ts, src/config/session-retention-config.ts, src/config/tracing-config.ts; отдельные meaningful suites либо один coherent config-resource seam suite с imports этих concrete owners. Каждый file имеет собственную domain responsibility; их небольшой объём не требует numbered follow-up stages.

Итого8 new concrete production files +root. Shared new primitive не требуется: parseCapOrNull private у retention; остальные уже имеются. Leaf agents работают от immutable snapshot и не правят root/index. Root integrator wire-up последовательный после ready APIs; full gate один для всей группы. Файлы tests должны быть согласованы до writes, без пересечений.

## A: agent types/default/parser

Сохранить два ordered literals как RuntimeAgentConfig и UserAgentConfig, включая различия: runtime stablePrefixHashSalt/loaded-tool/batch/compressor/other env-only fields не добавляются в stored user JSON; parser создаёт только старый user shape. Все member comments/order сохраняются. Types inward type imports ApprovalLevel из existing approval-level и AgentTaskConfig/ProviderWaitConfig из existing agent-execution-config, без composing root/index imports.

Перенести public ReadScope/READ_SCOPES/parseReadScope, parseApprovalLevel и CONVERSATION_MAX_PAIRS_MIN/MAX; root сохраняет имена и re-exports same functions/array/constants. ApprovalLevel type остаётся existing direct neutral re-export (не новый owned type). Private resolveApprovalLevel получает callback для current agent defaults только в прежнем final fallback branch. Не менять existing agent-execution-config.ts: factories/parsers/null-default-reference semantics остаются byte-identical.

createAgentDefaults():UserAgentConfig возвращает exact current literal и в тех же positions вызывает createProviderWaitDefaults/createAgentTaskDefaults. Fresh object, existing fresh policies, exact defaults/keyorder/comments; no freezing/cache. parseAgentConfig(raw,readDefaults) заменяет exact late agent object на прежнем месте после log и до outbound HTTP.

Сохранить evaluation order tokenBudget→maxSteps→providerWait→nameSessions→task→toolTimeout→readScope→approvalLevel→conversation tokens/pairs/lowWater→session sections→world cap. policy default arguments читаются БЕЗУСЛОВНО после raw argument getter даже когда raw policy присутствует; нельзя превращать их в conditional scalar fallback. Scalar defaults per-expression, no captured default bundle. Missing policy blocks возвращают переданный default reference как existing leaf; новый agent parser не клонирует его.

Approval migration presence-driven на любой version: new nonnull wins, иначе legacy bool false→5/true→1, иначе current default без новой validation. Вызов раньше вычислял ОБА raw getters agent.approvalLevel и agent.approvalRequired до helper, даже если new wins; сохранить eager second argument. Не вводить inputVersion gating или short-circuit чтение legacy getter. parseApprovalLevel body/coerce/error exact.

conversationMaxTokens/sessionSectionsMaxTokens zero auto, pairs1..1000, lowWater(0,1], positive others; не clamp к task ceiling/model context и не применять sliding-window cap в config. Enforcement belongs execution/prompt. Все env-only fields/loadConfig/ENV_DEFAULTS bytes сохраняются.

## B: outbound HTTP и tool settings

http-config.ts owns separate ordered user/runtime HTTP shapes, HttpApprovalMode и pure parseHttpApprovalMode; private resolveHttpApprovalMode, fresh createHttpDefaults, parseHttpConfig(raw,inputVersion,readDefaults). Этот block обслуживает OUTBOUND os.http.request через src/tools/os/web/http-request.ts, не HTTP server ingress auth. Не импортировать HTTP server/tool execution.

Migration pre-v25 raw absent/null/writes→literal never без default lookup; explicit always/never preserved. v25+ raw??current approvalMode parsed; inputVersion остаётся исходным, не output normalized version. readDefaults внутри branch, not eager value argument. Other fields old enabled/hostAllowlist/maxResponseBytes/defaultTimeout order and fallback. Nullable host list preserves duplicate/whitespace/order and null vs[], no DNS/path/URL/SSRF checks added. Disabled HTTP still validates other settings; dispatch security unchanged.

tool-config.ts owns separate original types/literals for projects, tools.shell and vision, with three factories createProjectsDefaults/createToolsDefaults/createVisionDefaults and three late parsers parseProjectsConfig(rawProjects,readDefaults), parseToolsConfig(rawShell,readDefaults), parseVisionConfig(rawVision,readDefaults). Root retains early raw tools.shell reference and their nonadjacent original late slots: projects→tools before retention/tracing, vision after memory/webhooks before skills. No combined early parse or moved validation.

Project roots nullable-list parse then ??[]; default fallback per-expression, fresh parsed array, duplicates/whitespace unchanged; no directory stat/normalization or read-scope grants. Shell defaultTimeoutMs nonnegative0, jobMaxMs/maxJobs positive; no new relative timeout constraint or job runtime behavior. Vision bool/positive limits unchanged even disabled, no catalog/capability/inference imports. Owners depend only concrete primitives/values/error; original type comments/order and user/runtime shape differences preserved.

## C: skills, retention, trace policies

skills-config.ts owns two original ordered user/runtime shapes, DEFAULT_SKILLS_CATALOG_BUDGET512, SKILL_NAME_RE/TAP_REPO_RE, pure public parseSkillNameArray/parseSkillTapArray, fresh createSkillsDefaults and parseSkillsConfig(raw,readDefaults). Root imports constant for existing ENV_DEFAULTS.SKILLS_CATALOG_BUDGET and re-exports same name; no duplicate literal/current env lookup in owner.

Existing public parseClawHubConfig(raw):AtomicAgentConfig["skills"]["clawhub"] reads current mutable nested defaults at entry. Keep a thin root wrapper with EXACT old public signature calling internal parseClawHubConfigWithDefaults(raw,readDefaults). Leaf captures selected nested defaults once BEFORE absence/object validation, as old helper. parseSkillsConfig calls it after catalog budget→disabled→taps on original late slot before TUI; raw clawhub getter evaluated before default lookup. Absent/null fresh spread selected defaults, present block per-field fallback to captured d, unknown fields dropped; disabled still validated. URL stays general parseUrl/original bytes. Name/tap regex body/case/dedup/order exact, including current two-character minimum skill name; don't "align" with manifest policy here. Startup discovery/prefix invalidation unaffected.

session-retention-config.ts owns original runtime/user retention shapes, private parseCapOrNull unchanged body, createSessionDefaults/parseSessionConfig(rawRetention,readDefaults). Root retains early sessions.retention reference. Absent caps use fallback, explicit null disables rule, positive values preserved. BUT third default argument is evaluated eagerly for explicit cap/null too; preserve repeated/current default getter reads rather than private lazy callback. enabled false still validates caps, no prune execution/files imported. Whole results fresh, no extra zero allowance.

tracing-config.ts owns separate RuntimeTracingConfig/UserTracingConfig (runtime.trace.dir only), createTracingDefaults, prepareTracingInputs/parseTracingConfig. Move existing contiguous early raw legacy telemetry/tracing/subblock merge as a coherent helper in the SAME root position before memory preparation: obj.telemetry then obj.tracing, legacy trace then current trace, spreads legacy first/current last, getter reads during spread retained. Parent may leave this explicit preparation in root instead if smaller proof; decide before writes, no shifting toward late validation. Late parser uses the captured merged snapshot on original slot after sessions and before memory. Current trace fields override legacy even undefined; raw nullable enabled/default semantics unchanged, positive maxBytes and arithmetic default literal exact. No writer/dir creation/rotation/replay/resource imports. Alias retires from unknown top-level keys exactly as current root.

## Proof and acceptance

Before edits fresh whole src/package/compiler/debt/protected snapshot and defaults/version/ENV/runtime-export/type baseline. Actual immutable old graph vs current through tsx; no personal state/network/providers required. Source proof expands every owned type, exact literals/public helper bodies/regex/constants, late expressions/early trace merge modulo recorded identifier/default-thunk substitutions, public-wrapper intentional substitutions; other root/source/index/env bytes unchanged.

Use AST IDENTIFIER-only renames; do not replace words inside error string literals. 05j focused tests caught an unrelated bare Discord identifier plus renamed raw.enabled error path before acceptance; new proof must explicitly assert unchanged field/message strings and reject orphan identifiers. Public pure function/READ_SCOPES identity, regex semantics and wrapper behavior, old default/reference/ordered-output matrices separately verified.

Behavior/precedence matrix: full versions/future acceptance,24/25 HTTP and presence-only approval migration, new-vs-legacy invalid pairs; raw getters for both approval args, policy default eager reads, HTTP branch lookup skip, retention explicit-null eager fallback lookup, ClawHub captured defaults vs within-call outer replacement; trace legacy/current getter/spread precedence, early retained shell/retention inputs; fresh vs intentional absent policy references. Numeric/string/null/zero/list/permissive blocks, disabled validation, no added clamps or cross-field invariants. Every mutation restored in finally.

Existing first: config-schema/load-config/config-file/agents-md-defaults +agent-execution-config. Downstream seams: prompt token-budget/conversation-cap-auto/build-prompt-world-conversation, conversation pairs/session-retention, actual approval/read-scope suites, shell-jobs, fs-locate-project, outbound http-request/retry, vision describe/load-image, skill registry/catalog/manifest/ClawHub sources, trace recorder/sink/bus. New tests target ownership/default/migration/cross-domain seams instead of mirroring all scalar validators. Integrator runs lint/full test types/imports/docs/build/quarantine/full test:ci plus changed checker self-tests, no new SCC/exceptions/allowances.

After this group config source organization may be accepted with root's intentional small log/analytics/bootstrap/assembly left inline. Stage05 still needs tool-contract family expansion/conformance gate beyond hash prototype and final migration/public API/navigation evaluation. Specify that bounded remaining work after actual05k acceptance; no fabricated ETA or claim that runtime/agent-loop stages have already been completed.

# Срез 05j: TUI, каналы и интеграционные настройки

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05i](../testing/stage-05i-validation.md); [Приёмка 05j](../testing/stage-05j-validation.md) завершена; следующий [05k](05k-execution-resource-config.md) specified. База: root schema 3222 строки, 853 explicit test type diagnostics, 0 runtime cycles/exceptions, full runner 1049 suites / 12642 passed / 4 existing skips. Исследование фактических зависимостей уточнило целую группу ниже; перед writes требуется fresh acceptance snapshot.

## Цель и граница

Перенести сразу всю согласованную группу frontend/channel/integration config responsibilities, сохранив порядок сборки и публичный API. Три самостоятельных leaf owners могут создаваться параллельно: TUI; Telegram/Discord/swarm; notifications/mail/git/composio. Их связывает существующая корневая config composition, а не общий lifecycle. Принимать группу одним integration gate, не вводить отдельные numbered slices для каждого boolean.

В отличие от крупных memory/localModels, каждый owner ожидается примерно250–450 строк; types/default factories/parser можно держать в одном concrete file по ответственности без трёх пустых каталогов или обязательного index.ts. Если фактический объём существенно больше, уточнить локальную структуру до writes, но не менять владение.

Analytics.enabled остаётся маленькой явной assembly section root: это собственный analytics opt-out domain, не TUI terminal setting. Root также оставляет version histories/acceptance, unknown-key rules, bootstrap/env values, late domain order. Runtime frontends/channels, delivery, pairing, owner verification, credentials, service/network lifecycle, git approval и MCP/Composio connection algorithms не меняются.

## Production write set и parallel ownership

Shared integrator write set: src/config/config-schema.ts и src/config/config-values.ts.

Disjoint leaves:

- A: новый src/config/tui-config.ts; meaningful новый src/config/tui-config.test.ts.
- B: новый src/config/channel-config.ts; новый src/config/channel-config.test.ts.
- C: новый src/config/integration-config.ts; новый src/config/integration-config.test.ts.

Integrator архивирует fresh baseline, заранее переносит shared private parseNullableString из root в config-values.ts с intentional internal export и exact body. Старые parseUrl/parseStringArrayOrNull bytes и root public exports остаются прежними; parseNullableString не становится новым root/index export. Leaf agents только читают shared source и snapshot, не редактируют root/index/values. После ready сигналов один integrator переносит root declarations/default/parse sections, compatibility exports/wrappers и документацию/checker policy. Итого5 production files: три новых leaf owners плюс existing values/root, no overlaps. Three leaves+root помещаются в4 agent slots; каждый leaf agent может владеть своим новым suite. Альтернатива в2 agents — A frontend, B channels+integration с теми же disjoint paths, без изменения границ domain.

Existing config/index.ts, load-config/config-cache/config-file, consumers, current tests, concrete services и protected source byte-identical. Только integrator может отдельно корректировать source inventory новых types в existing documentation tests без ослабления regex/floors/allowlist; реальные fixture fixes документировать отдельно. Нет новых packages/dependencies/version/diagnostic allowances/import exceptions.

## TUI owner

Owned existing public types: TuiNotifyConfig, WhileBusySubmitMode, OnboardingState. Новый внутренний TuiConfig из совпадающих runtime/user nested shapes, сохраняя property order theme/whileBusySubmit/mouse/onboarding/sessionRail/notify; обе outer property JSDocs остаются на корневых members. type-only SessionRailConfig import и actual parseSessionRailConfig import из existing owner; прежний rail owner/public exports остаются byte-identical.

Owned defaults createTuiDefaults():TuiConfig возвращает exact прежний literal: theme/whileBusySubmit/mouse, затем notify/sessionRail/onboarding с прежним отдельным ordered onboarding defaults literal. Все nested objects/rail arrays свежие, mutable; вызов один раз на прежнем USER_CONFIG_DEFAULTS.tui месте. Не переставлять default keys в order parser/types.

Pure public parsers parseWhileBusySubmit, parseTimestampOrNull, parseThemeName сохраняют signatures/bodies; root реэкспортирует те же functions. parseThemeName trims strings и пустой string становится auto, но неизвестный nonempty theme принимается: не импортировать TUI theme registry. parseTimestampOrNull использует Date.parse и возвращает исходную nonempty string; нынешняя фактическая permissiveness остаётся, не новый strict ISO regex.

Два нынешних public API имеют скрытый default lookup: parseOnboardingState(raw) и parseTuiNotify(raw). Их невозможно сделать root-independent, сохранить один argument и same-function re-export одновременно без нового глобального mutable binding. Поэтому root сохраняет две тонкие compatibility wrappers с прежними публичными signatures, вызывающие новые leaf helpers parseOnboardingStateWithDefaults(raw,readDefaults:()=>OnboardingState) и parseTuiNotifyWithDefaults(raw,readDefaults:()=>TuiNotifyConfig). Helpers получают текущий default через callback ровно один раз в начале, как прежние const defaults/d. Не менять root public exports; эти internal helper names не добавлять туда. Function identity утверждается только для трёх pure re-exports; two wrappers намеренно являются compatible composition functions. Запретить global configureDefaults()/cache и imports root из owner.

parseTuiConfig(raw:Record<string,unknown>,readDefaults:()=>TuiConfig) переносит exact late TUI object. theme/busy/mouse текущие defaults читаются per-expression с short circuit. onboarding raw getter вычисляется раньше entry-default lookup своего helper; sessionRail затем notify. Notify/onboarding выбирают nested default один раз при entry и удерживают его до конца своего вызова; нельзя сделать per-field refreshed thunk или defer lookup после object validation.

Onboarding absent/null возвращает fresh spread выбранного default со всеми его enumerable keys и без field validation. Present block non-array object принимает current Date/class permissiveness, валидирует шесть полей и отсутствующие/null stamps даёт null независимо от mutated defaults. Notify absent/null fresh spread nested default; present block проверяет bool/неотрицательный duration с capture текущего nested d. Unknown fields discarded на present path. Whole rawTUI normalization остаётся ранней root cast/??{}; новых strict whole-block checks нет.

## Channel owner

Перенести пять public declarations: TelegramParseMode, TelegramConfig, DiscordConfig, SwarmUnitConfig, SwarmConfig, сохраняя exact property/comments/types. Existing public SWARM_UNIT_ID и parseTelegramOwnerId/parseDiscordOwnerUserIds сохраняют signatures, exact body/object identity при root реэкспорте. Private parseTelegramParseMode, parseSwarmUnits, DISCORD_SNOWFLAKE_RE, SWARM_TOKEN_ENV, SWARM_LABEL_MAX40, SWARM_ROLE_MAX120 — owned leaf. Shared parseNullableString импортируется из values, not integration owner.

createTelegramDefaults/createDiscordDefaults/createSwarmDefaults возвращают каждый exact прежний literal на прежних default positions; fresh arrays/objects. New internal parseTelegramConfig(raw,readDefaults), parseDiscordConfig(raw,readDefaults), parseSwarmConfig(raw) замещают три late literals на их старых местах. Telegram fields order enabled/ownerUserId/parseMode/progressIndicator, Discord enabled затем ownerUserIds, swarm units. Свежий readDefaults per-expression только там, где root его уже делал. owner arrays и swarm units НЕ fallback к mutable USER_CONFIG_DEFAULTS: отсутствие читает legacy/empty semantics прежнего helper.

Actual contracts:

- Telegram id — Number conversion для number/string, positive finite integer <=MAX_SAFE_INTEGER; прежние accepted whitespace/exponent/hex numeric strings не ограничивать общим scalar integer validator. Null/undefined→null; empty/zero invalid.
- Discord list при present wins over legacy scalar, включая explicit empty list; null/undefined list fallback к legacy. Scalar trim через shared nullable string; list entries не trim. 15–25digits, numbers rejected, stable first-occurrence dedup. Это presence-driven migration на любых versions, не version gate.
- Swarm absent/null→fresh[]; Array.map сохраняет нынешние sparse-array holes; reject invalid existing entries. id slug unique; tokenEnv uppercase env name unique только внутри units, не с primary channels. role absent/null→empty, иначе string <=120; label nonempty <=40; owner nullable trimmed string принимает1–25digits без kind-specific runtime checks. Exact repeated raw.kind/role accesses и validation order сохранены.
- Swarm validates ownerUserId before enabled, хотя enabled раньше в returned key order. Disabled channel/unit не пропускает остальные checks. No secret resolution, token value check, pairing, network/start timers.

## Integration owner

Owned five public declarations: DownloadNotifyChannelSetting, NotificationsConfig, AtomicMailConfig, GitConfig, ComposioConfig. Existing pure public parseDownloadNotifyChannel root реэкспортирует unchanged function. Private parsePendingVerification moves exact body. Imports error/primitives/shared parseNullableString only, no service/runtime/MCP or TUI modules.

createNotificationsDefaults/createAtomicMailDefaults/createGitDefaults/createComposioDefaults — exact fresh literals на прежних default locations; no shared bundle object/default caching. Internal parsers для каждого root key отдельно: parseNotificationsConfig(rawDownloads,readDefaults:()=>NotificationsConfig), parseAtomicMailConfig(raw), parseGitConfig(raw,readDefaults:()=>GitConfig), parseComposioConfig(raw,readDefaults:()=>ComposioConfig). Root сохраняет раннее notifications.downloads reference; notifications parser получает этот retained subblock и не перечитывает rawNotifications.downloads late. Эти four calls занимают прежние late positions notifications→atomicMail→git→composio, без раннего eager combined parse.

Actual contracts:

- Download channel direct parser undefined/null→null, allowed telegram/discord/email/off case-sensitive. Whole config делает raw.channel??current default; explicit null может принять non-null mutated default — сохранить distinction direct vs composing API.
- Mail nullable fields и composio cache fields trims whitespace/blank→null. Mail parsing целиком игнорирует USER_CONFIG_DEFAULTS.atomicMail и always produces normalized raw/null values; не добавить fallback. ownerVerifiedAt/expiresAt не проходят Date.parse; email не проверяется email regex, codeHash не SHA256 regex. Это runtime/service policy отдельно.
- pendingVerification absent/null→null; present object non-array; email/codeHash/expiresAt нужны как nonblank strings; attempts при numeric>=0 Math.floor, иначе0. Infinity сейчас сохраняется, NaN→0; не вводить bound/finite/attempt ceiling.
- Git remoteSync — нынешний raw??default bool; parser не выполняет git и не меняет approval/network verb policy.
- Composio enabled/apiKeyEnv используют нынешние bool/nonempty defaults; nonempty env name строка не проходит uppercase-env regex. userId/sessionId/mcpUrl nullable trim без URL validation/default fallback, no UUID/credential checks.

## Comments и общая composition

Read guides обоих endpoints до writes: config/compatibility; TUI; channels; atomic-mail, composio, notifications, integrations; underlying approval/MCP instructions при чтении их contracts, но algorithms не менять.

Root содержит misplaced comments: Telegram channel JSDoc стоит перед Discord JSDoc — перенести Telegram к Telegram declaration и Discord к Discord; TUI theme parser JSDoc стоит перед WhileBusySubmitMode — перенести к parseThemeName; onboarding parser JSDoc перед notify parser — разнести по соответствующим helpers; Telegram parseMode parser JSDoc перед parseDownloadNotifyChannel — перенести к private parseTelegramParseMode. Nullable-string JSDoc перед SWARM_UNIT_ID принадлежит shared nullable helper. Existing bounded-positive orphan остаётся root. Не захватывать все comments по getFullStart без owner inventory.

Все raw references/casts остаются на нынешних ранних positions после memory/webhook подготовки и до localModels; даже если output поздно, getters ранней подготовки часть compatibility. Late order skills→TUI→analytics→Telegram→Discord→swarm→notifications→mail→git→composio→MCP→optional LLM сохраняется. Root types external imports именованы и intentional; public wrappers/existing roots нужны compatibility, не mandatory barrels. Root current version/history остаются source authority; не исправлять противоречивые version labels попутно.

## Baseline, proof, meaningful tests

Fresh snapshot до shared/leaf writes после verified05i: full src/protected/package/compiler/debt; root default/ENV/default keyorder/runtime exports/type shapes. Isolated actual old graph +current differential с whole-root outputs/errors, full versions и direct public parsers. All defaults/descriptor/registry mutations restore in finally; никаких personal state fixtures.

Matrix: legacy Discord list wins/trim/numbers/snowflake/dedup; Telegram actual Number syntax/ranges; swarm uniqueness, boundaries, order, sparse entries, unknown fields; downloads null/off/current defaults; mail nullable/pending attempts/required fields; Composio non-URL cache/env whitespace; Git bool; TUI unknown/blank theme, busy mode, timestamp parse semantics, absent/present onboarding/notify, negative vs zero duration, rail unchanged.

Phase/default/reference matrix: TUI→analytics→channel→integration invalid pairs, early retained notification downloads, raw block getters/late replacements, before/after absent/present default clones, capture-on-entry notify/onboarding vs per-expression outer defaults, within-call whole/nested defaults replacement, ignored channel list/swarm/mail/cache defaults, default object/array freshness and public pure function/regex identity. Wrapper behavior proof вместо ложного same-function assertion. Root getter event trace должен совпасть по actual default paths, не по internal owner parameter names.

Source proof: exact moved pure/public/private bodies/signatures/regex/constants; onb/notify bodies modulo recorded lookup argument substitution; expanded Tui shapes; exact literals/default/keyorder/comments; remaining root bytes; shared helper only exported intentionally. Pure exports/old public list/index proof. Owner DAG only config-values/primitives/error/sessionRail, no runtime root/API import;0SCC/exceptions and negative static/type/dynamic policy fixtures.

New three suites покрывают seams, not exhaustive mirrors existing scalar functions. Existing first: config-schema, load-config, config-file, agents-md-defaults. Downstream existing seams: TUI onboarding persist/needs/rerun, terminal-notify, local-model notification prompt, Telegram setup/orchestrator, swarm reducer/orchestrator; channels Telegram settings/pairing/channel and Discord/swarm registry; integrations registry and Telegram/Discord/GitHub/Composio/AtomicMail adapters; notifications/download-notifier, Composio resolve/build/session/key, AtomicMail store/service/client; git-remote-policy/remote-sync and shell mutation checks if imports show affected typing. Select actual tests; suite names verify with rg, no invented path.

Integrator runs lint/types/import/docs/build/quarantine/full test:ci plus changed checker self-tests; no new debt allowances or exclusions. Three owners могут быть параллельно implemented, но root/values integration последовательна. Следующая спецификация remaining execution/tool/security/session/skills создаётся после acceptance всей05j; runtime06/agent-loop07 не входят в эту группу.

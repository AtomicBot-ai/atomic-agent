# 04b: shell и web — независимый срез tools/os

Status: verified
Owner: repository maintainers

[Этап 04](04-local-llm-tools-os.md). Пользователь разрешил параллельную разработку независимых областей. Этот срез выполняется одновременно с filesystem: один интегратор обновляет registry, внешние imports, общий diagnostic ledger и итоговую приёмку.

## Цель и границы

Собрать запуск команд и получение HTTP/page content по владельцам, сохранив имена файлов, exports, tool names, schemas, approval/read scopes, timeout/detach/kill и response/SSRF contracts. Только module literals меняются при переносах; алгоритмы, prompt literals, config/defaults, runtime и package files не меняются. Existing shell-command-guard, web-search, archive, read-document и git сохраняют собственные каталоги. Общий expand-home остаётся в корне OS.

## Карта

- `src/tools/os/shell/`: root shell.ts, shell-interpretation.ts, shell-job-calls.ts, shell-jobs.ts, shell-result.ts, shell-timeout.ts и их root tests (shell, policy, detach, jobs, result, timeout); expand-shell-glob-args.ts/test и node-check-notice.ts/test. Последние два helpers вызываются только shell и относятся к аргументам/пояснению команды. Guard реализации остаются в shell-command-guard; интегратор отдельно перенесёт его единственный root suite рядом с реализацией, сохранив тестовые assertions и не меняя internals этого каталога.
- `src/tools/os/web/`: root web-fetch.ts, challenge/extract/ssrf-guard и tests; http-request.ts, http-request-fetch.ts и tests request/retry/curl-meta; ensure-curl.ts, html-to-text.ts, retry-after-header.ts/test. HTML converter используется только fetch; retry-after общий для request/fetch. Curl error helper также используется web-search transport: helper получает HTTP owner, search сохраняет свой transport и импортирует его напрямую.
- Root OS registry и все внешние consumers/mocks обновляет интегратор. Новые barrels и старые forwarding modules не создаются.

## Выполнение и доказательство

Читать tools, approval, config, runtime instructions/guides и tool contracts. Snapshot источников и diagnostic debt уже сохранён интегратором. До переносов исправить два известных fixture omissions отдельно: явный `body: undefined` в retry GET args (эквивалент ранее отсутствующего значения), `stepIndex: 0` в node-check ToolContext. Сохранить остальные values и все expect calls; не добавлять cast/allowance/compiler option. Интегратор выполняет reduce разрешённых diagnostic cases.

После fixture cleanup сохранить локальный snapshot. Для каждого перемещённого TS файла сохранить JSON old/new mapping и точные позиции module-literal substitutions; body/export/schema bytes доказать восстановлением только этих substitutions. Внешние references перечислить для интеграции, не править вне своего write set.

Локальные README описывают фактические owners, ресурсы и checks. Focused suites shell/web выполняются после разрешения imports; если внешние paths ещё не интегрированы, это явно pending. Общие lint/type/import/docs/quarantine/full CI-equivalent и protected-file diff принимает интегратор. Реальные пользовательские shell команды, сеть и downloads не используются как verification.

[Общая приёмка параллельных срезов](../testing/stage-04ab-validation.md).

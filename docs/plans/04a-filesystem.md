# Этап 04a: файловые операции tools/os

Status: verified
Owner: repository maintainers

[Общий этап](04-local-llm-tools-os.md). Независимый срез выполняется параллельно shell/web; общие consumers, registry, debt ledger и окончательную приёмку ведёт один интегратор.

## Цель и границы

Собрать 44 существующих root `fs-*.ts` файла (27 модулей, включая test helper, и 17 suites) в `src/tools/os/fs/`, сохранив имена, exports, порядок регистрации, tool contracts и алгоритмы. Archive/read-document/shared expand-home остаются у своих владельцев; новый barrel и forwarding modules не создаются. Исходники и тесты меняются отдельно от организации: fixture repairs предшествуют snapshot переносов.

## Работы

1. Проверить ledger и исправить только настоящие проблемы типизации переносимых fixtures. Сохранить явные значения и существующие expect-вызовы; не добавлять casts, allowances или compiler options. Интегратор уменьшает ledger после проверки.
2. Сохранить snapshot после fixture repairs, затем переместить все 44 файла. Внутри них изменить только относительные module literals; записать JSON manifest old/new и точные замены. Внешние consumers/registry/scripts пересчитывает интегратор.
3. Добавить английский README с входами, guards, owners состояния/ресурсов, границами регистрации и проверками. Не объявлять test helper runtime API.
4. Проверить соседние suites на disposable fixtures. Доказать точное равенство тела каждого перенесённого файла snapshot с учётом записанных literal replacements; отдельно проверить неизменность expect-вызовов fixture repairs.

## Приёмка

После интеграции: fs suites и approval/declared-input/restore/registration seams, lint, test type gate без новых ошибок, imports без циклов/исключений, docs и полный CI-equivalent. Старые root fs paths отсутствуют. Input protections, approval retarget, read scopes, backups/manifests, resource cleanup и known-project sources не изменены. Настоящие пользовательские файлы не используются; network/download/runtime/release не проверяются этим срезом. До общей проверки статус остаётся in-progress.

[Общая приёмка параллельных срезов](../testing/stage-04ab-validation.md).

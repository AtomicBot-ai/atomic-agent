# Приёмка 04a/04b: filesystem, shell и web

Status: verified
Owner: repository maintainers

[Этап 04](../plans/04-local-llm-tools-os.md), [filesystem](../plans/04a-filesystem.md), [shell/web](../plans/04b-shell-web.md). Пользователь разрешил параллельную разработку: два агента работали с непересекающимися наборами, интегратор единолично обновил shared registry/consumers/ledger/policy/docs. Третий агент независимо изучил local-llm; его выводы не выдавались за выполненные переносы.

78 механических moves: 44 filesystem, 33 shell/web, один существующий shell-command-guard suite рядом с реализацией. 20 внешних/межобластных consumers retargeted. Root OS registry сохраняет registration order/exports; отдельные web-search/guard/archive/read-document/git/proc owners сохранены. Доказательство /tmp/atomic-stage04-os-proof.mjs сравнило все 2371 TS/TSX modules: только module literals и пять fixture repairs; все прежние expect calls и package/protected hashes неизменны.

Fixtures: grep/patch получили корректное runtime narrowing; replace-guard — недостающие config fields с сохранением ранее falsy persistCache и fetch fallbacks; HTTP retry — явный undefined body; node-check — stepIndex=0. Общий type gate подтвердил ровно 14 resolved cases; reduce 892 → 878. Options/allowances не расширялись, capture/rebase не выполнялся.

Временные movers сначала ошибочно распознавали fixture path/glob literals как imports. Файлы полностью восстановлены из snapshots, movers ограничены AST imports/exports/types/dynamic/mock/require, proofs повторены. Эти первоначальные failures не скрыты. Некоторые локальные collection failures были ожидаемыми до shared import integration; fs watch/home fixtures также требуют разрешений общего runner. После интеграции full test:ci exit 0: 1042 suites, 12445 tests passed, 4 existing skips. Production lint/type gate/import gate/docs/diff прошли: 1349 modules, 4855 edges, 0 runtime SCC/exceptions; 2371 type roots/105 TSX; docs budgets/links/metadata passed.

Import checker теперь запрещает production зависеть от exact filesystem test helper, не меняя graph membership или options. Negative case сначала failed при старой политике, после расширения imports self-tests — 34 passed; tests могут пользоваться helper. Реальные пользовательские files/commands, downloads/servers/credentials, hosted CI/manual platform QA не использовались. Остальной этап 04 ещё не verified: local-llm только подготовлен к отдельной фазе.

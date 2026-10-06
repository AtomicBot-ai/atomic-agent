# Приёмка 03h: update UI

Status: verified
Owner: repository maintainers

[План](../plans/03h-update-ui.md). Четыре update views и banner test перенесены в src/tui/update; handleUpdateKey извлечён с неизменным телом и узким type-only контекстом. Порядок global router, approval, done/restart и публичные callbacks сохранены. Installer/state/runtime остаются у прежних владельцев, описанных в новом guide.

Удалены только два unused React imports в banner/status-bar fixtures; assertions сохранены. Type debt: 904 → 902, без capture, новых allowances или ослабления options. Добавлен typed global input suite: девять проверок y/n/Escape, fall-through, approval precedence и restart ordering. Первый запуск выявил ошибку в новом тесте: plain y не подтверждает approval; исправлено ожидание на реальный Ctrl+Y и отдельно проверен plain-y fall-through. Production поведение не менялось.

Проверки: focused 8 suites / 215 tests; полный test:ci — 1042 suites / 12445 tests passed, четыре существующих platform/GC skips. lint; typecheck:tests (2370 roots, 105 TSX tests, 902 debt); imports:check (1348 modules, 4854 edges, 0 runtime SCC, 0 exceptions); imports self-test 25, test-types self-test 11, docs check/self-test 11; quarantine 0 active / 2 released; git diff --check.

Snapshots до fixtures/moves/extraction и manifest в /tmp/atomic-stage03h-* позволили сравнить весь TS/TSX source: только записанные module literals, unchanged extracted body и два unused imports. Hashes package/package-lock, .pr-review-56 и EVIDENCE_ROUTER_MODEL.md сохранены. Нет новых forwarding modules или barrels.

Отдельных suites modal/indicator/restart нет; ручной terminal QA, hosted CI и реальные installer/network update/re-exec не запускались. Оставшаяся организация TUI и shared UI boundary — следующий срез; весь этап 03 пока in-progress.

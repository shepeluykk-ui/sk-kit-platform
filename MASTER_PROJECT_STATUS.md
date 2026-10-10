> **Правило этого документа: ни один статус не принимается из старых отчётов без независимой
> проверки в этой сессии.** Каждая строка ниже подтверждена реальным кодом, реальной командой
> или реальным HTTP-запросом — не декларацией. Детали и доказательства — в связанных документах.

# MASTER PROJECT STATUS — СК-КИТ

Актуально на: 2026-08-31. Репозиторий: `D:\SK-KIT`. Git: `git log --oneline` — 15 коммитов
(`90e5ef1` … `079fc67`), дерево чистое.

## Сводная таблица

| Область | Статус | Доказательство |
|---|---|---|
| Git-репозиторий | PASS | Отсутствовал на старте сессии — инициализирован; `git status` чистый |
| Аутентификация | PASS | Универсальный пароль, forged token, quick-login — удалены и проверены `tests/security/` |
| Авторизация / RBAC | PASS | `requireAuth`/`requireRole`/`requireProjectAccess` централизованы, используются единообразно |
| Tenant isolation | PASS | 403 на чужой проект — для старых И новых (Phase 9) сущностей, реальным тестом |
| IDOR | FIXED | `x-user-id`/`x-tenant-id`/`x-organization-id` не имеют эффекта на авторизацию (проверено) |
| Документы (загрузка/скачивание) | PASS | sha256 до/после рестарта совпадает, авторизация обязательна |
| Аудит-лог (backend) | PASS | Защищён, переживает рестарт, projectId/IP/userName реально обогащаются (`AsyncLocalStorage`), tenant isolation на чтении |
| Аудит-лог (UI) | PASS | `AuditLogView.tsx` реально подключён к `/api/audit/logs`, явные idle/loading/loaded/empty/error, ложный бейдж "TAMPER-EVIDENT VERIFIED" убран (реальной крипто-цепочки нет) |
| База данных | PASS | Настоящая SQLite (`node:sqlite`), НЕ in-memory. Реальный create→kill→restart→read тест пройден |
| Сессии | PASS | TTL 24ч, переживают рестарт, отзыв при logout — проверено реальным тестом |
| Файловое хранилище | PASS | Физические файлы + реестр путей переживают рестарт (найден и исправлен реальный баг ре-гидратации) |
| Backup / Restore | PASS | Реальное копирование/восстановление файла БД, полный цикл create→backup→modify→restore→verify пройден |
| Бизнес-сущности: Estimates/Schedule/Works/Inspections/Defects/AOSR/Financial (backend) | PASS | Реализованы, защищены, покрыты `tests/e2e/` (25/25), реальный restart+tenant тест |
| Бизнес-сущности (frontend UI) — Estimates/Schedule/Inspections/Defects/AOSR/Financial(КС-2/КС-3)/Audit Log | PASS | Phase 9L.2 завершена: все 7 модулей реально читают/пишут через backend, явные idle/loading/loaded/empty/error состояния, `INITIAL_*` не используется как fallback ни в одном из них (см. `PHASE_9_FRONTEND_BACKEND_MIGRATION_REPORT.md`). Organizations/Documents/VRF/ExecutiveDocs/ContractorPerformance/Risks/Notifications/WorkTypes — вне периметра Phase 9L.2, всё ещё на `INITIAL_*` |
| АОСР — целостность подписания | PASS | Реальная серверная state machine (было полностью stateless — критический дефект, закрыт в Phase 9) |
| Production build | PASS | `npx tsc --noEmit`, `npm run build`, `NODE_ENV=production node dist/server.cjs` — все реально выполнены и проверены |
| TypeScript-проверка типов | PARTIAL | `@types/react` отсутствовал в проекте — `tsc --noEmit` реально не проверял НИЧЕГО связанного с React (useState/useContext/JSX = `any` без ошибок) со времён создания проекта. Установлен; вскрылось 89 реальных ошибок в 12 файлах, 16 исправлено в рамках Phase 9L.2 (FinanceView, RemarksDefectsView), 73 остаются в файлах вне периметра — отдельная задача |
| Публичные артефакты | PASS | 11MB zip с Android-исходниками удалён из `dist/`; `.env`/ключи/секреты не в бандле |
| Security regression | PASS | `npm run test:security` → 37/37 (реальные HTTP-тесты, не заимствованное число) |
| E2E (Phase 9) | PASS | `npm run test:e2e` → 25/25 |
| AI (Gemini) | PARTIAL / NOT CONFIGURED | Код готов, `GEMINI_API_KEY` пуст в `.env` — реальные вызовы AI сейчас невозможны без ключа оператора |
| AI persistence | NOT IMPLEMENTED | `ProjectAnalysisJob` хранится только в памяти оркестратора, таблица `ai_analyses` создана, но не используется |
| PWA | FAIL (частично) | Есть только `manifest.json`. Service Worker отсутствует полностью — подтверждено в браузере (0 регистраций) |
| Android APK — сборка | PASS | `gradlew.bat assembleDebug` реально выполнена, `BUILD SUCCESSFUL`, `app-debug.apk` (21 МБ) существует |
| Android APK — runtime | BLOCKED | Нет AVD-эмулятора и физического устройства в этом окружении |
| Android — связь с backend | FAIL | `capacitor.config.ts` не задаёт `server.url` — упакованный APK не сможет достучаться до реального backend без доработки конфигурации |
| Observability / логи | PARTIAL | Структурные console-логи есть (`[БД]`, `[Хранилище файлов]`), нет request-id-сквозного трейсинга, нет health-check зависимостей (DB/storage/AI) |
| Производительность | UNKNOWN | Не нагрузочно тестировалась в этой сессии (не входило в объём) |
| Развёртывание / HTTPS / reverse proxy | NOT IMPLEMENTED | `PORT` захардкожен, нет конфигурации reverse-proxy/TLS в репозитории |

## Итоговые флаги

```
PRODUCTION READY: NO
```
Причина: PWA не реализована (только манифест), Android не проверен на runtime и не имеет рабочей
связи с backend в текущей конфигурации, AI не сконфигурирован (нет ключа), нет
production-инфраструктуры (HTTPS/reverse proxy/деплой), 73 непроверенные (до недавнего времени
незамеченные из-за отсутствия `@types/react`) ошибки типов вне периметра Phase 9L.2. Ядро (auth,
RBAC, tenant isolation, БД, сессии, backup/restore, документы) и все 7 бизнес-модулей Phase 9L.2
(Estimates/Schedule/Inspections/Defects/AOSR/Financial/Audit Log) — реально готовы, подключены к
backend и протестированы.

```
APK READY: NO (BUILD: YES, RUNTIME: NOT VERIFIED, BACKEND CONNECTIVITY: NOT CONFIGURED)
```

```
PWA READY: NO
```

## Что реально работает прямо сейчас (проверено, не предположение)

- Регистрация → одобрение администратором → OTP-подтверждение → логин с реальным паролем.
- Работа под RBAC с 14 ролями, строгая изоляция по проекту (включая новые Phase 9 сущности).
- Загрузка/скачивание документов с физическим хранением и проверкой целостности (sha256).
- Создание/чтение видов работ и unified control записей через реальный UI, с реальной персистентностью.
- Реальный backup и restore всей БД (не мок).
- Все 7 бизнес-модулей Phase 9L.2 (Estimates, Schedule, Inspections, Defects, AOSR, Financial
  КС-2/КС-3, Audit Log) — реальный UI, реальные API-запросы, явные состояния загрузки/ошибки/пустого
  списка, без отката на mock при сбое API, реальная многоролевая сквозная проверка через браузер
  (не только curl/тесты) — см. `PHASE_9_FRONTEND_BACKEND_MIGRATION_REPORT.md`.
- Реальная сборка Android APK (без проверки установки/запуска).

## Дальнейший приоритет (без гадания — то, что уже понятно как следующий шаг)

1. Исправить оставшиеся 73 ошибки типов (вскрыты установкой `@types/react`) в файлах вне периметра
   Phase 9L.2 — см. отдельную задачу.
2. Подключить к реальному backend оставшиеся вне периметра Phase 9L.2 модули (Organizations,
   Documents/РД, VRF Systems, Executive Docs, Contractor Performance, Risks, Notifications, Users).
3. Реализовать Service Worker для PWA.
4. Настроить `CAPACITOR_SERVER_URL`/`server.url` и повторно собрать/протестировать Android APK
   на реальном эмуляторе или устройстве.
4. Получить `GEMINI_API_KEY` от оператора для реальных AI-вызовов.
5. Production-инфраструктура: HTTPS, reverse proxy, деплой, `PORT`/секреты через окружение
   полностью (частично уже так — `.env` уже не коммитится).

## Связанные документы

- `docs/security/VERIFIED_BASELINE_2026-08-31.md` — построчный verified baseline (git/package/
  frontend/backend/database/auth/authorization/RBAC/tenant isolation/documents/audit/AI/PWA/
  Capacitor/Android/tests/production build/public artifacts).
- `docs/security/CURRENT_SECURITY_STATUS.md` — BEFORE/AFTER по каждому закрытому security-дефекту.
- `docs/security/VERIFIED_API_SECURITY_MATRIX.md` — все 71 маршрут с их auth/role/tenant характеристиками.
- `docs/architecture/CURRENT_ARCHITECTURE.md` — текущая архитектура и известные ограничения.
- `docs/architecture/DATA_INVENTORY.md`, `DOMAIN_MODEL.md` — аудит и модель бизнес-данных (Phase 9).
- `PHASE_9_DATABASE_MIGRATION_REPORT.md` — подробности миграции бизнес-данных в backend.

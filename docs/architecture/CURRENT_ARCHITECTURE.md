# CURRENT ARCHITECTURE — СК-КИТ

Актуально на 2026-08-31 (после Phase 9, коммиты `051f5c9`/`909a9d6`), построено чтением реального
кода `D:\SK-KIT`, не старой `ARCHITECTURE.md`. См. также `docs/architecture/DATA_INVENTORY.md` и
`docs/architecture/DOMAIN_MODEL.md` для деталей миграции бизнес-данных.

## Общая схема

```
Browser / Android WebView (Capacitor)
        │  fetch('/api/...')  — ОТНОСИТЕЛЬНЫЕ пути, без базового URL
        ▼
Express (server.ts, ~2680 строк, единый файл)
  ├─ Security headers, rate limiting (in-memory Map по IP)
  ├─ requireAuth / requireRole / requireProjectAccess  — централизованная авторизация
  ├─ 50 REST-маршрутов
  ├─ Vite dev middleware (NODE_ENV != production) ИЛИ статика dist/ (production)
  └─ Gemini AI (@google/genai), ключ из .env
        │
        ▼
src/server/repositories/*.ts — repository-слой Phase 9 (organizations, estimates,
  construction [schedule/inspections/defects], aosr, financial) — API → Service → Repository → DB
        │
        ▼
src/server/database.ts — node:sqlite (встроенный в Node.js, без внешних зависимостей)
  └─ data/skkit.db: users, sessions, audit_log, registration_requests, projects, work_types,
     unified_control, organizations, project_members, estimates, estimate_items, schedule_tasks,
     inspections, defects, aosr, aosr_signatures, executive_docs, financial_entries, ai_analyses,
     notifications, contractor_performance (по одной таблице на store, значение — JSON-блоб;
     project-scoped таблицы дополнительно имеют индексированную колонку project_id для реального
     SQL WHERE, не полная 3NF-нормализация, см. "Известные ограничения")
        │
        ▼
uploads/documents/<projectId>/<docId>/<uuid>-filename — физические файлы на диске
  (реестр путей в src/server/fileStorage.ts — ре-гидрируется из projectDataStore при старте)
```

## Backend

- **Технологии:** Express 4, TypeScript, `tsx` (dev) / `esbuild` (prod bundle в `dist/server.cjs`).
- **Порт:** 3000 (жёстко задан константой `PORT` в `server.ts`, не через `.env`).
- **In-memory рабочие копии + SQLite-персистентность.** Данные живут в обычных JS-объектах/Map/Array
  (`mockUsers`, `projectDataStore`, `auditLogStore`, `registrationRequestsStore`, `workTypesStore`,
  `unifiedControlStore`, `activeSessions`) — вся существующая бизнес-логика читает/пишет их напрямую,
  без изменений. При каждой мутации соответствующая запись синхронно дублируется в SQLite
  (`dbUpsert`). При старте процесса (`bootstrapPersistence()`) таблицы либо засеиваются из
  захардкоженных demo-данных (первый запуск, пустая БД), либо, если в БД уже есть данные — становятся
  источником истины и полностью перезаписывают in-memory копии (`reloadAllStoresFromDb()`). Это
  сознательный компромисс: минимальный риск сломать существующую логику (изменился только слой
  хранения, не сама бизнес-логика) ценой JSON-блобов вместо нормализованных колонок.
- **Аутентификация:** непрозрачный случайный токен (`skkit_sess_<32 байта>`), серверная сессия
  (`activeSessions` + таблица `sessions`, TTL 24 часа), отзыв через `revokedTokens` (в памяти —
  не переживает рестарт; это осознанный компромисс: после рестарта отозванные токены снова принимаются
  бы, ЕСЛИ они не удалены — но они удаляются из `activeSessions`/БД при logout, поэтому фактического
  риска нет, кроме гипотетического окна между logout и рестартом при котором revokedTokens ещё не
  проверился бы — на практике не эксплуатируется, поскольку токен уже удалён из sessions-таблицы).

## Frontend

- **Технологии:** React 19, Vite 6, Tailwind 4, TypeScript. SPA, единственная точка входа `src/main.tsx`.
- **Архитектурный разрыв (Phase 9 сократила его, но не закрыла полностью).** Приложение состоит из
  двух слоёв данных:
  1. **Реально подключено к backend (проверено HTTP-тестами и в браузере):** аутентификация
     (`/api/auth/*`), **виды работ (`/api/work-types`) — подключено в Phase 9L**, **unified control
     (`/api/unified-control`) — подключено в Phase 9L**, загрузка/скачивание документов
     (`/api/documents/*`), регистрация и одобрение пользователей, backup/restore.
     Backend (готов и покрыт тестами, но фронтенд ещё не переключён на него — см. п.2)
     дополнительно предоставляет: организации (`/api/organizations`), участники проекта
     (`/api/projects/:id/members`), сметы (`/api/projects/:id/estimates`, `/estimate-items`),
     график (`/api/projects/:id/schedule`), инспекции (`/api/projects/:id/inspections`), дефекты
     (`GET/POST /api/projects/:id/defects`, `PATCH .../status` — GET уже реально подключён и
     переведён на новое хранилище), АОСР (`/api/projects/:id/aosr`, `/api/aosr/:id/sign` — теперь
     реальная серверная state machine, не доверяет клиенту), финансы (`/api/projects/:id/financial`).
  2. **Только локальное состояние React, ещё не подключено к готовому backend:** проекты
     (`INITIAL_PROJECTS` — своя, более богатая модель, чем backend `Project`, требует отдельного
     решения по объединению, см. `DOMAIN_MODEL.md`), сметы/график/инспекции/VRF-системы/дефекты
     (кроме чтения)/исполнительная документация в UI, сам аудит-лог в `AuditLogView.tsx`
     (использует `INITIAL_AUDIT_LOGS` + локальный `logAction`, не `/api/audit/logs`, хотя последний
     полностью реален, защищён и покрыт тестами). Причина, по которой это не переключено в Phase 9:
     формы/таблицы этих view рассчитаны на старые frontend-типы (`EstimateItem`, `InspectionRecord`,
     `DefectRemark` и т.д. из `types/index.ts`), которые по полям не совпадают 1:1 с новыми
     backend-сущностями (см. `DOMAIN_MODEL.md` — расхождения намеренные, ради более здоровой
     реляционной модели) — переключение каждого view требует аккуратной адаптации полей и
     визуальной проверки, не просто замены источника данных. Это следующий конкретный шаг
     (пункт "Дальнейшие шаги" ниже), не гипотетический план.
  Практическое следствие: backup/restore и multi-user-консистентность реальны для всего, что в
  таблице БД (даже для сущностей из п.2 — если их создать напрямую через API/curl, они переживут
  рестарт и корректно изолированы по tenant). Не реальны — только те данные из п.2, которые
  РЕАЛЬНО создаются через UI прямо сейчас (он их не отправляет на backend, только держит в
  React state / `localStorage`).
- **Клиентский переключатель роли (`switchRole`, `Header.tsx`)** меняет отображаемую роль только
  локально — после закрытия auth-дыр backend больше не доверяет этой роли ни в чём, но UX остаётся
  запутанным (пользователь визуально «становится» другим человеком, хотя его реальная серверная
  сессия не меняется).

## Персистентность

| Слой | Технология | Переживает рестарт | Проверено |
|---|---|---|---|
| Пользователи, сессии, аудит-лог, заявки на регистрацию, виды работ, unified control, документы/проекты | SQLite (`node:sqlite`), `data/skkit.db` | Да | Да, реальным тестом create→kill→restart→read |
| Сметы, график, инспекции, дефекты, АОСР (+подписи), финансовые записи, организации, участники проекта (Phase 9) | SQLite, отдельные таблицы с индексом по `project_id` | Да | Да — `tests/e2e/phase9-domain-entities.test.ts` (10/10) + ручной restart-тест (создание → kill → restart → чтение того же id) |
| Физические файлы документов | Файловая система, `uploads/documents/` | Да (сами байты) + реестр путей ре-гидрируется при старте из БД | Да, sha256 до/после рестарта совпал |
| Backup/Restore | Копирование файла `data/skkit.db` (`createRealBackup`/`restoreFromBackup` в `src/server/database.ts`) — теперь покрывает и Phase 9 таблицы, т.к. это тот же файл БД | n/a | Да, полный цикл create→backup→modify→restore→verify |
| Проекты (богатая frontend-модель)/сметы/график/инспекции/дефекты/ИД, СОЗДАВАЕМЫЕ через UI (кроме work-types/unified-control) | React state + `localStorage` браузера | НЕТ (только в рамках одного браузера, не сервера) | — до Phase 9L для этих view (см. Frontend выше) |

## Безопасность (сводно; детали — `docs/security/CURRENT_SECURITY_STATUS.md`)

- Централизованные `requireAuth`, `requireRole`, `requireProjectAccess` в `server.ts` — используются
  единообразно и в Phase 9 API, без исключений.
- Identity исключительно из серверной сессии; `x-user-id`/`x-tenant-id`/`x-organization-id` не имеют
  эффекта на авторизацию. Роль подписанта АОСР и личность инспектора/автора дефекта/финансовой
  записи — всегда из `req.user` (сессия), никогда из тела запроса.
- АОСР — реальная серверная state machine: переход статуса проверяется по фактически сохранённой
  записи, а не по тому, что заявляет клиент (было наоборот до Phase 9 — см.
  `docs/architecture/DATA_INVENTORY.md`, критическая находка №2).
- 31/31 реальных HTTP security-тестов (`tests/security/`, `npm run test:security`) +
  10/10 доменных E2E-тестов (`tests/e2e/`, `npm run test:e2e`) — оба набора зелёные после Phase 9.

## AI

- `@google/genai` (Gemini). `GEMINI_API_KEY` не задан в текущем `.env` — реальные вызовы AI сейчас
  невозможны без ключа оператора (`geminiConfigured: false` в `/api/health`).
- `ProjectAnalysisOrchestrator` (`src/server/projectAnalysisOrchestrator.ts`) — многоагентный AI-анализ
  проекта (смета, риски, рентабельность), результаты держатся в памяти оркестратора (не в SQLite) —
  повторный запуск сервера теряет ранее посчитанные анализы, но не сами проекты/документы.
- `AiResilienceService` — circuit breaker/chaos-injection для устойчивости AI-вызовов, отдельные
  admin-эндпоинты `/api/ai/circuit-reset`, `/api/ai/chaos-inject`.

## PWA

- Только `public/manifest.json`. **Service Worker отсутствует полностью** — подтверждено в живом
  браузере (`navigator.serviceWorker.getRegistrations()` → 0). Нет офлайн-режима, кэширования,
  install-via-SW, механизма обновления.

## Mobile (Capacitor / Android)

- `capacitor.config.ts`: `webDir: 'dist'`, `androidScheme: 'https'`, безопасные production-флаги.
- **`server.url` не задан.** Весь фронтенд ходит в API относительными путями (`fetch('/api/...')`).
  Без `server.url`, указывающего на реальный HTTPS backend, упакованный в APK локальный `dist/`
  не сможет достучаться до backend — для реального использования на объекте нужно либо задать
  `server.url` на прод-домен, либо ввести `CAPACITOR_SERVER_URL`/аналог и прокинуть его в
  `capacitor.config.ts` перед сборкой релизного APK.
- Сборка `gradlew.bat assembleDebug` реальна и проверена (JDK 21, `BUILD SUCCESSFUL`,
  `app-debug.apk` 21 МБ). Runtime не протестирован — нет AVD/устройства в этом окружении.

## Известные ограничения текущей архитектуры (не «дыры», а сознательные компромиссы или P1/P2 долг)

1. SQLite-таблицы хранят JSON-блобы (с индексированной `project_id` для project-scoped таблиц), а не
   полностью нормализованные колонки — упрощает миграцию без переписывания бизнес-логики, но
   усложняет прямые сложные SQL-JOIN/аналитику поверх БД в будущем.
2. Единый порт (3000) и единый процесс — нет horizontal scaling, нет отдельного read-replica.
3. `PORT` захардкожен в `server.ts`, не читается из `.env`/`process.env.PORT` — усложняет размещение
   за reverse-proxy на нестандартном порту без правки кода.
4. Часть UI-view (сметы, график, инспекции, дефекты-создание, ИД) ещё не переключены на готовый,
   защищённый, протестированный Phase 9 backend — см. Frontend выше. Это конкретная, ограниченная
   по объёму задача (адаптация полей ~6 компонентов), не архитектурная неопределённость.
5. `Project` существует в двух несовместимых представлениях (богатая frontend-модель в
   `INITIAL_PROJECTS` vs. простая backend `projectDataStore`) — не объединены в Phase 9, см.
   `DOMAIN_MODEL.md`. Нужно решить до полной миграции Estimates/Schedule на UI, так как обе
   ссылаются на `projectId`, но фронтендовые KPI-поля (бюджет, прогресс) пока нигде не пересчитываются
   из реальных `financial_entries`/`schedule_tasks`.
6. `Organization` как backend-сущность (Phase 9) существует параллельно с `INITIAL_ORGANIZATIONS`
   на фронтенде — не объединены, тот же класс проблемы, что и п.5.

## Дальнейшие шаги (конкретные, не «нужно доделать»)

1. Подключить `EstimatesView.tsx`, `ScheduleView.tsx`, `ConstructionControlView.tsx`,
   `RemarksDefectsView.tsx`, `ExecutiveDocsView.tsx`, `FinanceView.tsx` к реальным Phase 9 API вместо
   `INITIAL_*`/локального `useState` — backend для всех них уже реализован, защищён и протестирован
   (`tests/e2e/phase9-domain-entities.test.ts`), это чисто фронтенд-задача адаптации полей.
2. Подключить `AuditLogView.tsx` к `/api/audit/logs` вместо `INITIAL_AUDIT_LOGS`.
3. Объединить frontend/backend модели `Project` и `Organization` в одну (см. п.5/6 выше).
4. Настроить `CAPACITOR_SERVER_URL`/`server.url` для реальной работы Android APK с backend.
5. Реализовать Service Worker для PWA (сейчас полностью отсутствует).

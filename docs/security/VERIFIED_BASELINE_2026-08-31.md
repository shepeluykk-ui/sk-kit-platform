# VERIFIED BASELINE — СК-КИТ — 2026-08-31

Этот документ фиксирует ТОЛЬКО факты, проверенные напрямую в `D:\SK-KIT` в ходе этой сессии:
чтением реального кода, реальными командами из `D:\SK-KIT`, реальными HTTP-запросами к
работающему backend и реальным перезапуском процесса. Ни один статус ниже не взят из старых
`*.md`-отчётов без независимой проверки.

Старые отчёты (`FINAL_ACCEPTANCE_REPORT.md`, `PRE_APK_RELEASE_GATE.md`,
`PRODUCTION_HARDENING_VERIFICATION.md` и др.) во многом противоречили фактическому коду —
см. `CURRENT_SECURITY_STATUS.md` для точного перечня расхождений. Эти отчёты не тождественны
истине по умолчанию.

**Важное уточнение по хронологии.** Этот документ пишется не с нулевого состояния репозитория:
в первой половине этой же рабочей сессии (тот же диалог, до постановки задачи «RESET TO
VERIFIED BASELINE») уже была проведена диагностика и выполнено реальное исправление P0-уязвимостей
аутентификации, реализована настоящая БД (SQLite) и настоящий backup/restore — с проверкой каждого
исправления реальными HTTP-запросами и перезапуском процесса. Эти изменения зафиксированы в
git-коммитах, перечисленных ниже. Baseline фиксирует состояние именно ПОСЛЕ этих коммитов
(поскольку откатывать уже верифицированные исправления бессмысленно и вредно), но заново
перепроверяет каждый факт независимо, а не принимает предыдущие выводы на веру. Там, где в ходе
этой повторной проверки найдены ДОПОЛНИТЕЛЬНЫЕ, ранее не закрытые проблемы, они зафиксированы
как FAIL/PARTIAL ниже и закрываются отдельным коммитом сразу после baseline (см.
`CURRENT_SECURITY_STATUS.md`).

## Repository Path

| Проверено | Значение |
|---|---|
| Путь | `D:\SK-KIT` |
| Ранее ошибочно использовавшийся путь | `D:\Downloads\claude-code-main` — это исходный код Claude Code CLI, НЕ относится к СК-КИТ |
| Статус | **PASS** — рабочая директория подтверждена как `D:\SK-KIT` командой `pwd`/`ls` |

## Git Status

```
$ git status
On branch master
nothing to commit, working tree clean

$ git log --oneline
7d888b3 fix: close authentication backdoors, add real DB-backed persistence
90e5ef1 chore: initialize git repository (baseline snapshot)
```

- **Факт:** на момент начала этой сессии `D:\SK-KIT` НЕ был git-репозиторием
  (`fatal: not a git repository`). Это подтверждённый production/development risk сам по себе —
  без VCS невозможно безопасно откатывать изменения и отслеживать регресс.
- Репозиторий инициализирован в этой сессии, сделано 2 коммита (baseline snapshot + security/persistence fix).
- Статус: **GIT REPOSITORY = PASS (создан в этой сессии; отсутствовал на старте — см. выше)**

## Package

```
name: react-example   ← не переименовано под проект, косметический дефект
type: module
scripts: dev (tsx server.ts), build (vite build + esbuild), start (node dist/server.cjs), lint (tsc --noEmit)
```

- Зависимостей БД (`pg`, `prisma`, `drizzle-orm`, `typeorm`, `better-sqlite3`) в `package.json` — **нет**.
  БД реализована через встроенный в Node.js `node:sqlite` (Node v24.19.0, экспериментальный, но стабильно
  работающий модуль) — отдельная npm-зависимость не требовалась.
- Статус: **PASS** (package.json подтверждён `cat package.json`, скрипты реально выполнялись)

## Frontend

- React 19 + Vite 6 + Tailwind 4, SPA, без SSR.
- Реальная сборка подтверждена: `npm run build` → `dist/index.html`, `dist/assets/*.js` (664 KB), `dist/assets/*.css`.
- Статус: **PASS** (сборка выполнена и проверена)

## Backend

- Express 4, единый файл `server.ts` (~2650 строк), 50 зарегистрированных маршрутов
  (подтверждено `grep -n "^app\.(get|post|put|delete|patch)("`).
- Централизованная аутентификация реализована: `resolveAuthenticatedUser()`, `requireAuth()`, `requireRole()`
  (строки 312, 330, 345 `server.ts`).
- Статус: **PASS** (после исправлений P0, см. `CURRENT_SECURITY_STATUS.md`)

## Database

- Ранее: **NOT IMPLEMENTED** — все данные (`mockUsers`, `activeSessions`, `projectDataStore`,
  `auditLogStore`, `registrationRequestsStore`, `workTypesStore`, `unifiedControlStore`) жили только
  в памяти процесса Node. Реальный тест: создать запись → `kill` процесса → поднять заново → запись
  отсутствовала. Подтверждено.
- Сейчас: реализована настоящая файловая БД на `node:sqlite` (`D:\SK-KIT\src\server\database.ts`,
  файл `D:\SK-KIT\data\skkit.db`), с отдельной таблицей на каждое хранилище (`users`, `sessions`,
  `audit_log`, `registration_requests`, `projects`, `work_types`, `unified_control`).
- Реальный тест persistence (повторён и подтверждён в этой сессии): создание записи через
  `POST /api/work-types` → `kill` процесса → повторный запуск → `GET /api/work-types` содержит
  запись. **Подтверждено.**
- Статус: **PASS** (реальная персистентность, не заявление)

## Authentication

- Ранее: живой bypass через пароль `skkit2024`, кнопка Quick Login на экране входа, приём
  неподписанных токенов вида `skkit_jwt_<userId>_...` без проверки — токен подделывался
  тривиально (см. `CURRENT_SECURITY_STATUS.md`, раздел BEFORE/AFTER).
- Сейчас: пароль проверяется строго по хэшу (`hashSecret`), токен — `skkit_sess_<32 случайных байта>`,
  единственный источник истины — серверная `activeSessions` (плюс SQLite-таблица `sessions` для
  переживания рестарта, TTL 24 часа).
- Статус: **PASS** (проверено curl: неверный пароль → 401; `skkit2024` → 401; подделанный
  структурный токен → 401; логин с верным паролем → валидный токен, работает после рестарта)

## Authorization

- Централизованная функция `requireRole(user, res, allowedRoles[])` внедрена и используется в
  контролируемых admin/финансовых/аудиторских маршрутах.
- Дополнительно найдено (эта повторная проверка) и **не было закрыто в прошлой итерации**:
  `GET /api/audit/logs` — без какой-либо авторизации отдаёт последние 100 записей аудит-лога
  анонимному вызову. `POST/GET /api/projects/:projectId/ai-analysis*` (7 маршрутов) — без проверки
  членства пользователя в проекте. Закрывается сразу после этого baseline.
- Статус на момент записи baseline: **PARTIAL** (устраняется следующим коммитом)

## RBAC

- Роли пользователей (`ADMIN`, `SUPER_ADMIN`, `CHIEF_ENGINEER`, `TECH_SUPERVISOR`, `CONTRACTOR`,
  `CUSTOMER`, `PTO_ENGINEER`, `OVIK_ENGINEER`, `FOREMAN`, `CONSTRUCTION_CONTROL`) заданы в
  `mockUsers`/БД, проверяются через `requireRole`.
- Клиентский переключатель роли (`switchRole` в `src/context/AppContext.tsx`, UI в `Header.tsx`)
  меняет роль только в локальном состоянии браузера — сервер эту роль не использует и не доверяет
  ей (после исправления identity полностью берётся из серверной сессии). Остаётся UX-проблемой
  (запутывает пользователя, показывая чужую личность в интерфейсе), но не является security-дырой
  после фикса backend.
- Статус: **PASS** (серверная часть); UX-дефект зафиксирован как P1 в `CURRENT_ARCHITECTURE.md`

## Tenant Isolation

- `/api/projects/:projectId/documents`, `/defects`, upload/download — проверяют
  `user.allowedProjectIds`/`user.projectIds` относительно `:projectId`. Подтверждено реальным
  запросом: пользователь без доступа к `proj-2` получает 403 с `isolationStatus: ISOLATED_AND_ENFORCED`.
- AI-анализ проекта (`/api/projects/:projectId/ai-analysis*`) — на момент записи baseline
  **не проверяет** принадлежность пользователя к проекту вообще. FAIL, закрывается сразу после baseline.
- Статус: **PARTIAL** (устраняется следующим коммитом)

## Documents

- Загрузка (`multer`, до 100 МБ, whitelist расширений PDF/DOC/DOCX/XLS/XLSX/DWG/ZIP/JPG/PNG),
  физическое сохранение на диск (`uploads/documents/<projectId>/<docId>/<uuid>-name`), sha256 на
  каждую версию.
- Реальный тест persistence: загрузка файла → sha256 → `kill` процесса → рестарт → скачивание →
  sha256 совпал. **Подтверждено** (потребовалась отдельная правка — реестр `FileStorageManager`
  был in-memory-only и после рестарта скачивание молча отдавало сгенерированную заглушку; исправлено
  ре-гидратацией реестра из персистентных данных проекта при старте).
- Статус: **PASS**

## Audit

- `logAudit()` централизован, пишет в `auditLogStore` + SQLite-таблицу `audit_log`. Переживает рестарт
  (подтверждено).
- Доступ к чтению аудит-лога — см. Authorization выше: на момент записи baseline не защищён
  авторизацией. FAIL, закрывается сразу после baseline.
- Статус: **PARTIAL**

## AI

- `@google/genai` (Gemini), ключ `GEMINI_API_KEY` не задан в `.env` (пусто) — реальные вызовы AI
  сейчас невозможны без ключа от оператора; `geminiConfigured: false` в `/api/health`.
- Изоляция AI-контекста между проектами — см. Tenant Isolation: на момент записи baseline
  отсутствует для `/api/projects/:projectId/ai-analysis*`.
- Статус: **PARTIAL / NOT CONFIGURED** (ключ) + **FAIL** (изоляция, до фикса)

## PWA

- Есть только `public/manifest.json` (иконка, имя, `display: standalone`).
- Service Worker — **отсутствует полностью**. Проверено в живом браузере:
  `navigator.serviceWorker.getRegistrations()` → `0` регистраций. Нет `sw.js`, нет
  `vite-plugin-pwa` в `package.json`, нет `offline.html`.
- Статус: **FAIL** (только манифест; офлайн-режима, кэширования, install-via-SW, механизма
  обновления нет)

## Capacitor

- `capacitor.config.ts`: `webDir: 'dist'`, `androidScheme: 'https'`, `cleartext: false`,
  `webContentsDebuggingEnabled: false` — безопасные production-настройки.
- **Критический архитектурный факт:** `server.url` НЕ задан. Весь фронтенд обращается к API
  относительными путями (`fetch('/api/...')`) — подтверждено grep по всем вызовам в
  `AppContext.tsx`. Без `server.url`, указывающего на реальный HTTPS backend, упакованное в APK
  приложение при локальной загрузке `dist/` не сможет достучаться до backend — относительные
  `/api/...` пути будут резолвиться в контексте локальной схемы Capacitor, а не реального сервера.
- Статус: **FAIL** (конфигурация не готова для работы APK с удалённым backend — нужен
  `CAPACITOR_SERVER_URL` или явный `server.url`, см. `CURRENT_ARCHITECTURE.md`)

## Android

- JDK 21 обнаружен на `D:\jdk21`, Gradle 8.14.3, `GRADLE_USER_HOME=D:\Gradle`, SDK — `D:\Android\Sdk`
  (через `android/local.properties`, `ANDROID_HOME`/`ANDROID_SDK_ROOT` как переменные окружения не
  заданы, но не требуются благодаря `local.properties`).
- Реальная сборка выполнена: `gradlew.bat assembleDebug` (с явным `JAVA_HOME=D:\jdk21\...`) →
  `BUILD SUCCESSFUL in 4m 13s`, `android/app/build/outputs/apk/debug/app-debug.apk` (21 МБ) реально
  существует.
- Runtime-тест (установка/запуск/логин/API/документы/AI/logout) — **BLOCKED**: не настроен ни один
  AVD-эмулятор (`emulator -list-avds` → пусто), физическое устройство не подключено
  (`adb devices` → пусто).
- Статус: **PASS (сборка)**, **BLOCKED (runtime)**

## Tests

- До этой сессии: тестов не было вообще (`tests/` отсутствовал, `test:security` не существовал в
  `package.json`). Заявление «106/106 PASS» в старых отчётах не подтверждается ничем в репозитории.
- Статус до этой сессии: **NOT IMPLEMENTED**
- В этой сессии создаются реальные HTTP security-тесты — см. `tests/security/` и
  `CURRENT_SECURITY_STATUS.md` для фактического количества и результатов.

## Production Build

- `npx tsc --noEmit` — 0 ошибок (проверено).
- `npm run build` — успешно, `dist/server.cjs` (279 KB) + `dist/index.html` + `dist/assets/*`.
- `NODE_ENV=production node dist/server.cjs` — реально запущен, `/api/health`,
  `/api/auth/login`, `/api/auth/me`, `/api/auth/logout` проверены curl-запросами, все отвечают
  корректно.
- Статус: **PASS**

## Public Artifacts

- `public/skkit-android-source.zip` (11.3 МБ, полный исходник Android) копировался Vite в `dist/`
  и был бы публично доступен по прямому URL на проде. **Удалён** (из `public/` и `dist/`).
- Проверка `dist/` на `.env`, ключи, `.pem`, архивы исходников — чисто.
- Проверка собранного JS-бандла на строку `skkit2024` и текст «Быстрый выбор сотрудника» —
  отсутствуют.
- Статус: **PASS** (после удаления zip)

---

**Дальнейшие шаги по порядку из задания:** закрыть Authorization/Tenant Isolation gaps
(audit logs, AI-анализ) → построить `VERIFIED_API_SECURITY_MATRIX.md` по финальному состоянию →
написать реальные HTTP security-тесты в `tests/security/` → зафиксировать фактическое число
PASS/FAIL (не «106») → `CURRENT_SECURITY_STATUS.md` и `CURRENT_ARCHITECTURE.md`.

# VERIFIED API SECURITY MATRIX — СК-КИТ

Построено прямым чтением `server.ts` (все 71 зарегистрированных маршрута на 2026-08-31, подтверждено
`grep -n "^app\.(get|post|put|delete|patch)("`; было 50 до Phase 9, +21 новых Phase 9-маршрутов и
`PUT /api/unified-control/:id`), НЕ на основе старой `API_SECURITY_MATRIX.md`.
Отражает состояние после коммитов `7d888b3`, `f5e8d1c`, `2e3ea0c`, `051f5c9`, `909a9d6`. Первые
разделы ниже (Auth/Registration … System) не менялись по существу с прошлой версии — новый раздел
"Phase 9 — Business Domain API" добавлен в конце.

Легенда:
- **Auth**: `none` (без аутентификации) / `requireAuth` (нужен валидный токен)
- **Role**: `any` (любая роль) / список допустимых ролей
- **Project**: `n/a` / `requireProjectAccess` (проверка принадлежности к `:projectId`)
- **Input validation**: `strict` (валидация всех полей) / `basic` (частичная) / `none`

## Auth & Registration

| Method | Path | Auth | Role | Project | Input validation |
|---|---|---|---|---|---|
| GET | `/api/health` | none | any | n/a | n/a |
| POST | `/api/auth/login` | none | any | n/a | basic (пустой пароль отклоняется) |
| POST | `/api/auth/register` | none | any | n/a | strict (ФИО/телефон/email/логин/пароль) |
| GET | `/api/admin/registration-requests` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER | n/a | n/a |
| POST | `/api/admin/registration-requests/:id/approve` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER | n/a | basic |
| POST | `/api/admin/registration-requests/:id/reject` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER | n/a | basic |
| POST | `/api/auth/resend-code` | none (по дизайну — до логина) | any | n/a | rate-limited (60 сек) |
| POST | `/api/auth/verify-code` | none (по дизайну — до логина) | any | n/a | strict (формат кода, anti-bruteforce 5 попыток) |
| GET | `/api/auth/otp-transport-status` | none | any | n/a | n/a |
| GET | `/api/auth/me` | requireAuth | any (сам себя) | n/a | n/a |
| POST | `/api/auth/logout` | best-effort (работает и без токена, no-op) | any | n/a | n/a |

## Projects, Documents, Defects

| Method | Path | Auth | Role | Project | Input validation |
|---|---|---|---|---|---|
| POST | `/api/projects/:projectId/access-check` | requireAuth | any | requireProjectAccess (inline) | n/a |
| GET | `/api/projects/:projectId/documents` | requireAuth | any | requireProjectAccess (inline) | n/a |
| GET | `/api/projects/:projectId/defects` | requireAuth | any | requireProjectAccess (inline) | n/a |
| POST | `/api/documents/upload(-binary\|-version)` | requireAuth | не CONTRACTOR | requireProjectAccess (inline) | strict (multer: whitelist расширений, 100 МБ лимит) |
| GET | `/api/documents/:id/download`, `/versions/:ver/download` | requireAuth | any | inline isolation-check по найденному проекту документа | n/a |
| GET | `/api/documents/:id/view` | requireAuth | any | requireProjectAccess (inline, по найденному проекту документа) | n/a |
| GET | `/api/documents/:id/binary-info` | requireAuth | any | n/a (нет привязки к :projectId) | n/a |

## Инженерные расчёты и спецификации

| Method | Path | Auth | Role | Project | Input validation |
|---|---|---|---|---|---|
| POST | `/api/specifications/compare` | none | any | n/a | basic (числовые поля) |
| POST | `/api/inspections/:inspectionId/accept-work` | requireAuth | TECH_SUPERVISOR, ADMIN | n/a | basic |
| POST | `/api/aosr/:aosrId/sign` | requireAuth | CONTRACTOR, TECH_SUPERVISOR, CUSTOMER, ADMIN, SUPER_ADMIN | n/a | strict (роль берётся из сессии, не из тела запроса) |
| POST | `/api/ovik/refrigerant-calc` | none (чистый калькулятор, не читает данные сервера) | any | n/a | basic |
| POST | `/api/ovik/pressure-test` | none (чистый калькулятор) | any | n/a | basic |
| POST | `/api/ovik/vacuum-test` | none (чистый калькулятор) | any | n/a | basic |
| POST | `/api/finance/validate-ks2` | requireAuth | any | n/a | basic |
| POST | `/api/security/test-prompt-injection` | none (тестовый эндпоинт) | any | n/a | basic |

## Аудит, виды работ, unified control

| Method | Path | Auth | Role | Project | Input validation |
|---|---|---|---|---|---|
| GET | `/api/audit/logs`, `/api/audit-logs` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, CONSTRUCTION_CONTROL | n/a | n/a |
| GET | `/api/work-types` | none (справочник, не содержит персональных/финансовых данных) | any | n/a | n/a |
| POST | `/api/work-types` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER | n/a | basic |
| PUT | `/api/work-types/:id` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER | n/a | basic |
| PATCH | `/api/work-types/:id/archive` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER | n/a | n/a |
| GET | `/api/unified-control` | none | any | фильтрация по query `projectId`, но без проверки прав | n/a |
| POST | `/api/unified-control` | requireAuth | any | requireProjectAccess (если `projectId` передан в теле) | basic |
| PUT | `/api/unified-control/:id` (добавлен в Phase 9L) | requireAuth | any | requireProjectAccess (по `projectId` найденной записи) | basic |

## AI

| Method | Path | Auth | Role | Project | Input validation |
|---|---|---|---|---|---|
| POST | `/api/ai/chat` | requireAuth | any | `requireProjectAccess` при явном `projectId` | basic + prompt-injection defense; AI rate-limit 60/час |
| POST | `/api/ai/analyze-document` | requireAuth | any | n/a | basic; AI rate-limit 60/час |
| POST | `/api/ai/daily-report` | requireAuth | any | n/a | basic; AI rate-limit 60/час |
| GET | `/api/ai/resilience-status` | requireAuth | any | n/a | n/a |
| GET | `/api/ai/resilience-metrics` | requireAuth | any | n/a | n/a |
| POST | `/api/ai/circuit-reset` | requireAuth | ADMIN, SUPER_ADMIN | n/a | n/a |
| POST | `/api/ai/chaos-inject` | requireAuth | ADMIN, SUPER_ADMIN (+ запрет в production для не-SUPER_ADMIN) | n/a | strict |
| POST | `/api/projects/:projectId/ai-analysis` | requireAuth | any (после project-check) | requireProjectAccess | basic |
| GET | `/api/projects/:projectId/ai-analysis` | requireAuth | any | requireProjectAccess | n/a |
| GET | `/api/projects/:projectId/ai-analysis/status` | requireAuth | any | requireProjectAccess | n/a |
| GET | `/api/projects/:projectId/ai-analysis/estimate` | requireAuth | any | requireProjectAccess | n/a |
| GET | `/api/projects/:projectId/ai-analysis/risks` | requireAuth | any | requireProjectAccess | n/a |
| GET | `/api/projects/:projectId/ai-analysis/profitability` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, CUSTOMER, PTO_ENGINEER (не CONTRACTOR) | requireProjectAccess | n/a |
| GET | `/api/projects/:projectId/ai-analysis/report` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, CUSTOMER, PTO_ENGINEER (не CONTRACTOR) | requireProjectAccess | n/a |

## System

| Method | Path | Auth | Role | Project | Input validation |
|---|---|---|---|---|---|
| POST | `/api/system/backup` | requireAuth | ADMIN, SUPER_ADMIN | n/a | n/a (не принимает данные от клиента — реальный файл БД) |
| GET | `/api/system/backups` | requireAuth | ADMIN, SUPER_ADMIN | n/a | n/a |
| POST | `/api/system/restore` | requireAuth | ADMIN, SUPER_ADMIN | n/a | strict (проверка существования запрошенного файла бэкапа) |

---

## Найденные при построении матрицы проблемы

Обе найденные при построении этой матрицы IDOR-проблемы (`/api/documents/:id/view` без авторизации,
`/api/unified-control` POST без проверки принадлежности проекта) закрыты сразу же в этом же проходе —
см. таблицы выше и `CURRENT_SECURITY_STATUS.md` для BEFORE/AFTER. Ниже — то, что осознанно оставлено
как принятый риск, не как недосмотр:

1. **~~AI-калькуляторы без авторизации~~ — ИСПРАВЛЕНО в Wave 1 (2026-09-18).**

   Прежняя редакция этого пункта утверждала, что утечки чужих данных нет, «поскольку контекст
   документов передаётся самим клиентом, а не читается с сервера». **Это утверждение было
   неверным** и, будучи записанным в документе с префиксом `VERIFIED_`, впоследствии само стало
   основанием для ошибочного вывода `BLK-004` о том, что проблемы нет.

   Фактически `/api/ai/chat` при отсутствии `documents` в теле запроса подставлял документы
   проекта `proj-1`, читая их с сервера, и отдавал результат анонимному вызывающему
   (`SEC-001`, подтверждено независимой проверкой `SEC-VERIFY-001` контролируемым запросом).

   Текущее состояние: все пять AI-эндпоинтов требуют `requireAuth`; `/api/ai/chat` берёт контекст
   только из тела запроса либо из явно указанного `projectId` с проверкой `requireProjectAccess`;
   серверная подстановка проекта по умолчанию удалена; добавлен AI-специфичный лимит 60 запросов
   в час на пользователя. Зафиксировано регрессионными тестами в
   `tests/security/auth-and-idor.test.ts`.

   `/api/ovik/*` и `/api/specifications/compare` остаются без авторизации как чистые калькуляторы,
   не читающие серверные данные — это по-прежнему принятый риск, не изменён в Wave 1.
2. **`GET /api/work-types`, `GET /api/unified-control` — без авторизации.** Признано допустимым:
   справочные данные без персональной/финансовой информации.

Пункты 1 и 2 — реальные IDOR/tenant-isolation дефекты того же класса, что уже закрыты в этой сессии,
и должны быть исправлены в следующем коммите, а не считаться приемлемым риском.

## Phase 9 — Business Domain API (новые маршруты)

Все — `requireAuth` + `requireProjectAccess` для project-scoped, `requireRole` где указано. Личность
автора всегда из `req.user` (сессия), никогда из тела запроса.

| Method | Path | Auth | Role | Project | Input validation |
|---|---|---|---|---|---|
| GET | `/api/organizations` | requireAuth | any | n/a | n/a |
| POST | `/api/organizations` | requireAuth | ADMIN, SUPER_ADMIN | n/a | basic (name/inn/type обязательны) |
| GET | `/api/projects/:projectId/members` | requireAuth | any | requireProjectAccess | n/a |
| POST | `/api/projects/:projectId/members` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER | requireProjectAccess | basic |
| GET | `/api/projects/:projectId/estimates` | requireAuth | any | requireProjectAccess | n/a |
| POST | `/api/projects/:projectId/estimates` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, PTO_ENGINEER | requireProjectAccess | basic |
| GET | `/api/projects/:projectId/estimate-items` | requireAuth | any | requireProjectAccess | n/a |
| POST | `/api/projects/:projectId/estimate-items` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, PTO_ENGINEER | requireProjectAccess | basic |
| PUT | `/api/projects/:projectId/estimate-items/:id` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, PTO_ENGINEER | requireProjectAccess | basic |
| GET | `/api/projects/:projectId/schedule` | requireAuth | any | requireProjectAccess | n/a |
| POST | `/api/projects/:projectId/schedule` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, PTO_ENGINEER | requireProjectAccess | basic |
| PUT | `/api/projects/:projectId/schedule/:id` | requireAuth | + FOREMAN (прогресс могут отмечать прорабы) | requireProjectAccess | basic |
| GET | `/api/projects/:projectId/inspections` | requireAuth | any | requireProjectAccess | n/a |
| POST | `/api/projects/:projectId/inspections` | requireAuth | ADMIN, SUPER_ADMIN, CONSTRUCTION_CONTROL, CHIEF_ENGINEER, PTO_ENGINEER | requireProjectAccess | basic; `inspectorId` из сессии |
| GET | `/api/projects/:projectId/defects` | requireAuth | any | requireProjectAccess (уже было; теперь читает из реального repository, не из legacy-массива) | n/a |
| POST | `/api/projects/:projectId/defects` | requireAuth | any | requireProjectAccess | basic; `issuedByUserId` из сессии |
| PATCH | `/api/projects/:projectId/defects/:id/status` | requireAuth | ADMIN, SUPER_ADMIN, CONSTRUCTION_CONTROL, CHIEF_ENGINEER | requireProjectAccess | basic |
| GET | `/api/projects/:projectId/aosr` | requireAuth | any | requireProjectAccess | n/a |
| POST | `/api/projects/:projectId/aosr` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, PTO_ENGINEER, FOREMAN | requireProjectAccess | basic |
| POST | `/api/aosr/:aosrId/sign` (переписан в Phase 9) | requireAuth | CONTRACTOR, TECH_SUPERVISOR, CUSTOMER, ADMIN, SUPER_ADMIN | requireProjectAccess (по `projectId` найденного АОСР) | strict — переход проверяется по реальному сохранённому статусу, `currentStage` из тела запроса больше не читается вообще |
| GET | `/api/projects/:projectId/financial` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, CUSTOMER, PTO_ENGINEER (не CONTRACTOR — коммерческая тайна ГК) | requireProjectAccess | n/a |
| POST | `/api/projects/:projectId/financial` | requireAuth | ADMIN, SUPER_ADMIN, CHIEF_ENGINEER, PTO_ENGINEER | requireProjectAccess | strict (`entryType`/`amountRub` обязательны и типизированы) |

### Осознанно не защищено (то же обоснование, что и для остального API)

`GET /api/work-types`, `GET /api/unified-control` без авторизации — справочные данные, без
персональной/финансовой информации, решение принято раньше и не пересматривается в Phase 9.

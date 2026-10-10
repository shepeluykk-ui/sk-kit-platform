# DATA INVENTORY — СК-КИТ (PHASE 9A)

Построено прямым чтением кода: `src/types/index.ts` (992 строки, полная типизация домена),
`src/data/initialData.ts` (1344 строки, 17 экспортируемых mock-массивов),
`src/context/AppContext.tsx` (1216+ строк — единственное место, где определяется, что из этого
реально уходит на backend), `server.ts` (2680+ строк). Ничего не предполагается — для каждой строки
таблицы указана точная команда/грep, которой это подтверждено.

**Ключевой метод проверки:** полный список всех `fetch()`-вызовов в кодовой базе (единственный способ
понять, что реально долетает до backend):

```
$ grep -n "fetch(" src/context/AppContext.tsx
196   fetch('/api/auth/me', ...)
264   fetch('/api/auth/login', ...)
311   fetch('/api/auth/logout', ...)
586   fetch('/api/documents/upload-binary', ...)
902   fetch('/api/system/backup', ...)
923   fetch('/api/system/restore', ...)
959   fetch('/api/admin/registration-requests', ...)
986   fetch('/api/auth/register', ...)
1003  fetch('/api/auth/verify-code', ...)
1032  fetch('/api/auth/resend-code', ...)
1065  fetch('/api/admin/registration-requests/:id/approve', ...)
1091  fetch('/api/admin/registration-requests/:id/reject', ...)

$ grep -rn "fetch(" src/components/
AiAssistantView.tsx:83        fetch('/api/ai/chat', ...)
AiProjectAnalysisView.tsx:51  fetch('/api/projects/:id/ai-analysis', POST)
AiProjectAnalysisView.tsx:66  fetch('/api/projects/:id/ai-analysis', GET)
AiProjectAnalysisView.tsx:89  fetch('/api/projects/:id/ai-analysis/status', GET)
```

Это ВЕСЬ backend-трафик приложения. 17 из 19 сущностей ниже в него не входят вообще.

## Таблица сущностей

| Сущность | Frontend source | Backend API | DB | Persistent | Статус |
|---|---|---|---|---|---|
| **Users** | `INITIAL_USERS` (`initialData.ts:22`), используется для локального сопоставления по логину/роли | `/api/auth/*` полностью реальны | таблица `users` (SQLite) | ДА | **PASS** — единственная полностью серверная сущность |
| **Organizations** | `INITIAL_ORGANIZATIONS` (`initialData.ts:104`), `useState` без чтения/записи на backend | НЕТ. `mockUsers`/`users` в БД хранят только плоские `organizationId`/`organizationName` строки — отдельной сущности Organization на backend нет вообще | НЕТ | НЕТ | **NOT IMPLEMENTED** (backend) |
| **Projects** | `INITIAL_PROJECTS` (`initialData.ts:163`), `const [projects] = useState(...)` — не читается и не пишется в API вообще | Частично: `projectDataStore` в `server.ts` существует, но это ДРУГАЯ, более простая структура (используется только `/documents`, `/defects`, upload, AI-analysis) — не то же самое, что фронтендовый `Project` (нет `budgetContractRub`, `physicalProgressPercent` и т.д. на backend) | таблица `projects` (SQLite) хранит `projectDataStore`, НЕ `INITIAL_PROJECTS` | Частично (backend-версия проекта) | **PARTIAL / MISMATCHED MODEL** — два разных, несвязанных представления "проекта" |
| **Estimates / EstimateItem** | `INITIAL_ESTIMATE_ITEMS` (`initialData.ts:337`), `setEstimateItems` — чисто локально | НЕТ | НЕТ | НЕТ | **NOT IMPLEMENTED** |
| **Schedule (ScheduleTask)** | `INITIAL_SCHEDULE_TASKS` (`initialData.ts:417`), `setScheduleTasks` — чисто локально | НЕТ | НЕТ | НЕТ | **NOT IMPLEMENTED** |
| **Works** | Отдельной сущности "Work" в `types/index.ts` нет. Ближайший реальный аналог — `UnifiedControlRecord` (проект→объект→зона→этаж→ось→вид работ, план/факт объёма, hold/witness point, привязка к АОСР) | `POST/GET /api/unified-control` реален и защищён (Phase 8) | таблица `unified_control` (SQLite) | ДА (backend), НО фронтенд его не вызывает — см. ниже | **MISMATCHED** — backend готов, frontend не подключён |
| **Inspections** | `INITIAL_INSPECTIONS` (`initialData.ts:494`), `setInspections` — чисто локально | Частично: `POST /api/inspections/:inspectionId/accept-work` реален, но это ОДНО действие (Hold Point accept), не CRUD над `InspectionRecord`; собственного хранилища инспекций нет | НЕТ | НЕТ | **NOT IMPLEMENTED** (как сущность), **PARTIAL** (как единичное действие) |
| **Defects** | `INITIAL_DEFECTS` (`initialData.ts:611`), `setDefects` — чисто локально | НЕТ | НЕТ | НЕТ | **NOT IMPLEMENTED** |
| **Executive Documentation (ExecutiveDocItem)** | `INITIAL_EXECUTIVE_DOCS` (`initialData.ts:688`), `setExecutiveDocs` — чисто локально | НЕТ (документы `/api/documents/*` — это ДРУГАЯ сущность, `ProjectDocument`, не `ExecutiveDocItem`) | НЕТ | НЕТ | **NOT IMPLEMENTED** |
| **AOSR** | Нет отдельного mock-массива в `initialData.ts` (только вложенные `aosr` объекты внутри backend `projectDataStore` seed-проектов и поле `aosrId`/`aosrStatus` внутри `UnifiedControlRecord`) | `POST /api/aosr/:aosrId/sign` реален, НО **полностью stateless** — состояние `currentStage` берётся из тела запроса клиента и нигде не сохраняется между вызовами; собственного хранилища АОСР нет | НЕТ | НЕТ | **CRITICAL GAP** — сервер доверяет клиенту заявленной стадии подписания; см. ниже |
| **Contractor Performance** | `INITIAL_CONTRACTOR_PERFORMANCE` (`initialData.ts:742`), `useState` без записи | НЕТ | НЕТ | НЕТ | **NOT IMPLEMENTED** |
| **Financial Data (KsDocument/Ks2Item)** | `INITIAL_KS_DOCUMENTS` (`initialData.ts:777`), `setKsDocuments` — чисто локально | Частично: `POST /api/finance/validate-ks2` — чистый калькулятор-валидатор (не читает и не пишет никакого хранилища, только валидирует переданные клиентом числа) | НЕТ | НЕТ | **NOT IMPLEMENTED** (как хранимая сущность) |
| **Risks (ProjectRisk)** | `INITIAL_RISKS` (`initialData.ts:812`), `setRisks` — чисто локально | НЕТ (AI-анализ проекта генерирует `AiProjectRiskItem` — другая структура, живёт только в памяти `ProjectAnalysisOrchestrator`, не в этом хранилище) | НЕТ | НЕТ | **NOT IMPLEMENTED** |
| **Notifications** | `INITIAL_NOTIFICATIONS` (`initialData.ts:847`), `setNotifications` — чисто локально | НЕТ | НЕТ | НЕТ | **NOT IMPLEMENTED** |
| **Audit Log (UI)** | `INITIAL_AUDIT_LOGS` (`initialData.ts:874`) + локальный `logAction()` в `AppContext.tsx` — **никогда не читает и не пишет `/api/audit/logs`** | Backend `logAudit()`/`/api/audit/logs` — полностью отдельная, реальная, персистентная система аудита (см. Phase 7/8) | таблица `audit_log` (SQLite) | ДА (backend), но UI её не показывает | **MISMATCHED** — на backend полноценный реальный аудит есть, но `AuditLogView.tsx` показывает локальную имитацию, не настоящий лог |
| **Work Types** | `INITIAL_WORK_TYPES` (`initialData.ts:906`), инициализируется из `localStorage`, затем из `INITIAL_WORK_TYPES`; `addWorkType`/`updateWorkType`/`archiveWorkType` — чисто локальные мутации + запись в `localStorage`, **backend НЕ вызывается** | `GET/POST/PUT/PATCH /api/work-types*` полностью реален и защищён (Phase 8) | таблица `work_types` (SQLite) | ДА (backend), НО не используется UI | **MISMATCHED** — backend готов и защищён, frontend работает мимо него |
| **Unified Control Records** | `INITIAL_UNIFIED_CONTROL_RECORDS` (`initialData.ts:1256`), та же схема — `localStorage` + локальные CRUD, backend не вызывается | `GET/POST /api/unified-control` реален и защищён (Phase 8) | таблица `unified_control` | ДА (backend), НО не используется UI | **MISMATCHED** |
| **Project Participants / Project Members** | Не существует как отдельная сущность. Членство в проекте — это только массив `user.allowedProjectIds: string[]` на самом пользователе (и на backend `user.projectIds`/`allowedProjectIds` в `mockUsers`) | Косвенно — проверяется в `requireProjectAccess()` | часть таблицы `users` (JSON-поле) | ДА (как часть User) | **IMPLICIT MODEL** — нет join-таблицы `project_members`, членство однонаправленное (User → projects), а не Project → participants с ролью в конкретном проекте |
| **Project Settings** | Не существует как тип/сущность нигде в кодовой базе (`grep "ProjectSettings"` — пусто) | НЕТ | НЕТ | НЕТ | **NOT IMPLEMENTED / NOT DEFINED** |
| **Tasks** | Нет отдельного типа `Task` — ближайший аналог `ScheduleTask` (`types/index.ts:264`, WBS-график) | НЕТ | НЕТ | НЕТ | **NOT IMPLEMENTED** (совпадает с Schedule) |

## Критические находки этого прохода (важны для Phase 9B/9I)

1. **`Project` во фронтенде и `projectDataStore` в backend — это две РАЗНЫЕ, несовместимые модели.**
   Фронтендовый `Project` (types/index.ts:145) имеет 20+ полей (бюджет, KPI, оси, менеджер, ГИП...).
   Backend `projectDataStore[id]` — это просто `{id, name, code, organizationId, documents[], defects[],
   holdPoints[], aosr[]}`. При проектировании `DOMAIN_MODEL.md`/схемы БД нужно выбрать одну модель
   (рекомендация: расширить backend-модель до фронтендового контракта, а не наоборот — фронтенд уже
   рассчитан на богатую модель).

2. **АОСР на backend полностью бессостоятелен (stateless) и доверяет клиенту.** Эндпоинт
   `/api/aosr/:aosrId/sign` не хранит АОСР вообще — переход состояний (`DRAFT` →
   `SIGNED_BY_CONTRACTOR` → `SIGNED_BY_TECH_SUPERVISOR` → `FULLY_APPROVED`) проверяется по полю
   `currentStage` ИЗ ТЕЛА ЗАПРОСА КЛИЕНТА, а не по реальной сохранённой записи. Это значит, что
   клиент может заявить любую `currentStage` и обойти последовательность подписания (например,
   CUSTOMER может утвердить АОСР, заявив `currentStage: "SIGNED_BY_TECH_SUPERVISOR"`, даже если
   технадзор ничего не подписывал). Это отдельный, более серьёзный дефект, чем то, что было закрыто
   в Phase 8 (там закрыта подмена ЛИЧНОСТИ подписанта; подмена СОСТОЯНИЯ документа осталась). Будет
   закрыто в Phase 9I вместе с реализацией персистентной сущности AOSR.

3. **Work Types и Unified Control — backend полностью готов и защищён (Phase 8), но фронтенд
   работает МИМО него, используя `localStorage`.** Это означает, что данные о видах работ и точках
   контроля не синхронизированы между пользователями/устройствами и не покрываются backup/restore,
   несмотря на то что серверная инфраструктура для них уже существует. Это самая дешёвая часть
   Phase 9L (нужно просто подключить существующие защищённые эндпоинты, схему БД менять не надо).

4. **Аудит-лог в UI — полная имитация, при этом настоящий, персистентный, защищённый аудит-лог
   существует на backend и не используется.** Аналогично п.3 — дешёвый выигрыш для Phase 9L.

5. **AI-анализ проекта — уже подключён к backend правильно** (в отличие от work-types/unified-control),
   но в ходе этого прохода найдена и исправлена регрессия: после того как в Phase 8 к
   `/api/projects/:projectId/ai-analysis*` был добавлен `requireAuth`, `AiProjectAnalysisView.tsx`
   не был обновлён и продолжал слать запросы без токена — реально ловил бы `401` на каждый показ
   вкладки AI-анализа. Исправлено в рамках этого прохода (передача `Authorization: Bearer` во все
   3 fetch-вызова компонента).

6. **`Organization` не существует на backend вообще** — ни как отдельное хранилище, ни как таблица.
   Учитывая, что план (раздел 4 задания) требует tenant-модель `organization → project membership →
   resource`, это блокер для Phase 9B/9C: без реальной сущности Organization невозможно построить
   честную multi-tenant авторизацию по организациям (сейчас `requireProjectAccess` проверяет
   принадлежность к ПРОЕКТУ напрямую через `user.projectIds`, минуя понятие организации).

## Сводка по статусам (для раздела 31 итогового критерия)

```
Users:                  PASS (уже персистентно, Phase 7/8)
Organizations:          NOT IMPLEMENTED
Projects:               PARTIAL / MISMATCHED MODEL
Estimates:               NOT IMPLEMENTED
Schedule:                NOT IMPLEMENTED
Works (Unified Control): MISMATCHED (backend готов, frontend не подключён)
Inspections:             NOT IMPLEMENTED (как сущность)
Defects:                 NOT IMPLEMENTED
Executive Docs:          NOT IMPLEMENTED
AOSR:                    CRITICAL GAP (stateless, доверяет клиенту)
Contractor Performance:  NOT IMPLEMENTED
Financial (KS-2/КС-3):   NOT IMPLEMENTED
Risks:                   NOT IMPLEMENTED
Notifications:           NOT IMPLEMENTED
Audit Log (UI):          MISMATCHED (backend готов, frontend не подключён)
Work Types:               MISMATCHED (backend готов, frontend не подключён)
Project Participants:    IMPLICIT (нет join-модели с ролью-в-проекте)
Project Settings:        NOT IMPLEMENTED / NOT DEFINED
Tasks:                    N/A (совпадает со Schedule)
```

**Следующий шаг: Phase 9B — Domain Model**, основанный на этой инвентаризации и реальных TypeScript-типах.

> **STATUS: REAL, VERIFIED, PARTIAL** — backend полностью реализован и протестирован; frontend
> подключён для 3 из ~9 затронутых сущностей (work-types, unified-control — полностью;
> defects — только чтение). Отчёт не заявляет большего, чем фактически сделано.

# PHASE 9 — МИГРАЦИЯ БИЗНЕС-ДАННЫХ ИЗ FRONTEND STATE В PERSISTENT BACKEND

Дата: 2026-08-31. Коммиты: `051f5c9` (backend), `909a9d6` (frontend Phase 9L, Work Types/Unified
Control). Полная методология и пошаговые находки — `docs/architecture/DATA_INVENTORY.md` (Phase 9A)
и `docs/architecture/DOMAIN_MODEL.md` (Phase 9B).

## Что было (реальное состояние до Phase 9)

Независимая проверка (`grep -n "fetch(" src/context/AppContext.tsx src/components/*.tsx`) показала,
что весь трафик к backend ограничивался: аутентификацией, загрузкой документов, backup/restore,
регистрацией пользователей и AI-анализом проекта. Всё остальное — 17 сущностей из
`src/data/initialData.ts` (проекты, организации, документы-в-реестре, сметы, график, инспекции,
VRF-системы, дефекты, исполнительная документация, показатели подрядчиков, КС-2/КС-3, риски,
уведомления, аудит-лог в UI, виды работ, unified control) — существовали только в React `useState`,
частично зеркалируясь в `localStorage` браузера. Backend для work-types и unified-control уже
существовал и был защищён (Phase 8), но фронтенд его не вызывал вообще.

Отдельно обнаружено: `/api/aosr/:aosrId/sign` был полностью stateless — состояние подписания
(`currentStage`) бралось из тела запроса клиента без какой-либо сохранённой записи, то есть клиент
мог заявить любую стадию и обойти обязательную последовательность подписания
(РД-11-02-2006). Это не было закрыто предыдущими security-фиксами (Phase 7/8), которые устранили
подмену личности/роли подписанта, но не подмену состояния документа.

## Что сделано

### Backend (Phase 9C–9K) — реализовано и протестировано полностью

1. **Схема БД расширена** (`src/server/database.ts`): 14 новых таблиц (`organizations`,
   `project_members`, `estimates`, `estimate_items`, `schedule_tasks`, `inspections`, `defects`,
   `aosr`, `aosr_signatures`, `executive_docs`, `financial_entries`, `ai_analyses`, `notifications`,
   `contractor_performance`) поверх уже существующей SQLite-БД (`data/skkit.db`) — вторая независимая
   БД не создавалась. Project-scoped таблицы получили индексированную колонку `project_id` для
   реального SQL-фильтра, а не загрузки всей таблицы в JS. Добавлена автоматическая миграция схемы
   для уже существовавшей таблицы `unified_control` (не имела этой колонки раньше).
2. **Repository-слой** (`src/server/repositories/*.ts`, 5 файлов): `organizations.ts` (Organization +
   ProjectMember), `estimates.ts`, `construction.ts` (Schedule/Inspection/Defect), `aosr.ts`
   (с реальной state machine), `financial.ts`. Паттерн: API → Service (repository-функции) →
   Database — без промежуточного отдельного слоя контроллеров, поскольку `server.ts` уже содержит
   их роль (не делался лишний рефакторинг ради рефакторинга).
3. **21 новый API-маршрут** плюс переписан существующий `/api/aosr/:aosrId/sign`. Полный список с
   security-характеристиками — `docs/security/VERIFIED_API_SECURITY_MATRIX.md`, раздел "Phase 9".
4. **АОСР — реальная серверная state machine.** Переход статуса проверяется по фактически
   сохранённой записи `Aosr.status`; `currentStage` из тела запроса вообще не читается сервером.
   Подтверждено тестом: клиент, заявляющий ложную стадию, всё равно получает отказ, соответствующий
   реальному статусу.
5. **Одноразовая миграция demo-данных**: старые захардкоженные `projectDataStore[id].defects`/`.aosr`
   (2 seed-записи) перенесены в новые таблицы при первом запуске после Phase 9 — не потеряны.
6. **Реконсиляция ID проектов**: обнаружено, что `activeProjectId` фронтенда по умолчанию —
   `proj-aeron` (реальный пилотный объект), но backend `projectDataStore` не содержал такой проект
   вообще — каждый project-scoped запрос к дефолтному активному проекту получал бы 404. Добавлены
   `proj-aeron` и `proj-technopark`, соответствующие тому, что уже использовалось в
   `mockUsers[...].projectIds`.
7. **Регрессия найдена и исправлена**: `AiProjectAnalysisView.tsx` перестал бы работать (401 на
   каждый запрос) после того, как в предыдущей фазе к `/api/projects/:id/ai-analysis*` добавили
   `requireAuth` — фронтенд не был обновлён вместе с этим. Исправлено добавлением `Authorization`
   заголовка во все 3 fetch-вызова компонента.

### Frontend (Phase 9L) — реализовано частично, с прозрачным охватом

| Сущность | Что сделано |
|---|---|
| Work Types | **Полностью подключено.** Загрузка при монтировании, create/update/archive — реальные API-вызовы, состояние обновляется из ответа сервера. Проверено в браузере: создан вид работ через UI-форму, подтверждено прямым `curl`, что запись реально в backend. |
| Unified Control | **Полностью подключено** (тот же паттерн). Добавлен отсутствовавший `PUT /api/unified-control/:id`. |
| Defects | **Частично.** `GET /api/projects/:projectId/defects` теперь читает из реального repository (не из старого статичного массива) — это уже было подключено к API и продолжает работать, просто источник данных стал реальным. Создание дефекта через UI ещё не переключено на `POST /api/projects/:projectId/defects` (сама возможность в UI на данный момент ограничена). |
| Estimates, Schedule, Inspections, AOSR (создание/подпись через UI), Financial, Organizations, Project Members | **НЕ подключено.** Backend полностью готов, защищён и протестирован (`tests/e2e/`), но соответствующие view (`EstimatesView.tsx`, `ScheduleView.tsx`, `ConstructionControlView.tsx`, `ExecutiveDocsView.tsx`, `FinanceView.tsx`, `OrganizationsView.tsx`) продолжают использовать `INITIAL_*`/локальный `useState`. Причина: их формы/таблицы завязаны на старые frontend-типы, которые не совпадают по полям с новыми backend-сущностями один в один (расхождения намеренные — см. `DOMAIN_MODEL.md`); переключение каждого view — отдельная, аккуратная задача с визуальной проверкой, а не смена одной строки. |
| Audit Log UI | **НЕ подключено.** `AuditLogView.tsx` по-прежнему использует `INITIAL_AUDIT_LOGS` + локальный `logAction`, хотя `/api/audit/logs` полностью реален, защищён (Phase 8) и протестирован. |

## Таблицы

`organizations`, `project_members`, `estimates`, `estimate_items`, `schedule_tasks`, `inspections`,
`defects`, `aosr`, `aosr_signatures`, `executive_docs`, `financial_entries`, `ai_analyses`,
`notifications`, `contractor_performance` — все в `data/skkit.db` (тот же файл, что и раньше).

## API

21 новый маршрут + 1 переписанный (`/api/aosr/:aosrId/sign`) + 1 добавленный
(`PUT /api/unified-control/:id`). Полная таблица с security-характеристиками —
`docs/security/VERIFIED_API_SECURITY_MATRIX.md`.

## Изменённые/добавленные файлы

```
server.ts                                    — +21 маршрут, миграция seed-данных, реконсиляция ID проектов
src/server/database.ts                       — 14 новых таблиц, индекс по project_id, миграция схемы
src/server/repositories/organizations.ts     — новый
src/server/repositories/estimates.ts         — новый
src/server/repositories/construction.ts      — новый (schedule/inspections/defects)
src/server/repositories/aosr.ts              — новый (реальная state machine)
src/server/repositories/financial.ts         — новый
src/context/AppContext.tsx                   — work-types/unified-control подключены к реальному API
src/components/AiProjectAnalysisView.tsx     — фикс регрессии (Authorization header)
docs/architecture/DATA_INVENTORY.md          — новый (Phase 9A)
docs/architecture/DOMAIN_MODEL.md            — новый (Phase 9B)
docs/architecture/CURRENT_ARCHITECTURE.md    — обновлён
docs/security/CURRENT_SECURITY_STATUS.md     — обновлён (раздел Phase 9)
docs/security/VERIFIED_API_SECURITY_MATRIX.md — обновлён (раздел Phase 9)
tests/e2e/phase9-domain-entities.test.ts     — новый (10 тестов)
package.json                                 — добавлен npm run test:e2e
```

## Тесты

```
npm run test:security → 31/31 PASS (без регрессии от Phase 9)
npm run test:e2e       → 10/10 PASS (новый набор: create/re-read, tenant isolation, role restriction,
                          АОСР state machine включая anti-forgery случай)
npx tsc --noEmit        → 0 ошибок
npm run build           → успешно
```

Реальный restart-тест (создание записи → `kill` процесса → повторный запуск → чтение того же id) —
пройден для estimate, schedule task, inspection, defect, aosr, financial entry (включая проверку, что
мигрированные legacy-записи `def-1`/`aosr-1` тоже присутствуют после рестарта).

Реальный tenant-тест — пользователь без доступа к `proj-2` получает `403` на каждую новую сущность
(`estimates`, `schedule`, `inspections`, `defects`, `aosr`, `financial`); тот же пользователь получает
`200` на свой `proj-1`. Роль `CONTRACTOR` дополнительно получает `403` на финансовые данные (не только
изоляция по проекту, но и по роли).

## Результаты (по критерию раздела 31 задания — только то, что подтверждено)

```
Organizations (backend):     PASS
Organizations (frontend):    NOT IMPLEMENTED (backend готов)
Project Members (backend):   PASS
Project Members (frontend):  NOT IMPLEMENTED (backend готов)
Estimate persistence:        PASS (backend) / PARTIAL (frontend не подключён)
Schedule persistence:        PASS (backend) / PARTIAL (frontend не подключён)
Work persistence (Unified Control): PASS (backend + frontend оба подключены)
Inspection persistence:      PASS (backend) / PARTIAL (frontend не подключён)
Defect persistence:          PASS (backend) / PARTIAL (frontend: чтение подключено, создание — нет)
AOSR persistence:            PASS (backend, включая реальную state machine) / PARTIAL (frontend не подключён)
Financial persistence:       PASS (backend) / PARTIAL (frontend не подключён)
AI persistence:               NOT IMPLEMENTED (таблица ai_analyses создана, но ProjectAnalysisOrchestrator
                               продолжает хранить job'ы только в памяти — не входило в объём этого прохода)
Restart persistence:          PASS (для всего, что реально создано через API)
Tenant isolation (новые сущности): PASS
Security regression:          PASS (31/31, без изменений)
Build:                        PASS
E2E (новый набор Phase 9):    PASS (10/10)
FRONTEND MOCK BUSINESS DATA:  НЕ 0. Explicitly: Estimates/Schedule/Inspections/Defects(создание)/AOSR/
                               Financial/Organizations/AuditLogView UI всё ещё читают INITIAL_*/
                               локальный state. Work Types и Unified Control — единственные полностью
                               мигрированные UI-сущности из этого списка.
```

## Оставшиеся проблемы (честно, без приукрашивания)

1. **Frontend-миграция большинства новых сущностей не завершена** — это основной оставшийся объём
   работы, не архитектурная неопределённость: backend, схема, тесты для этого уже существуют.
2. **`Project`/`Organization` существуют в двух несовместимых представлениях** (богатая
   frontend-модель vs. простая backend) — не объединены в этом проходе, см. `DOMAIN_MODEL.md`.
   Нужно решить перед тем, как переключать `EstimatesView`/`FinanceView` на реальные данные, иначе
   фронтендовые KPI-поля проекта (бюджет, прогресс) останутся статичными, не связанными с реальными
   `financial_entries`/`schedule_tasks`.
3. **AI-анализ проекта (`ProjectAnalysisJob`) не персистентен** — таблица `ai_analyses` создана
   (готова к использованию), но `ProjectAnalysisOrchestrator` продолжает хранить результаты только
   в памяти процесса; не входило в объём этого прохода (backend AI-анализа и так уже был единственной
   ранее-реально-подключённой к API бизнес-сущностью, за пределами work-types/unified-control).
4. **`Notification`/`ContractorPerformance`** — таблицы созданы для полноты схемы, но без API/UI в
   этом проходе (см. `DOMAIN_MODEL.md`, раздел "что сознательно не вводится").

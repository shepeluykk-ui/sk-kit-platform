# FRONTEND DATA MIGRATION — СК-КИТ (PHASE 9L.2)

Живой документ — обновляется по мере миграции каждого модуля. Построено проверкой реального кода:
`grep -rln "INITIAL_ESTIMATE_ITEMS|INITIAL_SCHEDULE_TASKS|..." src/` показал, что все mock-массивы
используются **только** в `src/context/AppContext.tsx` — ни один компонент не импортирует
`initialData.ts` напрямую, поэтому вся миграция локализована в одном файле (`AppContext.tsx`) плюс
backend (`server.ts` + `src/server/repositories/*.ts`).

## Таблица

| Модуль | Current Source (до) | API | Backend | DB | UI switched | Status |
|---|---|---|---|---|---|---|
| Auth | `/api/auth/*` | ✅ | ✅ | ✅ | ✅ | PASS (было готово до Phase 9L.2) |
| Work Types | `localStorage`+`INITIAL_WORK_TYPES` | ✅ | ✅ | ✅ | ✅ | PASS (Phase 9L) |
| Unified Control | `localStorage`+`INITIAL_UNIFIED_CONTROL_RECORDS` | ✅ | ✅ | ✅ | ✅ | PASS (Phase 9L) |
| Documents | `/api/documents/*` | ✅ | ✅ | ✅ | ✅ | PASS (было готово до Phase 9L.2) |
| **Estimates / Estimate Items** | `INITIAL_ESTIMATE_ITEMS` (React state) | ✅ | ✅ | ✅ | ✅ | **PASS (Phase 9L.2, этот проход)** |
| Schedule | `INITIAL_SCHEDULE_TASKS` (React state) | ✅ | ✅ | ✅ | ⏳ | В работе |
| Inspections | `INITIAL_INSPECTIONS` (React state) | ✅ | ✅ | ✅ | ⏳ | Следующий |
| Defects (чтение) | реальный backend (Phase 9) | ✅ | ✅ | ✅ | ✅ | PASS (Phase 9) |
| Defects (создание/статус через UI) | `INITIAL_DEFECTS` (React state) | ✅ | ✅ | ✅ | ⏳ | Следующий |
| AOSR | нет UI для создания/подписи | ✅ | ✅ | ✅ | ⏳ | Следующий (нет текущего UI-потребителя — см. примечание) |
| Financial (КС-2/КС-3) | `INITIAL_KS_DOCUMENTS` (React state) | ✅ | ✅ | ✅ | ⏳ | Следующий |
| Audit Log (UI) | `INITIAL_AUDIT_LOGS` + локальный `logAction` | ✅ | ✅ | ✅ | ⏳ | Следующий |
| Organizations | `INITIAL_ORGANIZATIONS` (React state, read-only в UI) | ✅ | ✅ | ✅ | ⏳ | P2 — не блокирует остальные модули |
| Projects (богатая модель) | `INITIAL_PROJECTS` (React state) | частично | частично (упрощённая модель) | ✅ (упрощённая) | ❌ | Отдельная задача — см. `DOMAIN_MODEL.md`, две несовместимые модели Project |
| Executive Docs | `INITIAL_EXECUTIVE_DOCS` (React state) | ❌ | ❌ | ❌ (таблица `executive_docs` создана, API нет) | ❌ | NOT IMPLEMENTED — вне текущего приоритетного списка (задание перечисляет Estimates→Schedule→Inspections→Defects→AOSR→Financial→Audit Log) |
| Risks, Notifications, Contractor Performance, VRF Systems | `INITIAL_*` (React state) | ❌ | ❌ (таблицы `notifications`/`contractor_performance` созданы для полноты схемы, без API) | частично | ❌ | NOT IMPLEMENTED — сознательно вне объёма Phase 9L.2 (см. `DOMAIN_MODEL.md`, раздел "что сознательно не вводится") |

## Примечание по AOSR

В текущем UI (`UnifiedControlView.tsx`) есть кнопка `handleSignAosr`, но её обработчик — чисто
локальная логика, не вызывающая ни старый, ни новый backend-эндпоинт (подтверждено ранее в
`DATA_INVENTORY.md`). То есть AOSR-модуль нужно не просто "переключить", а впервые подключить
реальный UI-поток к уже готовой (и security-исправленной) серверной state machine — это отдельная,
чуть более объёмная задача, чем переключение источника данных для уже существующего потока.

## Development/test fixtures (не production usages — согласно правилу раздела 25 задания)

- `src/data/initialData.ts` — остаётся источником seed-данных для one-time backend-миграции
  (см. `server.ts`, функция `bootstrapPersistence()`) и как fallback для мгновенной первой отрисовки
  UI до того, как реальный `fetch()` успеет отработать (тот же паттерн, что уже используется для
  Work Types/Unified Control/Estimates).
- `tests/security/`, `tests/e2e/` — используют собственные тестовые данные через реальные API-вызовы,
  не `initialData.ts`.

## Как читать эту таблицу дальше

Обновляется после завершения каждого модуля (раздел 26 задания). Финальная проверка (раздел 25) —
`grep` на `INITIAL_(ESTIMATE|SCHEDULE|INSPECTION|DEFECT|KS_DOCUMENT)` в `AppContext.tsx` вне
`useState(...)`-фолбэка и seed-миграции backend не должен находить usage в качестве источника
актуального состояния после переключения на `fetch()`.

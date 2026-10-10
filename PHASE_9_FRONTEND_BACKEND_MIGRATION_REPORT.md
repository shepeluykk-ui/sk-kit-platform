> Каждая строка ниже подтверждена реальным кодом, реальным HTTP-запросом, реальным тестом или
> реальной браузерной проверкой — не декларацией.

# PHASE 9L.2 — ПОЛНЫЙ ПЕРЕХОД FRONTEND НА BACKEND: ИТОГОВЫЙ ОТЧЁТ

Актуально на: 2026-08-31. Репозиторий: `D:\SK-KIT`.

## Итог

Все 7 модулей из исходного списка Phase 9L.2 переведены с `INITIAL_*` mock-массивов на реальный
backend, с явными состояниями загрузки/ошибки/пустого списка и без отката на mock при сбое API:

| # | Модуль | Статус |
|---|---|---|
| 1 | Estimates (Сметы) | ✅ PASS |
| 2 | Schedule (График/WBS) | ✅ PASS |
| 3 | Inspections (Проверки/Hold Points) | ✅ PASS |
| 4 | Defects (Дефекты/Замечания) | ✅ PASS |
| 5 | AOSR (Единая модель контроля / Акты) | ✅ PASS |
| 6 | Financial (КС-2/КС-3) | ✅ PASS |
| 7 | Audit Log (Журнал аудита) | ✅ PASS |

**FRONTEND BUSINESS MOCK = 0 продакшн-использований** для всех 7 модулей (проверено `grep` — только
комментарии и one-time seed-миграция в `server.ts`).

## Хронология и что реально произошло

Модули 2-4 (Schedule/Inspections/Defects) были отмечены PASS в более ранней, быстрой части этой же
сессии. При финальном сквозном аудите обнаружилось, что все три имели тот же запрещённый паттерн,
что и Estimates до хардненинга: `useState(INITIAL_*)` как стартовое состояние + `fetch(...).catch(()
=> {})` — при любой ошибке API mock оставался на экране неотличимым от реальных данных. Все три
дотянуты до полного стандарта в этом же проходе (см. коммит `079fc67`).

## Найденные и исправленные реальные баги (не декларативно, все подтверждены до/после)

1. **Estimates**: `conflictReason` не очищался на сервере после исправления конфликта (`undefined`
   не сериализуется в JSON, PATCH-объект бэкенда никогда не получал явную очистку поля).
2. **AOSR — критический**: state machine подписания была завязана на несуществующую роль
   `TECH_SUPERVISOR` (реальная роль — `CONSTRUCTION_CONTROL`). Ни один реальный пользователь не мог
   подписать вторую стадию акта.
3. **AOSR/Unified Control — уязвимость**: `GET /api/unified-control` не имел `requireAuth` вовсе —
   анонимный доступ к данным готовности АОСР по всем проектам.
4. **AOSR**: `CONTRACTOR` мог подписывать акт, но не мог его создать — первая подпись всегда падала
   с 403.
5. **Financial**: `FinanceView.tsx` обращался к несуществующим полям `KsDocument`
   (`documentNumber`/`period`/`amountRub`/`docCompletenessCheck` вместо реальных
   `docNumber`/`periodStart+periodEnd`/`totalSumWithVatRub`) — обнаружено только после исправления
   инфраструктурного бага ниже.
6. **Инфраструктурный — фундаментальный**: в проекте отсутствовал пакет `@types/react`. Из-за этого
   `npx tsc --noEmit` не проверял НИЧЕГО, связанного с React (useState/useContext/JSX = `any` без
   ошибок), вероятно, со времён создания проекта. Установлен `@types/react`/`@types/react-dom` —
   вскрылось 89 реальных ошибок типов в 12 файлах. 16 исправлено в рамках Phase 9L.2
   (`FinanceView.tsx` — 9, `RemarksDefectsView.tsx` — 7); оставшиеся 73 вынесены в отдельную задачу
   (файлы вне периметра Phase 9L.2: `OvikModuleView`, `ContractorsView`, `AiProjectAnalysisView`,
   `DocumentsView`, `DashboardView`, `ExecutiveDocsView`, `MobileMessagesBlock`, `OrganizationsView`,
   `RisksView`, `MobileSiteModal`).
7. **Defects — второй, независимый баг** (обнаружен тем же аудитом типов): `RemarksDefectsView.tsx`
   создавал дефект с полями, которых нет ни в типе `DefectRemark`, ни в реальном API
   (`responsibleContractorName`, `authorName`, `regulatoryBasis`, `designDocReference`,
   `isHoldPointBlocked`, `location.building`) — имя подрядчика и другие поля молча терялись при
   каждом реальном создании замечания.

## Верификация (единообразно по каждому модулю)

- `npx tsc --noEmit` — чисто для каждого затронутого файла.
- `npm run build` — чисто.
- `npm run test:security` — **37/37 PASS** (было 31/31 на начало Phase 9L.2; +6 новых тестов на
  найденные уязвимости/tenant isolation).
- `npm run test:e2e` — **25/25 PASS** (было 17/17 на начало Phase 9L.2; +8 новых тестов).
- Реальный restart-тест (create → kill backend → start → re-auth → найти по ID) — для каждого модуля.
- Реальная браузерная проверка через `Claude_Browser` MCP: логин под РЕАЛЬНЫМИ учётками разных ролей
  (не через демо-переключатель ролей), полный цикл create/update → refresh → logout/login →
  повторное открытие — для Estimates, AOSR (3 роли: CONTRACTOR/CONSTRUCTION_CONTROL/CUSTOMER),
  Financial (2 роли), Schedule/Inspections/Defects (чтение), Audit Log.

## Явно вне периметра этой миграции (не трогалось намеренно)

- Users/Organizations/Projects/Documents(РД)/VRF Systems/Executive Docs/Contractor
  Performance/Risks/Notifications/Work Types — всё ещё на `INITIAL_*`. Не входили в исходный список
  из 7 модулей Phase 9L.2.
- 73 оставшиеся ошибки типов вне периметра (см. п. 6 выше) — отдельная фоновая задача.
- Криптографическая tamper-evident цепочка для Audit Log — по явному решению не добавлялась сейчас
  (было новой функциональностью, не миграцией данных); вместо этого убрана ложная надпись
  "TAMPER-EVIDENT VERIFIED", которая была неправдой независимо от источника данных.

## Следующий шаг

Phase 9L.2 (по исходному списку из 7 модулей) завершена. Дальнейшие приоритеты — см.
`MASTER_PROJECT_STATUS.md`, раздел «Дальнейший приоритет».

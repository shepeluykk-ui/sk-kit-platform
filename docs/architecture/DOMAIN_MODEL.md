# DOMAIN MODEL — СК-КИТ (PHASE 9B)

Основано на `DATA_INVENTORY.md` и реальных TypeScript-типах в `src/types/index.ts` (эти типы уже
образуют богатую, продуманную доменную модель — задача этой фазы не изобрести её заново, а
перенести на backend с минимальными, обоснованными изменениями и заполнить реальные пробелы:
Organization как сущность, Project Members как явная связь, AOSR как персистентная сущность).

## Диаграмма сущностей

```
Organization
    │
    ├──< User (organizationId)
    │
    ├──< Project (customerOrgId, generalContractorOrgId — организация может быть в нескольких ролях)
    │
    ▼
Project ──< ProjectMember (userId, projectId, roleInProject) ─── явная замена implicit allowedProjectIds
    │
    ├──< ProjectDocument ──< DocumentVersion
    │         ▲
    │         │ (documentRefId, опционально)
    │
    ├──< Estimate ──< EstimateItem
    │
    ├──< ScheduleTask (WBS)
    │
    ├──< Work (= сегодняшний UnifiedControlRecord: объект→зона→этаж→ось→вид работ)
    │        │
    │        ├──< Inspection (проверка конкретной работы/точки контроля)
    │        │        └──< Defect (дефект может быть создан по итогам инспекции)
    │        │
    │        └──< Aosr (акт освидетельствования скрытых работ по конкретной работе)
    │                 └──< AosrSignature (кто, когда, в каком статусе подписал — audit-grade)
    │
    ├──< ExecutiveDocItem (общий реестр ИД — шире, чем один АОСР: журналы, паспорта, схемы)
    │
    ├──< FinancialEntry (КС-2/КС-3, бюджет, факт — единая лента финансовых событий проекта)
    │
    ├──< ProjectRisk
    │
    ├──< AiAnalysis (снимок результата AI-анализа; отдельно от FinancialEntry — расчётная аналитика,
    │        не первичные финансовые данные, см. раздел "Financial vs AI" ниже)
    │
    └──< AuditLogEntry (уже реализовано — projectId привязка опциональна для системных событий)

Document (Project|Estimate|Inspection|Defect|Aosr) — полиморфная связь entityType+entityId,
единая точка "цифровой истории объекта" (раздел 13 задания).
```

## Сущности и их поля (только то, что реально нужно — не разрастаем сверх того, что есть в UI-типах)

### Organization (новая сущность — на backend отсутствовала)
```
id, name, inn, ogrn, type (CUSTOMER|GENERAL_CONTRACTOR|SUBCONTRACTOR|DESIGN_INSTITUTE|SUPERVISION|SUPPLIER),
sroNumber?, sroExpiryDate?, directorName, contactEmail, contactPhone, createdAt
```
(`activeContractsCount`, `qualityRatingScore` из фронтендового типа — это ПРОИЗВОДНЫЕ метрики,
должны считаться на лету из связанных проектов/дефектов, а не храниться как отдельные мутируемые
поля — иначе они рассинхронизируются с реальностью.)

### User (уже персистентно — расширяется, не пересоздаётся)
Уже есть в `users`: `id, name, fullName, email, phone, role, organizationId, organizationName,
projectIds, allowedProjectIds, passwordHash, isActive`. Дополнить `organizationId` реальной ссылкой
на `Organization.id` (уже фактически так и есть по значению, просто не было таблицы Organization,
на которую можно сослаться).

### ProjectMember (новая — заменяет implicit `allowedProjectIds`)
```
id, projectId, userId, roleInProject (может отличаться от глобальной user.role — например,
инженер ОВиК на одном объекте и технадзор на другом), addedAt, addedBy
```
**Важно:** `user.allowedProjectIds` НЕ удаляется — остаётся производной, вычисляемой из
`ProjectMember` (для обратной совместимости API-контракта, раздел 12 задания). Источник истины
переносится в `ProjectMember`.

### Project (расширяется до фронтендового контракта — он богаче backend-версии)
```
id, organizationId (владелец/инициатор — опционально, для будущего разделения по орг.),
customerOrgId, generalContractorOrgId, name, code, address, status,
startDate, plannedFinishDate, forecastFinishDate,
budgetContractRub, budgetEstimateRub, executedRub, acceptedRub, paidRub,
physicalProgressPercent, financialProgressPercent, docCompletenessPercent,
floorsCount, sectionsCount, axesDefinition (JSON-массив строк),
chiefEngineerName, projectManagerName, createdAt, updatedAt
```
Существующий `projectDataStore[id].documents/defects/holdPoints/aosr` — это была временная
денормализация; после Phase 9 документы/дефекты/АОСР становятся собственными таблицами со
`projectId`, а не вложенными массивами внутри Project.

### Estimate + EstimateItem
```
Estimate: id, projectId, documentId?, title, status, createdAt, updatedAt
EstimateItem: id, estimateId, projectId, itemNumber, name, category (EQUIPMENT|MATERIAL|WORK),
  unit, plannedQty, estimateQty, actualFactQty, acceptedQty, unitPriceRub, totalPriceRub,
  contractorOrgId, status (DataStatus), conflictReason?, coveragePercent, riskScore
```
Разделение `estimates`/`estimate_items` — по прямому требованию раздела 6 задания (не хранить
единым JSON-блобом ради аналитики "план/факт").

### ScheduleTask (WBS)
```
id, projectId, wbsCode, title, section, startDate, finishDate, forecastFinishDate, durationDays,
plannedVolume, actualVolume, unit, progressPercent, spi, isCriticalPath,
predecessorIds (JSON-массив id), assignedContractorId, responsiblePerson, status,
holdPointRequired, holdPointPassed, lastInspectionDate?
```

### Work (= сегодняшний UnifiedControlRecord, переименование не требуется — модель уже подходит)
Таблица `unified_control` уже существует и реально соответствует требованиям раздела 8 задания
(project, work type, contractor, responsible, quantity, hold/witness point, привязка к АОСР).
**Решение: не создавать новую сущность "Work" — использовать существующую `UnifiedControlRecord`
как каноническую сущность "работы".** Единственное дополнение — реальная связь с `scheduleTaskId`
и `estimateItemId` (сейчас есть только `documentRefId`), чтобы будущий план/факт-анализ (раздел 8)
имел на что опереться.

### Inspection
```
id, projectId, workId (→ unified_control.id), taskId?, inspectorId (userId — из сессии, не из
тела запроса), inspectionDate, inspectionType, pointType (STANDARD|WITNESS_POINT|HOLD_POINT),
result (PASSED|FAILED|REWORK_REQUIRED|UNDER_REVIEW), findings, regulatoryBasis, designDocReference,
isHoldPointSatisfied, photoIds (JSON-массив), defectsGeneratedIds (JSON-массив), createdAt
```

### Defect
```
id, projectId, workId?, inspectionId?, defectNumber, title, description, category, severity,
sourceType, contractorOrgId, responsiblePersonUserId?, issuedByUserId (из сессии),
issuedDate, deadlineDate, closedDate?, status, reinspectionCount, beforePhotoUrls, afterPhotoUrls,
auditTrail (JSON — история статусов, append-only)
```

### Aosr (новая персистентная сущность — раздел 11 задания, устраняет CRITICAL GAP из 9A)
```
id, projectId, workId (→ unified_control.id), documentId? (сгенерированный PDF акта),
status (DRAFT|SIGNED_BY_CONTRACTOR|SIGNED_BY_TECH_SUPERVISOR|FULLY_APPROVED|REJECTED),
createdAt, updatedAt
```
### AosrSignature (append-only лог подписаний — audit-grade, отдельно от статуса)
```
id, aosrId, signedByUserId (из сессии — НИКОГДА из тела запроса), signedByRole (из сессии),
stage (какой переход состояния это подписание представляет), signedAt, hashCertificate
```
**Критично:** переход `status` АОСР проверяется ТОЛЬКО по реальной сохранённой записи `Aosr.status`
на сервере — `currentStage` от клиента полностью перестаёт использоваться для принятия решений
(сейчас — единственный источник, что и есть CRITICAL GAP). Роль/личность — из сессии (уже сделано
в Phase 8, сохраняется без изменений).

### ExecutiveDocItem
```
id, projectId, workId, docType, docNumber, title, requiredCount, uploadedCount, approvedCount,
status, documentId? (→ projectDocument, если файл загружен), signedByContractor, signedBySupervisor,
signedByCustomer, signingDate?, expiryDate?
```

### FinancialEntry (раздел 12 задания — единая лента, не разрозненные поля)
```
id, projectId, entryType (BUDGET|ESTIMATE_COST|ACTUAL_COST|KS2|KS3|PAYMENT),
amountRub, currency (по умолчанию RUB), relatedEstimateItemId?, relatedWorkId?,
periodStart?, periodEnd?, status, createdBy (userId из сессии), createdAt
```
`Project.budgetContractRub/executedRub/acceptedRub/paidRub` становятся ПРОИЗВОДНЫМИ (агрегатами
`FinancialEntry`), а не отдельно мутируемыми полями — иначе те же риски рассинхронизации, что и
у `Organization.qualityRatingScore`. Рентабельность/маржа/risk-score — это `AiAnalysis`
(расчётная аналитика), не первичные `FinancialEntry`.

### AiAnalysis (снимок; расширяет уже существующий `ProjectAnalysisJob`)
Уже спроектирован в `types/index.ts` (`ProjectAnalysisJob`, 40+ полей). Персистентность — просто
сохранять готовый job целиком как JSON-снимок (`ai_analyses` таблица, ключ `analysisId`), НЕ
дробить на колонки — это производные AI-результаты, а не первичные данные, дробить их так же
неоправданно, как раздел 12 просит не дробить AI-аналитику как первичный финансовый источник.

## Financial vs AI (раздел 12 задания — разделение обязательно)

```
FinancialEntry           — ПЕРВИЧНЫЕ данные: КС-2/КС-3, платежи, бюджет. Источник — люди (ПТО,
                            финансист), НЕ AI.
AiAnalysis.financialModel/profitability — РАСЧЁТНАЯ аналитика поверх дата-сета проекта (смета,
                            риски). AI НЕ является источником данных о фактическом бюджете/оплатах —
                            он их не видит и не может их создавать; читает `FinancialEntry` (когда
                            появится) как один из входов, но не заменяет его.
```

## Tenant / Authorization chain (раздел 4 задания)

```
session (activeSessions/sessions table, TTL 24ч)
  → user (полностью из БД, resolveAuthenticatedUser())
    → organizationId (User.organizationId → Organization.id)
      → project membership (ProjectMember: userId+projectId, ЛИБО user.role ∈ {ADMIN,SUPER_ADMIN}
        для кросс-проектного доступа — уже так реализовано в requireProjectAccess())
        → resource (Project/Estimate/Work/Inspection/Defect/Aosr/FinancialEntry — все имеют projectId)
          → action (requireRole() на конкретный набор ролей для мутирующих операций)
```
Ничего из `x-user-id`/`x-tenant-id`/`x-organization-id`/тела запроса не используется как источник
authority — это уже гарантировано централизованными `requireAuth`/`requireRole`/`requireProjectAccess`
(Phase 7/8) и остаётся неизменным принципом для всех новых сущностей этой фазы.

## Что сознательно НЕ вводится в этой фазе (раздел 28 задания — не переусложнять)

- Полноценная многоорганизационная модель прав (Organization пока используется для отображения и
  будущей агрегации метрик — не как отдельный уровень RBAC поверх Project; `requireProjectAccess`
  остаётся основным механизмом изоляции, как и было).
- `ProjectSettings` как отдельная сущность — не найдено ни одного реального использования в
  текущем UI, вводить нечего (раздел "не предполагай" из задания — предположение было бы
  спекуляцией без опоры на код).
- Отдельная сущность "Task", отличная от `ScheduleTask` — в коде такого разделения нет.
- `Notification`/`ContractorPerformance` как персистентные сущности с собственным API в этой фазе —
  они не участвуют ни в одном из проверочных сценариев раздела 19-22 задания (restart test, tenant
  test, E2E) и не блокируют реальный пилот на объекте АЭРОН; переносятся в P2 (см. итоговый отчёт).
  Их таблицы всё же будут добавлены в схему (раздел 9C) для полноты, но без API/UI-миграции в этой
  фазе — только Estimate/Schedule/Work/Inspection/Defect/AOSR/Financial/AI, как явно
  приоритизировано разделом 29 (PHASE 9E–9K).

**Следующий шаг: Phase 9C — Database Schema**, поверх уже существующей `src/server/database.ts`
(не создаём вторую независимую БД — расширяем текущую SQLite).

// Real E2E tests for the Phase 9 business-domain entities (estimates,
// schedule, inspections, defects, AOSR, financial). Every check is a genuine
// HTTP request against a running server — no mocks. Creates its own fresh
// data each run (idempotent, doesn't depend on IDs from a prior manual run).
//
// Run: npm run test:e2e   (server must already be running)
import { test, api, loginAs, assertEqual, assertTrue, runAll, SEED_PASSWORD } from '../security/helpers';

const ADMIN_EMAIL = 'admin@kit-sk.ru';
const TECH_SUP_EMAIL = 'tech@kit-sk.ru';       // projects [proj-1, proj-aeron] — NOT proj-2
const CONTRACTOR_EMAIL = 'genpodryad@kit-sk.ru';
const CUSTOMER_EMAIL = 'zakazchik@kit-sk.ru';
const PTO_EMAIL = 'pto@kit-sk.ru';             // projects [proj-1, proj-2, proj-aeron]

async function post(path: string, token: string, body: any) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  }).then(r => r.json().then(data => ({ status: r.status, data })));
}
async function get(path: string, token: string) {
  return api(path, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json().then(data => ({ status: r.status, data })));
}
async function put(path: string, token: string, body: any) {
  return api(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  }).then(r => r.json().then(data => ({ status: r.status, data })));
}
async function patch(path: string, token: string, body: any) {
  return api(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  }).then(r => r.json().then(data => ({ status: r.status, data })));
}

test('estimate: create then re-read shows the same entity', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/estimates', token, { title: `E2E estimate ${Date.now()}` });
  assertEqual(created.status, 201, 'Создание сметы должно вернуть 201');
  const list = await get('/api/projects/proj-1/estimates', token);
  assertTrue(list.data.estimates.some((e: any) => e.id === created.data.estimate.id), 'Созданная смета должна появиться в списке');
});

test('estimate item: create, update actualFactQty, re-read reflects the update (frontend write path)', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const estimate = await post('/api/projects/proj-1/estimates', token, { title: `E2E estimate for items ${Date.now()}` });
  const item = await post('/api/projects/proj-1/estimate-items', token, {
    estimateId: estimate.data.estimate.id, name: 'E2E item', unit: 'шт', plannedQty: 10, estimateQty: 10, unitPriceRub: 100
  });
  assertEqual(item.status, 201, 'Создание позиции сметы должно вернуть 201');

  const updated = await put(`/api/projects/proj-1/estimate-items/${item.data.item.id}`, token, { actualFactQty: 12, status: 'CONFLICT' });
  assertEqual(updated.data.item.actualFactQty, 12, 'Обновлённое значение должно вернуться в ответе');

  const reread = await get('/api/projects/proj-1/estimate-items', token);
  const found = reread.data.items.find((i: any) => i.id === item.data.item.id);
  assertEqual(found.actualFactQty, 12, 'Повторное чтение должно показывать обновлённое значение (не кэш)');
  assertEqual(found.status, 'CONFLICT', 'Статус тоже должен персистентно обновиться');
});

test('estimate item: PUT respects tenant isolation (same check the frontend relies on)', async () => {
  const { token } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD); // no proj-2 access
  const res = await put('/api/projects/proj-2/estimate-items/est-item-1', token, { actualFactQty: 1 });
  assertEqual(res.status, 403, 'Изменение сметной позиции чужого проекта должно быть запрещено');
});

test('estimate item: projectId in request body cannot override the URL-derived tenant check', async () => {
  const { token } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD); // no proj-2 access
  const res = await put('/api/projects/proj-2/estimate-items/est-item-1', token, { actualFactQty: 999, projectId: 'proj-aeron' });
  assertEqual(res.status, 403, 'Авторизация должна определяться URL, а не полем projectId в теле запроса');
});

test('estimate item: x-user-id header cannot spoof identity over a valid token', async () => {
  const { token, userId } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD);
  const res = await api('/api/auth/me', { headers: { Authorization: `Bearer ${token}`, 'x-user-id': 'usr-admin' } });
  const data = await res.json();
  assertEqual(data.user.id, userId, 'Личность должна определяться токеном, заголовок x-user-id должен игнорироваться');
});

test('estimate item: resolving a CONFLICT clears the stale conflictReason', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const estimate = await post('/api/projects/proj-1/estimates', token, { title: `E2E conflict-clear ${Date.now()}` });
  const item = await post('/api/projects/proj-1/estimate-items', token, {
    estimateId: estimate.data.estimate.id, name: 'E2E conflict-clear item', unit: 'шт', plannedQty: 10, estimateQty: 10, unitPriceRub: 100
  });
  const conflicted = await put(`/api/projects/proj-1/estimate-items/${item.data.item.id}`, token, {
    actualFactQty: 12, status: 'CONFLICT', conflictReason: 'факт превышает план'
  });
  assertEqual(conflicted.data.item.conflictReason, 'факт превышает план', 'conflictReason должен сохраниться при создании конфликта');

  const resolved = await put(`/api/projects/proj-1/estimate-items/${item.data.item.id}`, token, {
    actualFactQty: 10, status: 'DOCUMENT CONFIRMED', conflictReason: null
  });
  assertEqual(resolved.data.item.conflictReason, null, 'conflictReason должен очищаться (не зависать) после исправления конфликта');
});

test('schedule task: create then re-read', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/schedule', token, { wbsCode: `E2E-${Date.now()}`, title: 'E2E task', unit: 'м.п.' });
  assertEqual(created.status, 201, 'Создание задачи графика должно вернуть 201');
  const list = await get('/api/projects/proj-1/schedule', token);
  assertTrue(list.data.tasks.some((t: any) => t.id === created.data.task.id), 'Созданная задача должна появиться в списке');
});

test('inspection: create, inspector identity comes from session', async () => {
  const { token, userId } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/inspections', token, { inspectionType: 'HIDDEN_WORK', result: 'PASSED', findings: 'E2E test' });
  assertEqual(created.status, 201, 'Создание инспекции должно вернуть 201');
  assertEqual(created.data.inspection.inspectorId, userId, 'Инспектор должен браться из сессии');
});

test('inspection: resolve hold point (PATCH), re-read reflects the update', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/inspections', token, {
    inspectionType: 'HOLD_POINT', pointType: 'HOLD_POINT', result: 'FAILED', isHoldPointSatisfied: false, findings: 'E2E hold point test'
  });
  const resolved = await patch(`/api/projects/proj-1/inspections/${created.data.inspection.id}`, token, { result: 'PASSED', isHoldPointSatisfied: true });
  assertEqual(resolved.data.inspection.result, 'PASSED', 'PATCH должен вернуть обновлённый результат');

  const reread = await get('/api/projects/proj-1/inspections', token);
  const found = reread.data.inspections.find((i: any) => i.id === created.data.inspection.id);
  assertEqual(found.isHoldPointSatisfied, true, 'Повторное чтение должно показывать обновлённое значение (не кэш)');
});

test('inspection: PATCH respects tenant isolation', async () => {
  const { token } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD); // no proj-2 access
  const res = await patch('/api/projects/proj-2/inspections/insp-01', token, { result: 'PASSED' });
  assertEqual(res.status, 403, 'Изменение инспекции чужого проекта должно быть запрещено');
});

test('schedule task: PUT respects tenant isolation', async () => {
  const { token } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD); // no proj-2 access
  const res = await put('/api/projects/proj-2/schedule/task-01', token, { status: 'COMPLETED' });
  assertEqual(res.status, 403, 'Изменение задачи графика чужого проекта должно быть запрещено');
});

test('defect: create, sequential defectNumber assigned', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/defects', token, { title: 'E2E defect', severity: 'HIGH' });
  assertEqual(created.status, 201, 'Создание дефекта должно вернуть 201');
  assertTrue(/^ЗАМ-\d{4}-\d{4}$/.test(created.data.defect.defectNumber), 'Номер дефекта должен быть в формате ЗАМ-YYYY-NNNN');
});

test('defect: status transition to CLOSED logs as DEFECT_RESOLVED-capable action', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/defects', token, { title: 'E2E defect to close', severity: 'LOW' });
  const closed = await api(`/api/projects/proj-1/defects/${created.data.defect.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'CLOSED', comment: 'E2E resolved' })
  }).then(r => r.json());
  assertEqual(closed.defect.status, 'CLOSED', 'Статус дефекта должен смениться на CLOSED');
  assertTrue(!!closed.defect.closedDate, 'closedDate должен быть проставлен');
});

test('defect: CONTRACTOR can submit READY_FOR_REVIEW but not CLOSE (mirrors frontend can() RBAC)', async () => {
  const { token: adminToken } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/defects', adminToken, { title: 'E2E RBAC defect', severity: 'MEDIUM' });
  const { token: contractorToken } = await loginAs(CONTRACTOR_EMAIL, SEED_PASSWORD);

  const review = await patch(`/api/projects/proj-1/defects/${created.data.defect.id}/status`, contractorToken, { status: 'READY_FOR_REVIEW' });
  assertEqual(review.status, 200, 'CONTRACTOR должен уметь отправить дефект на проверку');

  const close = await patch(`/api/projects/proj-1/defects/${created.data.defect.id}/status`, contractorToken, { status: 'CLOSED' });
  assertEqual(close.status, 403, 'CONTRACTOR не должен иметь права закрывать дефект сам');
});

test('defect: PATCH status respects tenant isolation', async () => {
  const { token } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD); // no proj-2 access
  const res = await patch('/api/projects/proj-2/defects/def-1/status', token, { status: 'CLOSED' });
  assertEqual(res.status, 403, 'Изменение статуса дефекта чужого проекта должно быть запрещено');
});

test('financial: entry created, summary aggregates it', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const before = await get('/api/projects/proj-1/financial', token);
  const created = await post('/api/projects/proj-1/financial', token, { entryType: 'BUDGET', amountRub: 1000000 });
  assertEqual(created.status, 201, 'Создание финансовой записи должно вернуть 201');
  const after = await get('/api/projects/proj-1/financial', token);
  assertEqual(after.data.summary.budgetContractRub, before.data.summary.budgetContractRub + 1000000, 'Сумма бюджета должна вырасти ровно на добавленную запись');
});

test('financial: CONTRACTOR cannot even read financial data (role restriction)', async () => {
  const { token } = await loginAs(CONTRACTOR_EMAIL, SEED_PASSWORD);
  const res = await get('/api/projects/proj-1/financial', token);
  assertEqual(res.status, 403, 'CONTRACTOR не должен иметь доступ к финансовым данным проекта');
});

test('tenant isolation: user without proj-2 access is denied on every new entity', async () => {
  const { token } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD);
  for (const path of ['/api/projects/proj-2/estimates', '/api/projects/proj-2/schedule', '/api/projects/proj-2/inspections', '/api/projects/proj-2/defects', '/api/projects/proj-2/aosr']) {
    const res = await get(path, token);
    assertEqual(res.status, 403, `${path} должен быть запрещён для пользователя без доступа к proj-2`);
  }
});

test('aosr: real server-enforced state machine — CUSTOMER cannot skip stages even by lying about currentStage', async () => {
  const { token: adminToken } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/aosr', adminToken, { workName: `E2E AOSR ${Date.now()}` });
  assertEqual(created.status, 201, 'Создание АОСР должно вернуть 201');
  const aosrId = created.data.aosr.id;

  const { token: customerToken } = await loginAs(CUSTOMER_EMAIL, SEED_PASSWORD);
  // Client lies about currentStage — server must ignore it and check the real stored status (DRAFT).
  const forged = await post(`/api/aosr/${aosrId}/sign`, customerToken, { currentStage: 'SIGNED_BY_TECH_SUPERVISOR' });
  assertEqual(forged.data.success, false, 'CUSTOMER не должен суметь утвердить АОСР в реальном статусе DRAFT, независимо от того, что заявляет клиент');
});

test('aosr: real sequential signing succeeds in the correct order', async () => {
  const { token: adminToken } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/aosr', adminToken, { workName: `E2E AOSR sequence ${Date.now()}` });
  const aosrId = created.data.aosr.id;

  const { token: contractorToken } = await loginAs(CONTRACTOR_EMAIL, SEED_PASSWORD);
  const step1 = await post(`/api/aosr/${aosrId}/sign`, contractorToken, {});
  assertEqual(step1.data.status, 'SIGNED_BY_CONTRACTOR', 'После подписи подрядчика статус должен смениться');

  const { token: customerToken } = await loginAs(CUSTOMER_EMAIL, SEED_PASSWORD);
  const skip = await post(`/api/aosr/${aosrId}/sign`, customerToken, {});
  assertEqual(skip.data.success, false, 'Заказчик всё ещё не может подписать до технадзора, даже после подрядчика');
});

test('aosr: full 3-stage chain (CONTRACTOR -> CONSTRUCTION_CONTROL -> CUSTOMER) reaches FULLY_APPROVED', async () => {
  // Regression test for a real bug found during Phase 9L.2 AOSR verification:
  // the middle stage was keyed on a role string ('TECH_SUPERVISOR') that
  // doesn't exist in the UserRole enum, so no real user could ever sign it.
  const { token: adminToken } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/aosr', adminToken, { workName: `E2E AOSR full chain ${Date.now()}` });
  const aosrId = created.data.aosr.id;

  const { token: contractorToken } = await loginAs(CONTRACTOR_EMAIL, SEED_PASSWORD);
  const step1 = await post(`/api/aosr/${aosrId}/sign`, contractorToken, {});
  assertEqual(step1.data.status, 'SIGNED_BY_CONTRACTOR', 'Шаг 1: подрядчик подписывает');

  const { token: techSupToken } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD);
  const step2 = await post(`/api/aosr/${aosrId}/sign`, techSupToken, {});
  assertEqual(step2.data.success, true, 'Шаг 2: реальный пользователь с ролью CONSTRUCTION_CONTROL должен суметь подписать');
  assertEqual(step2.data.status, 'SIGNED_BY_TECH_SUPERVISOR', 'После подписи технадзора статус должен смениться');

  const { token: customerToken } = await loginAs(CUSTOMER_EMAIL, SEED_PASSWORD);
  const step3 = await post(`/api/aosr/${aosrId}/sign`, customerToken, {});
  assertEqual(step3.data.status, 'FULLY_APPROVED', 'Шаг 3: заказчик утверждает после технадзора');
});

test('ks document: create then re-read shows the same entity', async () => {
  const { token } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/ks-documents', token, {
    docType: 'KS2', docNumber: `E2E-KS-${Date.now()}`, periodStart: '2026-01-01', periodEnd: '2026-01-31',
    contractorOrgId: 'org-sub-ovik', contractorOrgName: 'E2E Test Contractor',
    items: [{ workName: 'E2E item', unit: 'шт', quantityExecuted: 10, unitPriceRub: 1000, aoSrConfirmed: true }]
  });
  assertEqual(created.status, 201, 'Создание документа КС должно вернуть 201');
  assertEqual(created.data.document.status, 'DRAFT', 'Новый документ должен быть в статусе DRAFT');
  assertEqual(created.data.document.totalSumWithoutVatRub, 10000, 'Сумма должна считаться из позиций (10 * 1000)');
  const list = await get('/api/projects/proj-1/ks-documents', token);
  assertTrue(list.data.documents.some((d: any) => d.id === created.data.document.id), 'Созданный документ должен появиться в списке');
});

test('ks document: full approval chain (PTO_ENGINEER -> CONSTRUCTION_CONTROL -> CUSTOMER) reaches SIGNED_CUSTOMER', async () => {
  const { token: adminToken } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/ks-documents', adminToken, {
    docType: 'KS2', docNumber: `E2E-KS-CHAIN-${Date.now()}`, periodStart: '2026-01-01', periodEnd: '2026-01-31',
    contractorOrgId: 'org-sub-ovik', contractorOrgName: 'E2E Test Contractor', items: []
  });
  const docId = created.data.document.id;

  const { token: ptoToken } = await loginAs(PTO_EMAIL, SEED_PASSWORD);
  const step1 = await post(`/api/projects/proj-1/ks-documents/${docId}/advance`, ptoToken, {});
  assertEqual(step1.data.success, true, 'Шаг 1: ПТО должен суметь верифицировать документ');
  assertEqual(step1.data.document.status, 'VERIFIED_PTO', 'После верификации ПТО статус должен смениться');

  const skip = await post(`/api/projects/proj-1/ks-documents/${docId}/advance`, ptoToken, {});
  assertEqual(skip.data.success, false, 'Повторная попытка тем же ПТО не должна пройти (документ уже не в DRAFT)');

  const { token: techToken } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD);
  const step2 = await post(`/api/projects/proj-1/ks-documents/${docId}/advance`, techToken, {});
  assertEqual(step2.data.document.status, 'APPROVED_SUPERVISOR', 'Шаг 2: технадзор согласовывает после ПТО');

  const { token: customerToken } = await loginAs(CUSTOMER_EMAIL, SEED_PASSWORD);
  const step3 = await post(`/api/projects/proj-1/ks-documents/${docId}/advance`, customerToken, {});
  assertEqual(step3.data.document.status, 'SIGNED_CUSTOMER', 'Шаг 3: заказчик подписывает после технадзора');
});

test('ks document: advance respects tenant isolation', async () => {
  const { token } = await loginAs(TECH_SUP_EMAIL, SEED_PASSWORD); // no proj-2 access
  const res = await post('/api/projects/proj-2/ks-documents/ks-99/advance', token, {});
  assertEqual(res.status, 403, 'Согласование документа КС чужого проекта должно быть запрещено');
});

test('audit log: a real mutation produces a retrievable, correctly-enriched entry', async () => {
  const { token, userId } = await loginAs(ADMIN_EMAIL, SEED_PASSWORD);
  const created = await post('/api/projects/proj-1/estimates', token, { title: `E2E audit-log check ${Date.now()}` });
  assertEqual(created.status, 201, 'Создание сметы для проверки аудит-лога должно вернуть 201');

  const logs = await get('/api/audit/logs', token);
  const entry = logs.data.logs.find((l: any) => l.entityId === created.data.estimate.id);
  assertTrue(!!entry, 'Реальное действие должно появиться в журнале аудита');
  assertEqual(entry.userId, userId, 'Запись должна быть привязана к реальному пользователю сессии');
  assertEqual(entry.projectId, 'proj-1', 'Запись должна нести projectId созданной сущности');
  assertTrue(!!entry.userName && entry.userName !== entry.userId, 'userName должен быть реально разрешён (не просто id)');
});

runAll().then(code => process.exit(code));

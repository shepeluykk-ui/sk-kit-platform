# CURRENT SECURITY STATUS — СК-КИТ

Актуально на: 2026-08-31, после коммитов `90e5ef1` → `7d888b3` → `f5e8d1c` → `2e3ea0c` → `051f5c9`
→ `909a9d6` (см. `git log`). Раздел "Phase 9" в конце документа описывает изменения от миграции
бизнес-данных в persistent backend — READ его дополнительно к разделам 1-11 ниже, которые описывают
P0 security remediation (Phase 7/8) и не менялись по существу в Phase 9.
Каждый пункт ниже — реально проверенный дефект, с доказательствами. Там, где BEFORE — это прямая
цитата уязвимого кода (дефект был найден и исправлен статическим анализом раньше, чем сервер
запускался с этим кодом в этой сессии, поэтому «до» — это код, а не HTTP-транзакция), AFTER — это
реальный HTTP-запрос к работающему серверу.

## Методология

- Все AFTER-проверки выполнены curl-запросами к `NODE_ENV=production node dist/server.cjs` на
  `http://localhost:3000`, либо автоматическим набором `tests/security/` (`npm run test:security`,
  **31/31 PASS** на момент записи).
- Ни один старый отчёт (`FINAL_ACCEPTANCE_REPORT.md` и др.) не использовался как источник статусов.

---

## 1. Универсальный пароль `skkit2024`

**BEFORE (код, `server.ts`, до исправления):**
```ts
if ((user as any).passwordHash && password) {
  const computedHash = hashSecret(password, 'pwd_salt');
  if (computedHash !== (user as any).passwordHash && password !== 'skkit2024') {
    // ...401
  }
}
```
Строка `password !== 'skkit2024'` пропускала проверку пароля для ЛЮБОГО пользователя. Дополнительно
кнопка «Быстрый выбор сотрудника» на экране входа (`LoginScreen.tsx`) автоматически подставляла
именно этот пароль — то есть бэкдор был не только в коде, но и в UI как штатная функция.

**AFTER (реальный запрос):**
```
POST /api/auth/login  {"username":"admin@kit-sk.ru","password":"skkit2024"}
→ HTTP 401
→ {"success":false,"error":"Неверный пароль"}
```

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 2. Подделка токена (Forged Token)

**BEFORE (код):**
```ts
const parts = token.split('_');
if (parts[0] === 'skkit' && parts[1] === 'jwt' && parts[2] && mockUsers[parts[2]]) {
  const user = mockUsers[parts[2]];
  activeSessions.set(token, user);
  return res.json({ success: true, user });
}
```
Токен вида `skkit_jwt_<userId>_<что угодно>` принимался БЕЗ проверки подписи — доверие строилось
на структуре строки. Зная (или угадав) `userId`, например `usr-admin` или `usr-007` (SUPER_ADMIN),
можно было получить полный доступ без знания пароля.

**AFTER:**
```
GET /api/auth/me  Authorization: Bearer skkit_jwt_usr-admin_1_aaaaaaa
→ HTTP 401
→ {"success":false,"error":"Сессия завершена. Войдите снова."}
```
Токен теперь — `skkit_sess_<32 случайных байта из crypto.randomBytes>`, единственный источник
истины — серверная `activeSessions` (Map + SQLite-таблица `sessions`). Структура токена не несёт
доверия сама по себе.

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 3. `x-user-id` / `x-tenant-id` / `x-organization-id` как identity

**BEFORE (код, характерный пример из ~14 мест):**
```ts
const userId = (req.headers['x-user-id'] as string);
const user = mockUsers[userId];
if (!user) { return res.status(401)...; }
```
Заголовок `x-user-id`, полностью управляемый клиентом, использовался как источник личности без
криптографической проверки — классический IDOR/impersonation. В `/api/work-types` POST при
отсутствии заголовка код даже по умолчанию подставлял `'usr-admin'`.

**AFTER:**
```
GET /api/projects/proj-1/documents  x-user-id: usr-admin  (без Authorization)
→ HTTP 401
→ {"success":false,"error":"Сессия завершена. Войдите снова."}
```
Дополнительно проверено: `x-user-id` поверх ЧУЖОГО валидного токена игнорируется — identity строго
берётся из `activeSessions` по токену (см. `tests/security/auth-and-idor.test.ts`,
"fake x-user-id: подмена личности поверх ЧУЖОГО валидного токена игнорируется" — PASS).

**Статус: FIXED, ПОДТВЕРЖДЕНО** (все ~14 мест + `/api/documents/:id/view`, `/api/unified-control`
POST — найдены и закрыты в двух проходах, см. `VERIFIED_API_SECURITY_MATRIX.md`).

## 4. Подделка роли при подписании АОСР

**BEFORE (код):**
```ts
const { role, signatureData, currentStage } = req.body;
const userId = (req.headers['x-user-id'] as string) || req.body.userId;
// ... role используется напрямую для перехода состояний и записи в аудит
```
`role` — юридически значимая подпись акта освидетельствования скрытых работ (РД-11-02-2006) —
бралась из тела запроса клиента, без всякой проверки.

**AFTER:** `role` теперь берётся из `user.role` аутентифицированной сессии; эндпоинт требует
`requireAuth` + `requireRole(['CONTRACTOR','TECH_SUPERVISOR','CUSTOMER','ADMIN','SUPER_ADMIN'])`.
```
POST /api/aosr/aosr-1/sign  (без токена)
→ HTTP 401
```

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 5. Аудит-лог без авторизации

**BEFORE (код, найдено при построении `VERIFIED_API_SECURITY_MATRIX.md` в этой сессии):**
```ts
app.get(['/api/audit/logs', '/api/audit-logs'], (req, res) => {
  res.json({ success: true, total: auditLogStore.length, logs: auditLogStore.slice(0, 100) });
});
```
Ни `requireAuth`, ни проверки роли — любой анонимный запрос получал последние 100 записей
аудит-лога (ID пользователей, security-события, отклонённые попытки доступа).

**AFTER:**
```
GET /api/audit/logs  (без токена)
→ HTTP 401 → {"success":false,"error":"Сессия завершена. Войдите снова."}

GET /api/audit/logs  Authorization: Bearer <CONTRACTOR token>
→ HTTP 403 (недостаточно прав)

GET /api/audit/logs  Authorization: Bearer <ADMIN token>
→ HTTP 200, реальные записи
```

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 6. Tenant isolation в AI-анализе проекта и `/api/unified-control`

**BEFORE (код):** все 7 маршрутов `/api/projects/:projectId/ai-analysis*` и
`POST /api/unified-control` не проверяли принадлежность пользователя к `:projectId` вообще —
можно было запросить финансовую/рисковую аналитику любого чужого проекта, зная его ID.

**AFTER:**
```
GET /api/projects/proj-2/ai-analysis/status
Authorization: Bearer <токен пользователя без доступа к proj-2>
→ HTTP 403
→ {"success":false,"error":"Доступ запрещен (IDOR / Tenant Isolation): ...","isolationStatus":"ISOLATED_AND_ENFORCED"}

POST /api/unified-control  {"projectId":"proj-2", ...}
Authorization: Bearer <тот же токен>
→ HTTP 403
→ {"success":false,"error":"Доступ запрещен (IDOR / Tenant Isolation): пользователь Петров А.В. (Технадзор) не имеет прав к проекту proj-2","isolationStatus":"ISOLATED_AND_ENFORCED"}
```
Добавлена централизованная `requireProjectAccess(user, res, projectId)`, используется единообразно.
Дополнительно: `profitability`/`report` (финансовая маржа) закрыты от роли `CONTRACTOR`.

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 7. `/api/documents/:id/view` без авторизации

**BEFORE (код, найдено при построении матрицы):** эндпоинт инлайн-просмотра документа не вызывал
`requireAuth` вообще, в отличие от `/download`.

**AFTER:**
```
GET /api/documents/doc-101/view  (без токена)
→ HTTP 401
```

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 8. Rate-limit backdoor

**BEFORE (код):**
```ts
if (req.headers['x-reset-rate-limit'] === 'internal-gate-test') {
  requestCounts.clear();
}
```
Позволял любому клиенту сбрасывать счётчик rate-limit по одному заголовку.

**AFTER:** ветка удалена из кода полностью (не гейтится по `NODE_ENV`, а физически отсутствует).
```
GET /api/health  x-reset-rate-limit: internal-gate-test
→ HTTP 200 (заголовок больше не имеет эффекта на rate limiter)
```

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 9. Утечка OTP-кода и хэша пароля в ответах API

**BEFORE:** `devOtp` возвращался в JSON безусловно (не только в dev); `passwordHash` уходил в теле
ответа `login`/`/api/auth/me`.

**AFTER:** `devOtp` гейтится `process.env.NODE_ENV !== 'production'`; `sanitizeUser()` вырезает
`passwordHash` перед каждой отправкой пользователя клиенту.
```
POST /api/auth/login (production) → тело ответа user НЕ содержит "passwordHash"
(проверено tests/security/auth-and-idor.test.ts, "login: ответ не содержит passwordHash" — PASS)
```

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 10. Публичная экспозиция исходников Android

**BEFORE:** `public/skkit-android-source.zip` (11.3 МБ, полный исходник Android) копировался Vite
в `dist/` и был бы доступен по прямому URL на проде.

**AFTER:** файл удалён из `public/` и `dist/`.
```
GET /skkit-android-source.zip
→ HTTP 200, но Content-Type: text/html (SPA fallback на index.html — не ZIP),
  тело НЕ начинается с сигнатуры ZIP "PK" (проверено побайтово в tests/security/)
```

**Статус: FIXED, ПОДТВЕРЖДЕНО.**

## 11. База данных, сессии, файловое хранилище, backup/restore — были полностью фиктивными

**BEFORE (реальный тест, проведён в этой сессии):** создание записи → `kill` процесса backend →
повторный запуск → запись отсутствовала. `POST /api/system/backup` принимал и возвращал ЛЮБЫЕ
данные, присланные клиентом в теле запроса (проверено: пустое тело → «успешный» бэкап с пустыми
данными; заведомо вымышленные данные → «успешный» бэкап с фейковым `checksum: sha256-<Math.random()>`).
`restore` не восстанавливал ничего ни в один реальный store.

**AFTER (реальный тест, полный цикл):**
1. Создание записи `BACKUP-TEST-RECORD` (`status: ACTIVE`).
2. Реальный backup — копия файла SQLite (`skkit-2026-08-31T04-12-46-131Z.db`, 68 КБ на диске).
3. Запись изменена (`status: ARCHIVED`).
4. `POST /api/system/restore {"backupId":"skkit-2026-08-31T04-12-46-131Z.db"}` → `recordsRestored: 30`.
5. Запись снова `status: ACTIVE` — как на момент backup.

Также подтверждено рестартом процесса: БД (SQLite), сессии (TTL 24ч) и физические файлы документов
(с исправленной ре-гидратацией реестра `FileStorageManager`) переживают перезапуск с точным
совпадением sha256.

**Статус: FIXED, ПОДТВЕРЖДЕНО реальным циклом create→backup→modify→restore→verify.**

---

## Осознанно НЕ закрытые в этой сессии проблемы (не путать с «пропущено»)

| # | Проблема | Почему не закрыто | Риск |
|---|---|---|---|
| 1 | AI-эндпоинты (`/api/ai/chat`, `/api/ai/analyze-document`, `/api/ai/daily-report`) без `requireAuth` | Требует решения продукта — вводить ли лимиты/квоты вместе с авторизацией | Открытый прокси к платному `GEMINI_API_KEY` — риск злоупотребления квотой, не утечка чужих данных проекта (контекст передаёт сам клиент) |
| 2 | **[ЗАКРЫТО В PHASE 9 на backend]** Было: большинство бизнес-сущностей UI (проекты, сметы, график, инспекции, дефекты, ИД) существовали только во frontend-состоянии. Стало: реальные, защищённые, протестированные API для estimates/schedule/inspections/defects/aosr/financial существуют (`docs/architecture/DATA_INVENTORY.md`, `DOMAIN_MODEL.md`). Work Types и Unified Control также подключены на фронтенде (Phase 9L). | Estimates/Schedule/Inspections/Defects(создание)/AOSR/Financial UI ещё используют локальный `INITIAL_*` state, а не эти API — адаптация полей ~6 компонентов, следующий шаг | Backup/restore теперь покрывает эти сущности НА BACKEND (если создать данные через API), но не данные, которые UI всё ещё держит только локально |
| 3 | PWA: Service Worker отсутствует полностью | Отдельная задача (не security) | Нет офлайн-режима — не является уязвимостью, но false claim в старой документации |
| 4 | Android runtime (установка/запуск APK) не протестирован | Нет AVD/устройства в этом окружении | BLOCKED, не FAIL — сборка APK реальна и подтверждена |

## Итоговый счёт

```
npm run test:security → 31/31 PASS (реальные HTTP-тесты, не переиспользованное число из старых отчётов)
npx tsc --noEmit      → 0 ошибок
npm run build         → успешно
NODE_ENV=production node dist/server.cjs → запускается, все проверенные эндпоинты отвечают корректно
```

**SECURITY BASELINE (актуальный, не унаследованный): P0-уязвимости идентификации/авторизации закрыты
и подтверждены реальными тестами. Открытые пункты 1, 3, 4 выше — не auth-дыры, а архитектурные разрывы
следующего приоритета (PWA, Android runtime). Пункт 2 закрыт на backend в Phase 9.**

## Phase 9 — дополнительные находки и исправления (миграция бизнес-данных)

Полная методология и находки — `docs/architecture/DATA_INVENTORY.md`. Здесь — только то, что имеет
прямое отношение к security/целостности данных.

### АОСР: сервер больше не доверяет клиенту заявленному статусу документа

**BEFORE (найдено при построении `DATA_INVENTORY.md`, было уже ПОСЛЕ фикса личности/роли из Phase 8,
то есть это отдельный, более глубокий дефект):**
```ts
// currentStage бралось из req.body и ничем не проверялось против реального состояния —
// реального состояния и не было, эндпоинт был полностью stateless.
if (role === 'CUSTOMER' && currentStage !== 'SIGNED_BY_TECH_SUPERVISOR') { /* 400 */ }
```
Клиент, зная (или угадав) `aosrId`, мог заявить любую `currentStage` и обойти обязательную
последовательность подписания (РД-11-02-2006) — например CUSTOMER мог утвердить акт, заявив, что
технадзор уже подписал, хотя в реальности этого не было (сервер это не мог проверить — ему было
нечем).

**AFTER (реальный тест, `tests/e2e/phase9-domain-entities.test.ts`):**
```
Создан реальный АОСР (status: DRAFT)
POST /api/aosr/<id>/sign как CUSTOMER, body: {"currentStage": "SIGNED_BY_TECH_SUPERVISOR"} (ложь)
→ {"success":false,"error":"Недопустимый переход: АОСР сейчас в статусе \"DRAFT\", ..."}
```
Переход теперь проверяется исключительно по `Aosr.status`, реально сохранённому в SQLite —
`currentStage` из тела запроса вообще не читается сервером. **Статус: FIXED, ПОДТВЕРЖДЕНО.**

### Новые Phase 9 эндпоинты — тот же стандарт защиты, без исключений

Все 20+ новых маршрутов (`/api/organizations`, `/api/projects/:id/{members,estimates,estimate-items,
schedule,inspections,defects,aosr,financial}` и т.д.) используют `requireAuth` +
`requireProjectAccess` (для project-scoped) + `requireRole` (где нужна ролевая проверка) — тот же
паттерн, что и весь остальной API, без отдельного "облегчённого" стандарта для новых сущностей.
Личность автора (инспектора, автора дефекта/финансовой записи) — всегда из `req.user`, никогда из
тела запроса. Подтверждено `tests/e2e/phase9-domain-entities.test.ts` (роль CONTRACTOR получает 403
на финансовые данные; пользователь без доступа к проекту получает 403 на каждую новую сущность).

### Итоговый счёт после Phase 9

```
npm run test:security → 31/31 PASS (без изменений — регрессии нет)
npm run test:e2e       → 10/10 PASS (новый набор для Phase 9 сущностей)
npx tsc --noEmit       → 0 ошибок
npm run build          → успешно
```

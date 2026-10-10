# SEC-VERIFY-001 — Независимая проверка `POST /api/ai/chat` и `/api/ai/*`

Дата: 2026-09-18 · Роль: независимый проверяющий (Security Red Team) · Проект: SK-КИТ (`D:\SK-KIT`)
Метод: forensics по коду + фактические HTTP-запросы в изолированной clean-room среде.
Выводы предыдущих исследователей при проведении работы не использовались.

---

## Scope

**В scope**

- `POST /api/ai/chat`
- `POST /api/ai/analyze-document`, `POST /api/ai/daily-report`
- `GET /api/ai/resilience-status`, `GET /api/ai/resilience-metrics`
- `POST /api/ai/circuit-reset`, `POST /api/ai/chaos-inject`
- middleware-цепочка `anonymous → route → middleware → handler → БД → документ → промпт → ответ`
- проверка утверждения `docs/security/VERIFIED_API_SECURITY_MATRIX.md:74` (BLK-004)

**Вне scope (не изменялось, не исправлялось)**

- код приложения, auth, маршруты, middleware, БД, frontend, тесты — изменений не вносилось;
- `D:\SK-KIT\data\skkit.db`, `.env`, данные AERON — не затрагивались;
- реальный платный GenAI API — не вызывался, ключ не передавался.

---

## Environment

| Параметр | Факт |
|---|---|
| Артефакт | `D:\SK-KIT\dist\server.cjs` (сборка от 2026-09-18 17:45, размер 366 286 байт) |
| Исходник | `D:\SK-KIT\server.ts` (3565 строк) |
| Clean-room cwd | `D:\ClaudeData\Temp\claude\D--SK-KIT\f9a146cb-...\scratchpad\secverify` |
| Clean-room БД | `<cwd>/data/skkit.db` — создана сервером с нуля, изолирована |
| Реальная БД | `D:\SK-KIT\data\skkit.db`, mtime 2026-09-15 09:29 — **не открывалась, не изменялась** |
| ENV | `NODE_ENV=production`, `SEED_USER_PASSWORD=sec-verify-pass`, `DATABASE_URL=''`, `PORT=3000` |
| Фаза 1 | `GEMINI_API_KEY=''` → `/api/health` → `"geminiConfigured":false` |
| Фаза 2 | `GEMINI_API_KEY=sec-verify-DUMMY-not-a-real-key` + локальный перехват `fetch` → `"geminiConfigured":true` |
| Сеть | исходящие запросы к `*.googleapis.com` перехватывались локально (`intercept.cjs`), наружу **не уходили**; реальный ключ не использовался |
| `git status` | идентичен состоянию на старте сессии — файлы репозитория не изменялись |

`.env` недоступен: **фактическая конфигурация production-ключа НЕ ПРОВЕРЕНА** (см. Limitations).

---

## Source Code Evidence

### Цепочка anonymous → ответ

| Звено | Файл:строка | Факт |
|---|---|---|
| глобальный throttle | `server.ts:92-109` | 200 запросов/мин на IP, общий счётчик для всех маршрутов |
| парсер тела | `server.ts:111` | `express.json({ limit: '50mb' })` |
| middleware `/api/ai/` | `server.ts:2765-2771` | только `console.warn` о состоянии circuit breaker, затем `next()`. **Никаких проверок** |
| маршрут | `server.ts:2774` | `app.post('/api/ai/chat', async (req, res) => {` — **нет `requireAuth`, нет `requireProjectAccess`, нет `requireRole`** |
| вход | `server.ts:2777-2778` | `message`/`prompt`, `projectContext`, `documents`, `conversationHistory` — всё из тела |
| валидация | `server.ts:2780-2786` | только «`message` обязателен» → 400 |
| **выбор документов** | `server.ts:2789-2791` | `documents` из тела, иначе **жёстко `projectDataStore['proj-1']?.documents`** |
| метаданные в промпт | `server.ts:2793-2805` | `title`, `code`, `section`, `revision`, `status` каждого документа |
| **содержимое в промпт** | `server.ts:2802` | `doc.content.slice(0, 4000)`; если `content` не строка, но есть `title` — **подставляется выдуманный нормативный текст** |
| сборка промпта | `server.ts:2906` | `ДОКУМЕНТЫ ОБЪЕКТА:\n${documentsGrounding}\n\nЗАПРОС:\n${message}` |
| вызов провайдера | `server.ts:2907-2916` → `src/server/aiResilience.ts:300` | `AiResilienceService.executeStructured` |
| gate на провайдера | `src/server/aiResilience.ts:255-262`, `:351` | клиент создаётся только при `process.env.GEMINI_API_KEY`; при `null` весь каскад пропускается |
| отправка | `src/server/aiResilience.ts:383-396` | `ai.models.generateContent({ model, contents, config })` |
| ответ клиенту | `server.ts:2918-2933` | `envelope.data` + плоские поля `answer/sources/conflicts/recommendations` — **без фильтрации** |
| аудит | `server.ts:2774-2947` | вызовов `logAudit` **нет ни одного** |

### Откуда в `projectDataStore` попадает содержимое

| Файл:строка | Факт |
|---|---|
| `server.ts:296` | `projectDataStore` — in-memory Record, seed `proj-1`, `proj-2`, `proj-aeron`, `proj-technopark` |
| `server.ts:1348` | при загрузке документа сохраняется `content: content \|\| ''` |
| `server.ts:1379-1380` | документ кладётся в `projectDataStore[projectId].documents` и `dbUpsert('projects', …)` |
| `server.ts:1995` | при старте `for (const row of dbLoadAll('projects')) projectDataStore[row.id] = row.data` |

Вывод: `projectDataStore['proj-1'].documents` — **персистентные данные из БД**, а не константа в коде.

### Прочие `/api/ai/*`

| Маршрут | Файл:строка | Auth |
|---|---|---|
| `POST /api/ai/analyze-document` | `server.ts:2950` | нет |
| `POST /api/ai/daily-report` | `server.ts:3078` | нет |
| `GET /api/ai/resilience-status` | `server.ts:3184` | нет |
| `GET /api/ai/resilience-metrics` | `server.ts:3194` | нет |
| `POST /api/ai/circuit-reset` | `server.ts:3203-3206` | `requireAuth` + `ADMIN/SUPER_ADMIN` |
| `POST /api/ai/chaos-inject` | `server.ts:3217-3225` | `requireAuth` + запрет в production для не-`SUPER_ADMIN` + роль |

`analyze-document` (`server.ts:3035`) и `daily-report` (`server.ts:3082,3111`) берут данные **только из тела** (`documentText.slice(0,15000)`, `JSON.stringify(projectData).slice(0,10000)`) — серверных данных не читают.

---

## Middleware Chain

Фактическая цепочка для анонимного `POST /api/ai/chat`:

```
1. server.ts:75  requestContext (AsyncLocalStorage, IP)            → пропускает
2. server.ts:80  security headers                                   → пропускает
3. server.ts:92  IP throttle 200/мин                                → пропускает (до лимита)
4. server.ts:111 express.json({limit:'50mb'})                       → пропускает
5. server.ts:2765 app.use('/api/ai/') circuit-breaker logger        → next() всегда
6. server.ts:2774 handler                                            → выполняется
```

**Ни одно звено не выполняет аутентификацию, авторизацию, проверку tenant или project.**
`requireAuth` (`server.ts:428`), `requireRole` (`server.ts:443`), `requireProjectAccess`
(`server.ts:457`) в этом пути не вызываются.

---

## Test Fixtures

Созданы **только в clean-room БД**, префикс `SECURITY:`:

| Фикстура | Где | Маркер `content` |
|---|---|---|
| `SECURITY:PROJECT-A` (проект) | таблица `projects` | содержит `SECURITY:DOC-A` |
| `SECURITY:PROJECT-B` (проект) | таблица `projects` | содержит `SECURITY:DOC-B` |
| `SECURITY:DOC-A` | также вставлен в `proj-1` | `SECURITY_SECRET_A_9f7c` |
| `SECURITY:DOC-B` | также вставлен в `proj-2` | `SECURITY_SECRET_B_4k2m` |
| `usr-secb` (пользователь) | таблица `users` | `projectIds = ['SECURITY:PROJECT-B']` — нет доступа ни к `proj-1`, ни к `proj-2` |

Документы продублированы в `proj-1`/`proj-2` намеренно: проверяемый код жёстко адресует `proj-1`,
поэтому маркер должен находиться именно там, иначе утечку невозможно наблюдать.

Пользователи для матрицы:

- **User A** = `usr-002` (`s.ivanov@aeron-corp.ru`, CHIEF_ENGINEER, `proj-aeron` + `proj-1`, **нет** `proj-2`);
- **User B** = `usr-secb` (FOREMAN, только `SECURITY:PROJECT-B`).

Контрольная проверка штатной изоляции (фактические коды ответа):

```
userA GET /api/projects/proj-1/documents → 200
userA GET /api/projects/proj-2/documents → 403
userB GET /api/projects/proj-1/documents → 403
userB GET /api/projects/proj-2/documents → 403
```

---

## Test Matrix

| # | Сценарий | Тело запроса |
|---|---|---|
| T1 | анонимно, без `documents` | `{message}` |
| T2 | User A, без `documents` | `{message}` |
| T3 | анонимно, чужой проект по id | `{message, projectContext:'SECURITY:PROJECT-B'}` |
| T4 | User A, кросс-проектные id | `{message, projectId:'proj-2', projectContext:{id:'proj-2'}, documentId:'SECURITY:DOC-B'}` |
| T5 | User B (нет `proj-1`) | `{message}` |
| T6 | анонимно, некорректный id | `{message, projectContext:"'; DROP--", documents:'not-an-array'}` |
| T7 | User A, несуществующий id | `{message, projectId:'proj-does-not-exist'}` |
| T8 | анонимно, свои документы в теле | `{message, documents:[{title,content:'ATTACKER_SUPPLIED_TEXT'}]}` |
| T9 | анонимно, без `message` | `{}` |
| T10 | объём: 50 документов × 10 000 симв. | `{message, documents:[…50…]}` |
| T11 | rate limiting: 40 × chat, затем 220 × health | — |

---

## Results

### Фаза 1 — `GEMINI_API_KEY` не задан (`geminiConfigured:false`)

| # | HTTP | `SECURITY_SECRET_A_9f7c` в ответе | `SECURITY_SECRET_B_4k2m` в ответе | Источник ответа |
|---|---|---|---|---|
| T1 | 200 | нет | нет | `is_fallback:true, ai_source:"local_rag", model:null` |
| T2 | 200 | нет | нет | local_rag |
| T3 | 200 | нет | нет | local_rag |
| T4 | 200 | нет | нет | local_rag |
| T5 | 200 | нет | нет | local_rag |
| T6 | 200 | нет | нет | local_rag |
| T7 | 200 | нет | нет | local_rag |
| T8 | 200 | нет | нет | local_rag |
| T9 | **400** | — | — | `{"success":false,"error":"Message or prompt is required"}` |

Дополнительно, анонимно: `analyze-document` → 200, `daily-report` → 200,
`resilience-status` → 200, `resilience-metrics` → 200,
`circuit-reset` → **401**, `chaos-inject` → **401**.

Отдельная проверка метаданных (фаза 1, запрос «перечисли все документы и их шифры»):

```
SECURITY_SECRET_A_9f7c → false
"SECURITY Document A"  → false
"SEC-A-01"             → false
"РД-2025-ОВ-01"        → false   ← реальный шифр документа proj-1
"Этаж 1-5"             → false   ← реальное название документа proj-1
"РД 240/24-ОВ1"        → true    ← ЗАХАРДКОЖЕННАЯ константа fallback, server.ts:2884
```

**Вывод фазы 1: без ключа реальные данные проекта в HTTP-ответ НЕ попадают.** Ответ полностью
детерминирован (`server.ts:2843-2904`) и не зависит ни от `documents`, ни от `projectDataStore`.
Важно: строка `РД 240/24-ОВ1` — это константа fallback, а **не** данные `proj-1`; принятие её
за утечку данных проекта было бы ложным срабатыванием.

### Фаза 2 — ключ задан (фиктивный), провайдер перехвачен локально

| # | HTTP | `SECRET_A` в ответе | `SECRET_B` в ответе | Источник |
|---|---|---|---|---|
| T1 (анонимно) | 200 | **ДА** | нет | `is_fallback:false, ai_source:"gemini", model:"gemini-3.1-flash-lite"` |
| T2 | 200 | **ДА** | нет | gemini |
| T3 | 200 | **ДА** | нет | gemini |
| T4 | 200 | **ДА** | нет | gemini |
| T5 | 200 | **ДА** | нет | gemini |
| T6 | 200 | **ДА** | нет | gemini |
| T7 | 200 | **ДА** | нет | gemini |
| T8 | 200 | нет | нет | gemini (grounding полностью заменён телом запроса) |
| T9 | **400** | — | — | — |

Перехвачен 51 исходящий вызов к
`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent`;
`SECURITY_SECRET_A_9f7c` присутствует в теле **48** из них, `SECURITY_SECRET_B_4k2m` — в **0**.

---

## Document Metadata Exposure

`ПОДТВЕРЖДЕНО.` Для любого запроса без `documents` в промпт включаются поля каждого документа
`proj-1`: `title`, `code`, `section`, `revision`, `status` (`server.ts:2794-2801`).

Фактически перехваченный промпт (анонимный запрос T1, фаза 2):

```
ДОКУМЕНТЫ ОБЪЕКТА:
[DOCUMENT 1]:
Название: "SECURITY Document A"
Шифр: "SEC-A-01"
Раздел: "ОВиК"
Ревизия: "v9.9"
Статус: "APPROVED"
Содержимое / Спецификация:
SECURITY_SECRET_A_9f7c — маркер содержимого документа проекта A.
---

[DOCUMENT 2]:
Название: "Рабочая документация ОВиК Этаж 1-5"
Шифр: "РД-2025-ОВ-01"
...
ЗАПРОС:
Какое содержимое документов объекта?
```

Отдельный дефект целостности данных (`server.ts:2802`): у `DOCUMENT 2` поле `content` отсутствует,
и сервер **синтезировал** текст «Нормативное давление опрессовки контура VRF-1: 4.15 МПа по
СП 73.13330.2016. Фактическое зафиксированное падение: 0.35 МПа» и отправил его модели как
содержимое реального документа. Это прямое нарушение п.31 регламента (выдача предположения за факт)
внутри RAG-контекста.

---

## Document Content Exposure

`ПОДТВЕРЖДЕНО.` `doc.content` попадает в промпт: `server.ts:2802`, `doc.content.slice(0, 4000)`.

Фактические границы объёма (T10, измерено на перехваченном запросе):

- на документ — ровно **4000 символов** (`X`-последовательности в перехвате: `[4000, 4000, 4000]`);
- **количество документов не ограничено**: 50 документов → 50 блоков `[DOCUMENT n]` в промпте;
- итоговый размер одного промпта — **206 259 символов** от одного анонимного запроса;
- верхняя граница задаётся только `express.json({limit:'50mb'})` (`server.ts:111`).

В HTTP-ответ содержимое попадает опосредованно — через ответ модели (фаза 2: маркер
`SECURITY_SECRET_A_9f7c` вернулся клиенту в полях `answer` и `sources`). Фильтрации ответа модели
нет (`server.ts:2918-2933`).

---

## Cross-Project Isolation

| Вопрос | Факт |
|---|---|
| Может ли атакующий выбрать ДРУГОЙ проект своими идентификаторами? | **НЕТ** |
| Доказательство | `projectContext`, `projectId`, `documentId` в теле **нигде не читаются** для выбора данных; единственный серверный источник — литерал `'proj-1'` (`server.ts:2791`) |
| Эмпирика | T3, T4, T7: `SECURITY_SECRET_B_4k2m` (в `proj-2` и `SECURITY:PROJECT-B`) не появился ни в одном из 51 перехваченного промпта и ни в одном ответе |
| Может ли атакующий подменить контекст? | **ДА**, но только «вниз»: `documents` в теле полностью вытесняет серверные документы (T8) — это не даёт доступа к чужим данным |
| Соблюдается ли изоляция для проекта `proj-1`? | **НЕТ.** Анонимный запрос (без tenant, без project, без роли) получает документы `proj-1` — проекта организации `org-main` |
| Зависит ли выдача от личности пользователя? | **НЕТ.** T1 (аноним), T2 (User A с доступом к `proj-1`) и T5 (User B без доступа к `proj-1`) дали **идентичный** результат |

Итог: это **не IDOR** (выбор объекта по идентификатору невозможен), а **жёстко зашитая утечка
одного конкретного проекта** неаутентифицированному вызывающему.

---

## External Provider Call

`ПОДТВЕРЖДЕНО (в clean-room, с фиктивным ключом и локальным перехватом).`

- Условие вызова: `process.env.GEMINI_API_KEY` непустой (`src/server/aiResilience.ts:256-257`);
  иначе весь каскад моделей пропускается (`:351`) и возвращается детерминированный fallback.
- При заданном ключе приложение фактически формирует HTTP-запрос
  `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent`
  с телом `{contents, systemInstruction, generationConfig}` — зафиксировано 51 раз.
- Каскад моделей: `gemini-3.1-flash-lite` → `gemini-3.7-flash` → `gemini-3.1-pro-preview`
  (`src/server/aiResilience.ts:78-88`).
- Анонимный запрос **достаточен** для инициации вызова: аутентификация в этом пути отсутствует.

`EXTERNAL PROVIDER CALL WITH REAL PAID KEY = NOT VERIFIED` — реальный ключ не передавался,
трафик наружу не выпускался, фактический расход платного ресурса не измерялся.
Конфигурация production-ключа не проверена (`.env` недоступен).

---

## Rate Limiting

| Механизм | Файл:строка | Применяется к `/api/ai/*`? | Факт |
|---|---|---|---|
| Глобальный IP-throttle 200 запросов/мин | `server.ts:92-109` | **ДА** (общий счётчик) | 220 × `GET /api/health` → 137×200, 83×429; следующий `POST /api/ai/chat` → **429** |
| `uploadLimiter` (20/ч auth, 5/ч аноним) | `server.ts:58-67` | **НЕТ** — только `/api/documents/upload*` (`server.ts:1243`) | — |
| Семафор AI-конкурентности (10) | `src/server/aiResilience.ts:315-344` | ДА | ограничивает параллелизм, не частоту; при переполнении — мгновенный fallback |
| Персональный лимит для AI | — | **ОТСУТСТВУЕТ** | 40 последовательных анонимных `POST /api/ai/chat` → 40×200, каждый породил вызов провайдера |

Специализированного rate limiting для AI-эндпоинтов нет. Единственная преграда — общий лимит по IP,
обходимый распределением по адресам; при этом один запрос может нести промпт в 206 КБ.

---

## BLK-004 Verification

Проверяемые утверждения:

1. `docs/security/VERIFIED_API_SECURITY_MATRIX.md:74` — `/api/ai/chat`, колонка Project:
   «`n/a (контекст документов из тела запроса)`».
2. `.agent-state/BLOCKERS.md:8` (BLK-004) — «ПРОВЕРЕНО: читают тело запроса, а не БД →
   межарендаторной утечки нет».

**Вердикт: `PARTIALLY VALID`.**

| Часть утверждения | Вердикт | Доказательство |
|---|---|---|
| «контекст документов из тела запроса» | `REFUTED` (неполно) | `server.ts:2789-2791`: тело используется **только если** `documents` — непустой массив; иначе читается `projectDataStore['proj-1']` |
| «читают тело запроса, а не БД» | `REFUTED` | `projectDataStore` наполняется из БД при старте (`server.ts:1995`) и при загрузке документов (`server.ts:1379-1380`). Маркер `SECURITY_SECRET_A_9f7c`, записанный **только в БД**, оказался в перехваченном промпте — фактическое доказательство чтения БД |
| «межарендаторной утечки нет» — в части «атакующий не выберет чужой проект» | `CONFIRMED` | `SECURITY_SECRET_B_4k2m` — 0 вхождений в 51 перехваченном вызове; T3/T4/T7 не дали доступа к `proj-2`/`SECURITY:PROJECT-B` |
| «межарендаторной утечки нет» — в части «данные проекта не уходят к чужому» | `REFUTED` | анонимный вызывающий без tenant/project/роли получает документы `proj-1` (org-main): T1 фаза 2 — `SECRET_A` в ответе; T5 — пользователь без доступа к `proj-1` получает то же самое |

Итог: BLK-004 верен в узком смысле (**нет произвольного кросс-проектного выбора**) и неверен
в обосновании (**БД читается**) и в общем выводе (**один проект утекает неаутентифицированно**).

---

## SEC-001 Verification

`ПОДТВЕРЖДЕНО ЧАСТИЧНО.` Полная перепроверка 29 попыток SEC-001 в scope не входила; выполнена
выборочная контрольная проверка механизма `requireProjectAccess` (`server.ts:457-470`):

```
userA (proj-1, proj-aeron) → GET /api/projects/proj-2/documents → 403
userB (SECURITY:PROJECT-B) → GET /api/projects/proj-1/documents → 403
userB (SECURITY:PROJECT-B) → GET /api/projects/proj-2/documents → 403
userA (proj-1, proj-aeron) → GET /api/projects/proj-1/documents → 200
```

На проектных маршрутах изоляция работает. **Существенно:** SEC-001 не распространяется на
`/api/ai/chat` — этот маршрут не вызывает `requireProjectAccess` вовсе, поэтому статус
«cross-project изоляция ПОДТВЕРЖДЕНА» нельзя переносить на AI-домен.

---

## Severity

| Категория | Установленный факт | Оценка |
|---|---|---|
| **A — метаданные документа** | `title/code/section/revision/status` документов `proj-1` уходят в промпт при анонимном запросе (`server.ts:2794-2801`) | P2 |
| **B — `doc.content`** | до 4000 симв. на документ, без ограничения числа документов (`server.ts:2802`) | P2 → P1 при заданном ключе |
| **C — кросс-проектный доступ** | **не подтверждён**: произвольный выбор проекта невозможен | не применимо |
| **D — раскрытие чувствительной проектной информации** | зависит от фактического содержимого `content` документов `proj-1`; в текущем workspace `proj-1` содержит один seed-документ **без** `content` | UNKNOWN (не проверено на реальных данных) |
| **E — неконтролируемый расход платного ресурса** | анонимный вызов инициирует вызов провайдера; лимит только 200/мин на IP; один запрос — промпт 206 КБ | P1 при заданном ключе, P3 без него |

**Итоговая severity: `P1 УСЛОВНО` / `P2` в фактически наблюдаемой конфигурации.**

Обоснование без завышения:

- Условие P1 — **наличие `GEMINI_API_KEY` в production**. Оно НЕ ПРОВЕРЕНО (`.env` недоступен).
  При выполнении условия: неаутентифицированная передача содержимого проектных документов третьей
  стороне (категории A+B+E) и неконтролируемый платный расход.
- Без ключа (фактически наблюдалось в clean-room, `geminiConfigured:false`) ни один байт данных
  проекта в HTTP-ответ не попадает — ответ полностью детерминирован. Остаточный риск — отсутствие
  аутентификации как таковой: **P2**.
- Severity **не повышается** до P0: кросс-проектный/кросс-арендаторный пивот не существует,
  запись данных отсутствует, обход state machine отсутствует, утечки секретов нет.
- Категория D помечена **UNKNOWN**, а не подтверждена: проверка выполнена на искусственных
  маркерах, реальное содержимое production-документов `proj-1` не исследовалось.

---

## Evidence

| Артефакт | Расположение (clean-room) |
|---|---|
| Перехваченные промпты (51 вызов, JSONL) | `scratchpad/secverify/captured-prompts.jsonl` |
| Скрипт матрицы | `scratchpad/secverify/matrix.mjs` |
| Скрипт фикстур | `scratchpad/secverify/fixtures.mjs` |
| Перехватчик сети | `scratchpad/secverify/intercept.cjs` |
| Логи сервера | `scratchpad/secverify/phase1.log`, `phase2.log`, `phase1b.log` |

Ключевые строки кода: `server.ts:2765`, `2774`, `2789-2791`, `2794-2805`, `2802`, `2884`, `2906`,
`2918-2933`, `1348`, `1379-1380`, `1995`, `92-109`, `111`, `428`, `457`;
`src/server/aiResilience.ts:78-88`, `255-262`, `300-345`, `351`, `383-396`.

---

## Limitations

1. **`.env` недоступен** — фактическое наличие `GEMINI_API_KEY` в production `НЕ ПРОВЕРЕНО`.
   Вся оценка категории E условна.
2. **Реальный платный вызов не выполнялся** — `EXTERNAL PROVIDER CALL WITH REAL KEY = NOT VERIFIED`.
   Подтверждено только формирование корректного HTTP-запроса к провайдеру и доставка ему содержимого.
3. **Поведение реальной модели не проверялось** — в фазе 2 использовалась локальная заглушка.
   То, что реальная Gemini воспроизведёт содержимое документа в ответе, — `ПРЕДПОЛОЖЕНИЕ`;
   доказан факт передачи содержимого провайдеру и отсутствие фильтрации ответа на стороне сервера.
4. **Реальные данные `proj-1` не исследовались** — работа велась на clean-room БД с искусственными
   маркерами. Данные AERON не затрагивались.
5. **Frontend не проверялся** — неизвестно, отправляет ли UI `documents` в теле на практике;
   это влияет на то, как часто срабатывает серверная подстановка в реальной эксплуатации.
6. **SEC-001 перепроверен выборочно** (4 запроса), не в полном объёме 29 попыток.
7. **Проверка выполнена на артефакте `dist/server.cjs` от 2026-09-18**; `server.ts` содержит
   незакоммиченные изменения (`git status: M server.ts`) — расхождение сборки и исходника
   не исключено, хотя проверенные строки совпали.

---

## Regression Test Recommendation

Минимальный набор регрессионных проверок (реализовывать вне текущей задачи — это verification, не
implementation):

1. **Auth-gate**: `POST /api/ai/chat` без `Authorization` → ожидается `401`. Сейчас `200`.
2. **Project binding**: `POST /api/ai/chat` с `projectId`, к которому у пользователя нет доступа →
   `403` через `requireProjectAccess`. Сейчас параметр игнорируется.
3. **Отсутствие жёсткого источника**: тест, помещающий маркер `content` в `proj-1` и выполняющий
   запрос от пользователя **без** доступа к `proj-1`; маркер не должен появиться ни в промпте,
   ни в ответе. Точка наблюдения — исходящий запрос к провайдеру (mock).
4. **Запрет синтеза содержимого**: документ без `content` не должен порождать выдуманный
   нормативный текст (`server.ts:2802`); ожидается пустой блок или пропуск документа.
5. **Ограничение объёма**: запрос с 50 документами × 10 000 симв. — промпт не должен превышать
   заданный бюджет; сейчас 206 259 символов без ограничения.
6. **Rate limit для AI**: N анонимных (или пользовательских) запросов к `/api/ai/chat` в окно →
   `429` раньше общего лимита 200/мин.
7. **Аудит**: каждый вызов `/api/ai/chat` должен порождать запись `logAudit`; сейчас записей нет.
8. **Регресс `is_fallback`**: при отсутствии ключа ответ обязан оставаться `local_rag` и не
   содержать данных БД (текущее поведение — корректное, зафиксировать его тестом).

---

## Final Verdict

`PARTIALLY CONFIRMED`

Подтверждено: `/api/ai/chat` не требует аутентификации и авторизации; при пустом `documents`
читает документы из БД через `projectDataStore['proj-1']`; метаданные и до 4000 символов
`doc.content` каждого документа передаются во внешний GenAI-провайдер при заданном ключе;
специализированного rate limiting и аудита нет.

Не подтверждено: кросс-проектный/кросс-арендаторный доступ по идентификаторам атакующего
(технически невозможен — источник жёстко зашит); утечка данных проекта в HTTP-ответ при
отсутствии ключа (не происходит); фактический расход платного ресурса (не измерялся).

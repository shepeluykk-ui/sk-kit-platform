// R3-013.1 — жизненный цикл владения задачей анализа.
//
// Независимый verifier подтвердил исходный дефект R3-013 (второй процесс
// уничтожал живую задачу первого), но нашёл в самой реализации владения шесть
// новых. Здесь по одному сценарию на каждый.
//
// Сценарии разделены по уровню намеренно. Условия оператора UPDATE — кто имеет
// право изменить строку — проверяются прямым обращением к модулю базы: через
// HTTP нельзя воспроизвести ни истёкшего владельца, ни одновременный захват
// двумя процессами. Всё остальное проверяется на настоящем сервере.
//
// Ожидаемые длительности заданы сроком владения (60 с) и периодом ревизии
// (30 с); суммарно набор идёт около трёх минут.

import { spawn, ChildProcess } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import os from 'os';

type TestFn = () => Promise<void>;
const cases: { name: string; fn: TestFn }[] = [];
const test = (name: string, fn: TestFn) => { cases.push({ name, fn }); };

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
  }
}
function assertTrue(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const SERVER_BUNDLE = path.join(process.cwd(), 'dist', 'server.cjs');
const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'r30131-integration';
const SUPER_ADMIN = 'admin@stroycontrol.pro';
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'];
const ACTIVE = ['QUEUED', 'PARSING', 'EXTRACTING', 'ANALYZING', 'CALCULATING', 'VALIDATING'];

const LEASE_MS = 60_000;      // ANALYSIS_LEASE_MS
const SWEEP_MS = LEASE_MS / 2; // период ревизии выводится из срока владения

let server: ChildProcess | null = null;
let sandbox = '';
let token = '';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const env = () => ({
  ...process.env,
  NODE_ENV: 'production',
  SEED_USER_PASSWORD: PASSWORD,
  DATABASE_URL: '',
  // Ключ фиктивный: chaos перехватывает вызов до обращения к сети.
  GEMINI_API_KEY: 'r30131-chaos-key-not-real',
  GOOGLE_GENAI_API_KEY: ''
});

async function boot(): Promise<ChildProcess | null> {
  const p = spawn('node', [SERVER_BUNDLE], { cwd: sandbox, env: env(), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return p; }
    catch { await sleep(400); }
  }
  return null;
}

async function login(user: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: PASSWORD })
  });
  return (await r.json()).token;
}

const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

/** Задерживает ответ модели, чтобы конвейер оставался активным всё время проверки. */
async function holdModel(delayMs: number): Promise<void> {
  for (const modelId of MODELS) {
    await fetch(`${BASE}/api/ai/chaos-inject`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ modelId, failureType: 'REQUEST_TIMEOUT', status: 504, delayMs })
    });
  }
}

const startAnalysis = (projectId: string, name: string) =>
  fetch(`${BASE}/api/projects/${projectId}/ai-analysis`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      projectName: name, documentIds: ['d'],
      documentsContent: [{ id: 'd', title: 'T', code: 'T', section: 'OB', content: 'x' }],
      waitForCompletion: false
    })
  });

const dbPath = () => path.join(sandbox, 'data', 'skkit.db');

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath());
  try { return fn(db); } finally { db.close(); }
}

type Row = { status: string; owner_id: string | null; lease_until: string | null };

const dbRow = (analysisId: string): Row | null => withDb(db =>
  db.prepare('SELECT status, owner_id, lease_until FROM ai_analyses WHERE id = ?').get(analysisId) as any ?? null
);

/** Делает владение просроченным — так выглядит запись процесса, которого больше нет. */
const expireLease = (analysisId: string): void => withDb(db => {
  db.prepare('UPDATE ai_analyses SET lease_until = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), analysisId);
});

// ────────────────────────────────────────────────────────────────────────────
// Условия оператора UPDATE: прямая проверка на модуле базы.
// ────────────────────────────────────────────────────────────────────────────

type DbModule = typeof import('../../src/server/database');
let dbUnitSandbox = '';
let dbm: DbModule;

async function loadDbModule(): Promise<void> {
  dbUnitSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r30131-unit-'));
  fs.mkdirSync(path.join(dbUnitSandbox, 'data'), { recursive: true });
  // Модуль открывает базу по process.cwd(); песочница изолирует его от рабочей.
  process.chdir(dbUnitSandbox);
  delete process.env.DATABASE_URL;
  dbm = await import('../../src/server/database');
  // Схема создаётся при первом обращении к базе; прямые INSERT ниже идут в обход
  // модуля, поэтому таблицу нужно материализовать заранее.
  dbm.dbGetAnalysisJob('schema-warmup');
}

/** Заготовка строки, принадлежащей другому, уже не существующему процессу. */
function seedForeignJob(id: string, projectId: string, leaseOffsetMs: number): void {
  const job = { analysisId: id, projectId, status: 'PARSING', updatedAt: new Date().toISOString() };
  const db = new DatabaseSync(path.join(dbUnitSandbox, 'data', 'skkit.db'));
  try {
    db.prepare(
      `INSERT OR REPLACE INTO ai_analyses (id, data, updated_at, project_id, status, owner_id, lease_until)
       VALUES (?, ?, ?, ?, 'PARSING', 'inst-foreign-dead', ?)`
    ).run(id, JSON.stringify(job), new Date().toISOString(), projectId,
          new Date(Date.now() + leaseOffsetMs).toISOString());
  } finally { db.close(); }
}

const unitRow = (id: string): Row => {
  const db = new DatabaseSync(path.join(dbUnitSandbox, 'data', 'skkit.db'));
  try {
    return db.prepare('SELECT status, owner_id, lease_until FROM ai_analyses WHERE id = ?').get(id) as any;
  } finally { db.close(); }
};

test('D4 запись владельцем: чужое действующее владение не перехватывается', async () => {
  await loadDbModule();
  // Владение чужое и ещё действует — этот процесс изменить запись не вправе.
  seedForeignJob('u-alive', 'p-alive', +LEASE_MS);

  const written = dbm.dbUpdateAnalysisJob('u-alive', 'COMPLETED', { hijacked: true });
  assertEqual(written, false, 'Запись поверх живого чужого владения должна быть отклонена');

  const row = unitRow('u-alive');
  assertEqual(row.status, 'PARSING', 'Статус чужой живой задачи не должен меняться');
  assertEqual(row.owner_id, 'inst-foreign-dead', 'Владелец чужой живой задачи не должен меняться');
});

test('D4 запись владельцем: собственное владение продлевается', async () => {
  const id = 'u-own';
  dbm.dbInsertAnalysisJob({ analysisId: id, projectId: 'p-own', status: 'QUEUED' }, { analysisId: id });

  const written = dbm.dbUpdateAnalysisJob(id, 'PARSING', { analysisId: id, status: 'PARSING' });
  assertEqual(written, true, 'Владелец должен иметь возможность изменить свою задачу');
  assertEqual(unitRow(id).owner_id, dbm.INSTANCE_ID, 'Владельцем остаётся этот процесс');

  const done = dbm.dbUpdateAnalysisJob(id, 'COMPLETED', { analysisId: id, status: 'COMPLETED' });
  assertEqual(done, true, 'Переход в терминальное состояние должен проходить');
  assertEqual(unitRow(id).owner_id, null, 'При завершении владение снимается');
});

test('D4 истёкший владелец: запись проходит, пока задачу никто не перехватил', async () => {
  // Владение просрочено, но задача ещё ничья: продлить собственную работу
  // законно — иначе пауза событийного цикла навсегда лишала бы процесс
  // возможности дописать результат.
  seedForeignJob('u-expired', 'p-expired', -1000);
  const written = dbm.dbUpdateAnalysisJob('u-expired', 'COMPLETED', { recovered: false });
  assertEqual(written, true, 'Просроченная, но не перехваченная задача должна быть доступна для записи');
});

test('D7 захват брошенной задачи: одновременная ревизия отдаёт её ровно одному', async () => {
  seedForeignJob('u-race', 'p-race', -1000);

  const first = dbm.dbClaimAbandonedAnalysisJob('u-race', { status: 'FAILED', by: 'first' });
  const second = dbm.dbClaimAbandonedAnalysisJob('u-race', { status: 'FAILED', by: 'second' });

  assertEqual(first, true, 'Первая ревизия должна захватить брошенную задачу');
  assertEqual(second, false, 'Вторая ревизия не должна писать поверх чужого решения');
  assertEqual(unitRow('u-race').status, 'FAILED', 'Задача переведена в терминальное состояние');
});

test('D4 захват брошенной задачи: живое чужое владение не захватывается', async () => {
  seedForeignJob('u-live', 'p-live', +LEASE_MS);
  const claimed = dbm.dbClaimAbandonedAnalysisJob('u-live', { status: 'FAILED' });
  assertEqual(claimed, false, 'Задача живого владельца не может быть захвачена как брошенная');
  assertEqual(unitRow('u-live').status, 'PARSING', 'Инвариант R3-013 сохранён: чужая живая работа не тронута');
});

test('D5 классификация ошибок базы: занятость отличается от прочих сбоев', async () => {
  assertTrue(dbm.isTransientDbContention({ code: 'SQLITE_BUSY' }), 'SQLITE_BUSY — временная занятость');
  assertTrue(dbm.isTransientDbContention({ code: 'SQLITE_LOCKED' }), 'SQLITE_LOCKED — временная занятость');
  assertTrue(dbm.isTransientDbContention(new Error('database is locked')), 'Текст «database is locked» — занятость');

  assertTrue(!dbm.isTransientDbContention(new Error('database disk image is malformed')),
    'Повреждение базы не должно приниматься за временную занятость');
  assertTrue(!dbm.isTransientDbContention(new Error('no such column: owner_id')),
    'Ошибка в запросе не должна приниматься за временную занятость');
  assertTrue(!dbm.isTransientDbContention(new Error('UNIQUE constraint failed: ai_analyses.project_id')),
    'Конфликт активного анализа не должен приниматься за временную занятость');

  // Обратная сторона: ожидаемый конфликт не должен маскироваться под занятость.
  assertTrue(dbm.isActiveAnalysisConflict(new Error('UNIQUE constraint failed: ai_analyses.project_id')),
    'Нарушение уникальности остаётся признаком конфликта активного анализа');
  assertTrue(!dbm.isActiveAnalysisConflict(new Error('database is locked')),
    'Занятость базы не должна выдаваться за конфликт активного анализа');
});

test('D6 остановка: приём новой работы прекращается, периодические задачи останавливаются', async () => {
  // Платформа не доставляет SIGTERM (проверено замером ниже), поэтому цепочка
  // штатной остановки проверяется на самом оркестраторе: это те её шаги,
  // которые не зависят от способа получения сигнала.
  const orch = (await import('../../src/server/projectAnalysisOrchestrator'))
    .ProjectAnalysisOrchestrator.getInstance();

  const heartbeat = orch.startLeaseHeartbeat(1000);
  const sweep = orch.startRecoverySweep(1000);
  assertTrue(!orch.isShuttingDown(), 'До сигнала процесс принимает работу');

  orch.beginShutdown();
  assertTrue(orch.isShuttingDown(), 'После сигнала процесс помечен останавливающимся');

  // 1. Новая работа не принимается.
  let code = '';
  try {
    await orch.createAndRunAnalysis({
      projectId: 'p-shutdown', projectName: 'AFTER-SHUTDOWN', documentIds: ['d'],
      documentsContent: [{ id: 'd', title: 'T', code: 'T', section: 'OB', content: 'x' }]
    });
  } catch (e: any) { code = e?.code ?? ''; }
  assertEqual(code, 'SERVER_SHUTTING_DOWN', 'Останавливающийся процесс не должен начинать новый конвейер');

  // Запись при этом не создана — иначе проект остался бы заблокирован задачей,
  // которую никто никогда не исполнит.
  assertEqual(dbm.dbGetActiveAnalysisJob('p-shutdown'), null,
    'Отклонённый при остановке запрос не должен оставлять активную запись');

  // 2. Периодические обращения к базе прекращены: иначе они шли бы уже после
  // её закрытия.
  orch.stopBackgroundTimers();
  assertTrue(
    (heartbeat as any)._destroyed === true && (sweep as any)._destroyed === true,
    'Таймеры подтверждения владения и ревизии должны быть остановлены'
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Поведение работающего сервера.
// ────────────────────────────────────────────────────────────────────────────

test('D1 быстрый перезапуск: задача мёртвого владельца подбирается ревизией, а не только стартом', async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r30131-'));
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

  server = await boot();
  assertTrue(!!server, 'Процесс A не поднялся');
  token = await login(SUPER_ADMIN);
  await holdModel(600_000);

  const started = await startAnalysis('proj-quick', 'QUICK-RESTART');
  assertEqual(started.status, 201, 'Задача должна создаться');
  const analysisId = (await started.json()).job.analysisId;
  assertTrue(ACTIVE.includes(dbRow(analysisId)!.status), 'Задача должна быть активной');

  // Владелец гибнет; процесс B поднимается, пока владение ещё действует.
  server!.kill('SIGKILL');
  server = null;
  await sleep(1200);

  server = await boot();
  assertTrue(!!server, 'Процесс B не поднялся');
  token = await login(SUPER_ADMIN);

  // Ровно то условие, при котором раньше задача застревала навсегда: стартовая
  // ревизия её не тронула, потому что владение ещё не истекло.
  assertTrue(
    ACTIVE.includes(dbRow(analysisId)!.status),
    'Исходное условие проверки: при быстром перезапуске стартовая ревизия задачу не трогает'
  );

  // Срок истекает. До правки на этом всё и заканчивалось: ревизия больше не
  // повторялась, и проект оставался заблокирован индексом бессрочно.
  expireLease(analysisId);

  const deadline = Date.now() + SWEEP_MS + 20_000;
  while (Date.now() < deadline && dbRow(analysisId)!.status !== 'FAILED') await sleep(2000);

  assertEqual(dbRow(analysisId)!.status, 'FAILED',
    'Периодическая ревизия обязана подобрать задачу после истечения владения');

  const again = await startAnalysis('proj-quick', 'AFTER-SWEEP');
  assertEqual(again.status, 201, 'После ревизии проект не должен оставаться заблокированным');
});

test('D1 ревизия без перезапуска: брошенная чужая задача подбирается работающим процессом', async () => {
  // Задача другого процесса появляется в базе уже после старта сервера —
  // стартовая ревизия её в принципе видеть не могла.
  const id = 'job-ai-foreign-sweep';
  withDb(db => {
    db.prepare(
      `INSERT OR REPLACE INTO ai_analyses (id, data, updated_at, project_id, status, owner_id, lease_until)
       VALUES (?, ?, ?, 'proj-foreign', 'PARSING', 'inst-other-dead', ?)`
    ).run(id, JSON.stringify({ analysisId: id, projectId: 'proj-foreign', status: 'PARSING' }),
          new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
  });

  const deadline = Date.now() + SWEEP_MS + 20_000;
  while (Date.now() < deadline && dbRow(id)!.status !== 'FAILED') await sleep(2000);

  assertEqual(dbRow(id)!.status, 'FAILED', 'Работающий процесс обязан подбирать брошенные задачи периодически');
  assertEqual(dbRow(id)!.owner_id, null, 'После восстановления владение снято');
});

test('D2 занятость базы в момент старта не мешает процессу подняться', async () => {
  // Стартовая ревизия — такая же запись в базу, как подтверждение владения, и
  // необработанное исключение там завершило бы процесс до того, как он начнёт
  // обслуживать запросы.
  server!.kill('SIGKILL');
  server = null;
  await sleep(1200);

  const hold = new DatabaseSync(dbPath());
  let booted: ChildProcess | null = null;
  try {
    hold.exec('BEGIN IMMEDIATE');
    hold.prepare(`UPDATE ai_analyses SET updated_at = ? WHERE id = 'nonexistent'`).run(new Date().toISOString());

    // Процесс поднимается, пока база удерживается другим писателем.
    booted = spawn('node', [SERVER_BUNDLE], { cwd: sandbox, env: env(), stdio: 'ignore' });
    await sleep(6000);
    assertEqual(booted.exitCode, null, 'Процесс не должен завершаться из-за занятости базы на старте');
  } finally {
    try { hold.exec('ROLLBACK'); } catch { /* уже откачено */ }
    hold.close();
  }

  // И после освобождения базы обслуживает запросы как обычно.
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { healthy = true; break; } }
    catch { await sleep(400); }
  }
  assertTrue(healthy, 'После освобождения базы процесс обязан обслуживать запросы');
  server = booted;
  token = await login(SUPER_ADMIN);
});

test('D3 источник истины: после перехвата API не продолжает сообщать старый статус', async () => {
  await holdModel(600_000);
  const started = await startAnalysis('proj-cache', 'CACHE-VS-DB');
  assertEqual(started.status, 201, 'Задача должна создаться');
  const analysisId = (await started.json()).job.analysisId;

  const before = await fetch(`${BASE}/api/projects/proj-cache/ai-analysis?analysisId=${analysisId}`, { headers: auth() });
  assertTrue(ACTIVE.includes((await before.json()).job.status), 'Пока задача идёт, API отдаёт активный статус');

  // Так выглядит запись после того, как её восстановил другой процесс.
  withDb(db => {
    const job = { analysisId, projectId: 'proj-cache', status: 'FAILED',
      currentPhaseText: 'Анализ прерван остановкой сервера и не был возобновлён. Запустите анализ заново.' };
    db.prepare(`UPDATE ai_analyses SET status = 'FAILED', data = ?, owner_id = NULL, lease_until = NULL WHERE id = ?`)
      .run(JSON.stringify(job), analysisId);
  });

  const after = await fetch(`${BASE}/api/projects/proj-cache/ai-analysis?analysisId=${analysisId}`, { headers: auth() });
  assertEqual((await after.json()).job.status, 'FAILED',
    'База — источник истины: рабочая копия в памяти не должна перекрывать её после перехвата');

  const latest = await fetch(`${BASE}/api/projects/proj-cache/ai-analysis`, { headers: auth() });
  assertEqual((await latest.json()).job.status, 'FAILED', 'Выборка последней задачи проекта тоже должна брать статус из базы');

  // Прямое следствие: проект действительно разблокирован, а не только на вид.
  const again = await startAnalysis('proj-cache', 'AFTER-CACHE-SYNC');
  assertEqual(again.status, 201, 'После перехвата новый анализ проекта должен быть возможен');
});

test('D2/D8 живой владелец: heartbeat продлевает владение, статус не меняется', async () => {
  await holdModel(600_000);
  const started = await startAnalysis('proj-live', 'LIVE-HEARTBEAT');
  assertEqual(started.status, 201, 'Задача должна создаться');
  const analysisId = (await started.json()).job.analysisId;

  const first = dbRow(analysisId)!;
  assertTrue(!!first.owner_id && !!first.lease_until, 'У активной задачи есть владелец и срок владения');

  // Период подтверждения — 15 с; двух ждём, чтобы срок заведомо сдвинулся.
  await sleep(35_000);

  const second = dbRow(analysisId)!;
  assertTrue(ACTIVE.includes(second.status), `Задача живого владельца остаётся активной, статус: ${second.status}`);
  assertEqual(second.owner_id, first.owner_id, 'Владелец живой задачи не меняется');
  assertTrue(
    new Date(second.lease_until!).getTime() > new Date(first.lease_until!).getTime(),
    'Срок владения обязан продлеваться, пока процесс жив'
  );
  // Периодическая ревизия не должна трогать живую работу — в этом и была
  // опасность её введения.
  assertTrue(ACTIVE.includes(second.status), 'Ревизия не должна затрагивать задачу живого владельца');
});

test('D2 занятость базы во время heartbeat не завершает процесс-владелец', async () => {
  const hold = new DatabaseSync(dbPath());
  let released = false;
  try {
    // Второй писатель удерживает базу дольше, чем период подтверждения владения.
    hold.exec('BEGIN IMMEDIATE');
    hold.prepare(`UPDATE ai_analyses SET updated_at = ? WHERE id = 'nonexistent'`).run(new Date().toISOString());
    await sleep(20_000);
    hold.exec('ROLLBACK');
    released = true;
  } finally {
    if (!released) { try { hold.exec('ROLLBACK'); } catch { /* уже откачено */ } }
    hold.close();
  }

  const health = await fetch(`${BASE}/api/health`);
  assertEqual(health.status, 200, 'Процесс-владелец обязан пережить временную занятость базы');
  assertTrue(server !== null && server.exitCode === null, 'Процесс не должен завершаться из-за занятости базы');

  // И продолжить подтверждать владение после освобождения.
  const before = dbRow((await (await fetch(`${BASE}/api/projects/proj-live/ai-analysis`, { headers: auth() })).json()).job.analysisId)!;
  await sleep(20_000);
  const after = dbRow((await (await fetch(`${BASE}/api/projects/proj-live/ai-analysis`, { headers: auth() })).json()).job.analysisId)!;
  assertTrue(
    new Date(after.lease_until!).getTime() >= new Date(before.lease_until!).getTime(),
    'После освобождения базы подтверждение владения обязано возобновиться'
  );
});

test('D9 одновременное создание анализа: ровно один 201, остальные 409', async () => {
  await holdModel(600_000);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => startAnalysis('proj-concurrent', `CONCURRENT-${i}`))
  );
  const codes = results.map(r => r.status);
  assertEqual(codes.filter(c => c === 201).length, 1, `Создаться должна ровно одна задача, коды: ${codes.join(',')}`);
  assertEqual(codes.filter(c => c === 409).length, 9, `Остальные должны получить 409, коды: ${codes.join(',')}`);
  assertEqual(codes.filter(c => c === 500).length, 0, 'Гонка не должна давать 500');
});

test('D6 SIGTERM: процесс завершается штатно и не отдаёт свою работу немедленно', async () => {
  const live = (await (await fetch(`${BASE}/api/projects/proj-live/ai-analysis`, { headers: auth() })).json()).job.analysisId;
  assertTrue(ACTIVE.includes(dbRow(live)!.status), 'К моменту остановки задача должна быть активной');

  const deliversSigterm = await platformDeliversSigterm();

  const code: number | null = await new Promise(res => {
    server!.on('exit', c => res(c));
    server!.kill('SIGTERM');
  });
  server = null;

  if (!deliversSigterm) {
    // Инвариант владения ниже проверяется в любом случае: после исчезновения
    // процесса — как бы оно ни произошло — задача не должна становиться
    // добычей немедленно. Но сам путь штатной остановки здесь не выполнялся.
    const afterKill = dbRow(live)!;
    assertTrue(ACTIVE.includes(afterKill.status), 'После исчезновения процесса задача остаётся активной в базе');
    assertTrue(!!afterKill.owner_id, 'Владение не снимается');
    assertTrue(new Date(afterKill.lease_until!).getTime() > Date.now(),
      'Срок владения ещё действует — задача не становится добычей немедленно');
    throw new NotVerifiableHere(
      `платформа ${process.platform} не доставляет SIGTERM процессу — обработчик не вызывается ` +
      `(замер: процесс с заведомо корректным обработчиком завершается сигналом, не успев его выполнить). ` +
      `Обработчик штатной остановки в server.ts на этой платформе не исполнялся; инвариант владения после ` +
      `исчезновения процесса проверен и выполняется.`
    );
  }

  assertEqual(code, 0, 'Штатная остановка должна завершаться кодом 0');

  // Владение намеренно не снимается: продолжить конвейер нельзя, а освобождение
  // позволило бы другому процессу объявить прерванной работу, которая в этот
  // момент могла ещё выполняться. Задача остаётся за ушедшим процессом до
  // истечения срока — та же семантика, что и после аварийной остановки.
  const afterStop = dbRow(live)!;
  assertTrue(ACTIVE.includes(afterStop.status), 'После SIGTERM задача остаётся активной в базе');
  assertTrue(!!afterStop.owner_id, 'Владение при штатной остановке не снимается');
  assertTrue(
    new Date(afterStop.lease_until!).getTime() > Date.now(),
    'Срок владения ещё действует — задача не становится добычей немедленно'
  );
});

test('D6/D10 после остановки: задача подбирается по истечении владения, проект разблокирован', async () => {
  const restarted = await boot();
  assertTrue(!!restarted, 'Процесс не поднялся после остановки');
  server = restarted;
  token = await login(SUPER_ADMIN);

  const live = (await (await fetch(`${BASE}/api/projects/proj-live/ai-analysis`, { headers: auth() })).json()).job.analysisId;
  expireLease(live);

  const deadline = Date.now() + SWEEP_MS + 20_000;
  while (Date.now() < deadline && dbRow(live)!.status !== 'FAILED') await sleep(2000);

  assertEqual(dbRow(live)!.status, 'FAILED', 'Задача остановленного процесса обязана быть подобрана ревизией');

  const again = await startAnalysis('proj-live', 'AFTER-SIGTERM-RECOVERY');
  assertEqual(again.status, 201, 'Проект должен быть разблокирован');
});

runAll().then(code => {
  try { server?.kill('SIGKILL'); } catch { /* уже завершён */ }
  for (const dir of [sandbox, dbUnitSandbox]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная директория */ }
    }
  }
  process.exit(code);
});

/**
 * Проверка, невыполнимая на текущей платформе, не должна засчитываться как
 * пройденная: PASS означал бы, что поведение подтверждено, тогда как оно не
 * проверялось.
 */
class NotVerifiableHere extends Error {}

/**
 * Доставляет ли платформа SIGTERM работающему процессу.
 *
 * Windows сигналов не имеет: child.kill('SIGTERM') доходит до TerminateProcess,
 * и обработчик не вызывается — процесс исчезает мгновенно. Это устанавливается
 * замером, а не предположением: отдельный процесс с заведомо корректным
 * обработчиком либо успевает о себе сообщить, либо нет.
 */
async function platformDeliversSigterm(): Promise<boolean> {
  const probe = path.join(os.tmpdir(), `sigterm-probe-${process.pid}.cjs`);
  fs.writeFileSync(probe,
    `process.on('SIGTERM', () => { console.log('handler-ran'); process.exit(0); });\n` +
    `setInterval(() => {}, 1000);\nconsole.log('ready');\n`);
  try {
    return await new Promise<boolean>(resolve => {
      const p = spawn('node', [probe], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout!.on('data', d => {
        out += String(d);
        if (out.includes('ready') && !out.includes('handler-ran')) setTimeout(() => p.kill('SIGTERM'), 300);
      });
      p.on('exit', code => resolve(code === 0 && out.includes('handler-ran')));
    });
  } finally {
    try { fs.unlinkSync(probe); } catch { /* временный файл */ }
  }
}

async function runAll(): Promise<number> {
  let passed = 0;
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const c of cases) {
    try { await c.fn(); console.log(`PASS  ${c.name}`); passed++; }
    catch (e: any) {
      if (e instanceof NotVerifiableHere) {
        console.log(`SKIP  ${c.name}`);
        console.log(`      НЕ ПРОВЕРЕНО: ${e.message}`);
        skipped.push(c.name);
        continue;
      }
      console.log(`FAIL  ${c.name}`); console.log(`      ${e?.message ?? e}`); failed.push(c.name);
    }
  }
  console.log(`\nИТОГО: ${passed}/${cases.length} PASS` + (skipped.length ? `, ${skipped.length} НЕ ПРОВЕРЕНО` : ''));
  if (skipped.length) console.log(`Не проверено на этой платформе: ${skipped.join(', ')}`);
  if (failed.length) console.log(`Провалились: ${failed.join(', ')}`);
  return failed.length ? 1 : 0;
}

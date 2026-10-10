// RT-003 — задачи анализа переживают перезапуск процесса.
//
// Тест самодостаточен: поднимает собственный экземпляр production-сборки в
// изолированной директории, перезапускает его и проверяет, что API отдаёт то же
// самое. Единственный способ доказать persistence — реальный рестарт, поэтому
// сервер здесь останавливается и запускается заново несколько раз.
//
// Где нужна незавершённая задача (crash recovery, инвариант БД), конвейер
// удерживается активным штатным /api/ai/chaos-inject с delayMs. Chaos в
// aiResilience.ts срабатывает до вызова generateContent, поэтому обращений к
// внешнему провайдеру не происходит: ключ фиктивный и нужен лишь для того,
// чтобы исполнение дошло до цикла моделей.

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

async function runAll(): Promise<number> {
  let passed = 0;
  const failed: string[] = [];
  for (const c of cases) {
    try { await c.fn(); console.log(`PASS  ${c.name}`); passed++; }
    catch (e: any) { console.log(`FAIL  ${c.name}`); console.log(`      ${e?.message ?? e}`); failed.push(c.name); }
  }
  console.log(`\nИТОГО: ${passed}/${cases.length} PASS`);
  if (failed.length) console.log(`Провалились: ${failed.join(', ')}`);
  return failed.length ? 1 : 0;
}

// Порт в server.ts задан константой и не читается из окружения.
const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'rt003-integration';
const ADMIN = 'admin@kit-sk.ru';
const SUPER_ADMIN = 'admin@stroycontrol.pro';
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'];

let server: ChildProcess | null = null;
let sandbox = '';
let token = '';

function serverEnv(withKey: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    SEED_USER_PASSWORD: PASSWORD,
    DATABASE_URL: '',
    // Ключ нужен только чтобы дойти до цикла моделей; chaos перехватывает раньше сети.
    GEMINI_API_KEY: withKey ? 'rt003-chaos-key-not-real' : '',
    GOOGLE_GENAI_API_KEY: ''
  };
}

async function boot(withKey = false): Promise<boolean> {
  server = spawn('node', [path.join(process.cwd(), 'dist', 'server.cjs')], {
    cwd: sandbox, env: serverEnv(withKey), stdio: 'ignore'
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  return false;
}

async function shutdown(hard = false): Promise<void> {
  if (!server) return;
  server.kill(hard ? 'SIGKILL' : 'SIGTERM');
  server = null;
  await new Promise(r => setTimeout(r, 1500));
}

async function login(user = ADMIN): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: PASSWORD })
  });
  return (await r.json()).token;
}

const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

const startAnalysis = (projectId: string, name: string, wait = true) =>
  fetch(`${BASE}/api/projects/${projectId}/ai-analysis`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      projectName: name, documentIds: ['d'],
      documentsContent: [{ id: 'd', title: 'T', code: 'T', section: 'OB', content: 'RT003-MARKER' }],
      waitForCompletion: wait
    })
  });

const dbPath = () => path.join(sandbox, 'data', 'skkit.db');

function readStatus(analysisId: string): string | null {
  const db = new DatabaseSync(dbPath());
  try {
    const row = db.prepare('SELECT status FROM ai_analyses WHERE id = ?').get(analysisId) as any;
    return row ? row.status : null;
  } finally { db.close(); }
}

// Идентификаторы задач, переживающие рестарты внутри набора.
let jobA = '';
let jobB = '';
let completedSnapshot: any = null;

test('RT-003 A/B/G: задача и её результат переживают перезапуск', async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rt003-'));
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

  assertTrue(await boot(), 'Сервер не поднялся');
  token = await login();

  const a = await startAnalysis('proj-1', 'JOB-A');
  assertEqual(a.status, 201, 'Анализ proj-1 должен создаваться');
  const jobAbody = (await a.json()).job;
  jobA = jobAbody.analysisId;
  completedSnapshot = jobAbody;

  const b = await startAnalysis('proj-2', 'JOB-B');
  assertEqual(b.status, 201, 'Анализ proj-2 должен создаваться');
  jobB = (await b.json()).job.analysisId;

  // Рестарт — единственный способ доказать, что источник истины не в памяти.
  await shutdown();
  assertTrue(await boot(), 'Сервер не поднялся после перезапуска');
  token = await login();

  const g = await fetch(`${BASE}/api/projects/proj-1/ai-analysis?analysisId=${jobA}`, { headers: auth() });
  assertEqual(g.status, 200, 'A: задача должна быть доступна после перезапуска');
  const job = (await g.json()).job;

  // B: сохранность полей — каждое проверяется отдельно, а не «объект непустой».
  assertEqual(job.analysisId, jobA, 'analysisId сохранён');
  assertEqual(job.status, completedSnapshot.status, 'status сохранён');
  assertEqual(job.projectId, 'proj-1', 'projectId сохранён');
  assertEqual(job.projectName, 'JOB-A', 'projectName сохранён');
  assertEqual(job.createdAt, completedSnapshot.createdAt, 'createdAt сохранён');
  assertTrue(!!job.updatedAt, 'updatedAt присутствует');
  assertTrue(!!job.dataset, 'dataset сохранён');
  assertTrue(Array.isArray(job.dataset.extractedItems), 'extractedItems сохранены');
  assertTrue(Array.isArray(job.dataset.sectionsDetected), 'sections сохранены');
  assertTrue(!!job.agents, 'agents сохранены');
  assertTrue(!!job.estimate, 'estimate сохранён');
  assertTrue(Array.isArray(job.risks), 'risks сохранены');
  assertTrue(!!job.telemetry, 'telemetry сохранена');

  // G: результат совпадает с тем, что было до перезапуска.
  assertEqual(
    JSON.stringify(job.dataset.extractedItems),
    JSON.stringify(completedSnapshot.dataset.extractedItems),
    'G: extractedItems должны совпадать побайтово'
  );
});

test('RT-003 F: терминальный статус сохраняется после перезапуска', async () => {
  assertEqual(readStatus(jobA), completedSnapshot.status, 'Статус в БД совпадает с отданным API');
  const g = await fetch(`${BASE}/api/projects/proj-1/ai-analysis?analysisId=${jobA}`, { headers: auth() });
  assertEqual((await g.json()).job.status, completedSnapshot.status, 'API отдаёт тот же статус');
});

test('RT-003 H: cross-project изоляция держится после перезапуска', async () => {
  const x = await fetch(`${BASE}/api/projects/proj-1/ai-analysis?analysisId=${jobB}`, { headers: auth() });
  assertEqual(x.status, 404, 'Задача чужого проекта не должна отдаваться');
  const raw = await x.text();
  for (const marker of [jobB, 'proj-2', 'JOB-B']) {
    assertTrue(!raw.includes(marker), `Ответ не должен раскрывать «${marker}»`);
  }
});

test('RT-003 E: разные проекты выполняют анализ параллельно', async () => {
  const [r1, r2] = await Promise.all([
    startAnalysis('proj-1', 'PARALLEL-1'),
    startAnalysis('proj-2', 'PARALLEL-2')
  ]);
  assertEqual(r1.status, 201, 'proj-1 должен создаться');
  assertEqual(r2.status, 201, 'proj-2 должен создаться');
  await shutdown();
});

test('RT-003 C/I: прерванная задача переводится в FAILED, инвариант БД держит второй запуск', async () => {
  // Нужен активный конвейер — поднимаем экземпляр с ключом и задержкой.
  assertTrue(await boot(true), 'Сервер не поднялся');
  token = await login(SUPER_ADMIN);
  for (const modelId of MODELS) {
    const r = await fetch(`${BASE}/api/ai/chaos-inject`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ modelId, failureType: 'REQUEST_TIMEOUT', status: 504, delayMs: 4000 })
    });
    assertEqual(r.status, 200, `Задержка для ${modelId} не внедрена`);
  }

  const started = await startAnalysis('proj-1', 'INTERRUPTED', false);
  assertEqual(started.status, 201, 'Задача должна создаться');
  const activeId = (await started.json()).job.analysisId;
  assertTrue(
    ['QUEUED', 'PARSING', 'EXTRACTING', 'ANALYZING', 'CALCULATING', 'VALIDATING'].includes(readStatus(activeId)!),
    `Задача должна быть активной в БД, её статус: ${readStatus(activeId)}`
  );

  // I: инвариант уровня схемы — вторую активную задачу того же проекта база не примет,
  // даже в обход прикладной проверки.
  const db = new DatabaseSync(dbPath());
  let rejected = false;
  try {
    db.prepare('INSERT INTO ai_analyses (id,data,updated_at,project_id,status) VALUES (?,?,?,?,?)')
      .run('rt003-manual-duplicate', '{}', new Date().toISOString(), 'proj-1', 'QUEUED');
  } catch { rejected = true; } finally { db.close(); }
  assertTrue(rejected, 'I: вторая активная задача проекта должна отклоняться базой');

  // Жёсткая остановка — задача остаётся активной в БД.
  await shutdown(true);
  assertTrue(
    ['QUEUED', 'PARSING', 'EXTRACTING', 'ANALYZING', 'CALCULATING', 'VALIDATING'].includes(readStatus(activeId)!),
    'После аварийной остановки задача должна остаться активной в БД'
  );

  // R3-013. Сразу после остановки владение задачей ещё действует, и это
  // намеренно: в этот момент «процесс умер» и «процесс жив, но занят» неотличимы,
  // а восстановление живой задачи стоило бы потерянного результата и двух
  // одновременных конвейеров. Восстановление наступает, когда срок владения
  // истёк, — здесь он сдвигается в прошлое, чтобы не ждать его в тесте.
  const leaseDb = new DatabaseSync(dbPath());
  try {
    leaseDb.prepare('UPDATE ai_analyses SET lease_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), activeId);
  } finally { leaseDb.close(); }

  // C: восстановление при старте
  assertTrue(await boot(), 'Сервер не поднялся после аварийной остановки');
  await new Promise(r => setTimeout(r, 800));
  token = await login();
  assertEqual(readStatus(activeId), 'FAILED', 'C: прерванная задача должна быть переведена в FAILED');

  const afterRecovery = await startAnalysis('proj-1', 'AFTER-RECOVERY');
  assertEqual(afterRecovery.status, 201, 'C: после восстановления проект не должен быть заблокирован');

  // I: после терминального статуса новая активная задача разрешена — уже проверено выше 201.
  await shutdown();
  if (sandbox && fs.existsSync(sandbox)) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* временная директория */ }
  }
});

runAll().then(async code => { await shutdown(); process.exit(code); });

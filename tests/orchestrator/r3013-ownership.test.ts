// R3-013 — восстановление не должно трогать задачи живого процесса.
//
// Найдено независимым red-team аудитом: восстановление выполнялось до
// app.listen, поэтому второй экземпляр, поднятый на той же базе, успевал
// объявить прерванной задачу, которую прямо сейчас исполнял живой процесс.
// Тот продолжал работу, запись уходила в FAILED, освободившийся индекс позволял
// запустить для проекта второй конвейер, а первый затем падал на нарушении
// уникальности, теряя готовый результат.
//
// Проверяются два сценария с противоположным исходом:
//   живой владелец  → задача не тронута;
//   мёртвый владелец → задача переведена в FAILED, проект разблокирован.
// Если оба дадут одинаковый результат, дефект вернулся — в первом случае
// теряются данные, во втором проект остаётся заблокированным навсегда.

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

const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'r3013-integration';
const SUPER_ADMIN = 'admin@stroycontrol.pro';
const ADMIN = 'admin@kit-sk.ru';
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'];
const ACTIVE = ['QUEUED', 'PARSING', 'EXTRACTING', 'ANALYZING', 'CALCULATING', 'VALIDATING'];

let server: ChildProcess | null = null;
let sandbox = '';
let token = '';

const env = () => ({
  ...process.env,
  NODE_ENV: 'production',
  SEED_USER_PASSWORD: PASSWORD,
  DATABASE_URL: '',
  // Ключ фиктивный: chaos перехватывает вызов до обращения к сети.
  GEMINI_API_KEY: 'r3013-chaos-key-not-real',
  GOOGLE_GENAI_API_KEY: ''
});

async function boot(): Promise<ChildProcess | null> {
  const p = spawn('node', [path.join(process.cwd(), 'dist', 'server.cjs')],
    { cwd: sandbox, env: env(), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return p; }
    catch { await new Promise(r => setTimeout(r, 400)); }
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

function dbRow(analysisId: string): { status: string; owner_id: string | null; lease_until: string | null } | null {
  const db = new DatabaseSync(path.join(sandbox, 'data', 'skkit.db'));
  try {
    return db.prepare('SELECT status, owner_id, lease_until FROM ai_analyses WHERE id = ?')
      .get(analysisId) as any ?? null;
  } finally { db.close(); }
}

/** Делает владение просроченным — имитирует процесс, которого больше нет. */
function expireLease(analysisId: string): void {
  const db = new DatabaseSync(path.join(sandbox, 'data', 'skkit.db'));
  try {
    db.prepare('UPDATE ai_analyses SET lease_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), analysisId);
  } finally { db.close(); }
}

test('R3-013 живой владелец: второй процесс не трогает чужую активную задачу', async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r3013-'));
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

  server = await boot();
  assertTrue(!!server, 'Процесс A не поднялся');
  token = await login(SUPER_ADMIN);
  await holdModel(8000);

  const started = await startAnalysis('proj-1', 'LIVE-JOB');
  assertEqual(started.status, 201, 'Задача должна создаться');
  const analysisId = (await started.json()).job.analysisId;

  const before = dbRow(analysisId)!;
  assertTrue(ACTIVE.includes(before.status), `Задача должна быть активной, статус: ${before.status}`);
  assertTrue(!!before.owner_id, 'У активной задачи должен быть владелец');
  assertTrue(!!before.lease_until, 'У активной задачи должен быть срок владения');

  // Второй экземпляр на той же базе: порт занят, подняться он не сможет.
  const second = spawn('node', [path.join(process.cwd(), 'dist', 'server.cjs')],
    { cwd: sandbox, env: env(), stdio: 'ignore' });
  const exitCode: number | null = await new Promise(res => second.on('exit', c => res(c)));
  assertTrue(exitCode !== 0, `Второй экземпляр должен завершиться с ошибкой, код: ${exitCode}`);

  const after = dbRow(analysisId)!;
  assertEqual(after.status, before.status, 'Статус чужой живой задачи не должен меняться');
  assertEqual(after.owner_id, before.owner_id, 'Владелец не должен меняться');

  // Инвариант «одна активная задача на проект» не нарушен.
  const dup = await startAnalysis('proj-1', 'DUPLICATE');
  assertEqual(dup.status, 409, 'Вторая активная задача проекта должна отклоняться');
  const dupBody = await dup.text();
  assertTrue(!dupBody.includes('analysisId'), 'Ответ 409 не должен раскрывать идентификатор задачи');
});

test('R3-013 живой владелец: процесс A доводит конвейер до конца', async () => {
  const latest = await fetch(`${BASE}/api/projects/proj-1/ai-analysis`, { headers: auth() });
  assertEqual(latest.status, 200, 'Задача должна оставаться доступной');
  const job = (await latest.json()).job;
  assertTrue(
    ACTIVE.includes(job.status) || ['COMPLETED', 'FAILED'].includes(job.status),
    `Недопустимый статус после вмешательства второго процесса: ${job.status}`
  );
});

test('R3-013 мёртвый владелец: брошенная задача восстанавливается', async () => {
  // Отдельный проект, чтобы не зависеть от состояния предыдущего теста.
  await holdModel(90_000);
  const started = await startAnalysis('proj-2', 'ORPHAN-JOB');
  assertEqual(started.status, 201, 'Задача должна создаться');
  const analysisId = (await started.json()).job.analysisId;
  assertTrue(ACTIVE.includes(dbRow(analysisId)!.status), 'Задача должна быть активной');

  // Владелец исчезает вместе с процессом; срок владения истекает.
  server?.kill('SIGKILL');
  server = null;
  await new Promise(r => setTimeout(r, 1200));
  assertTrue(
    ACTIVE.includes(dbRow(analysisId)!.status),
    'После аварийной остановки задача остаётся активной в базе'
  );
  expireLease(analysisId);

  server = await boot();
  assertTrue(!!server, 'Процесс B не поднялся');
  await new Promise(r => setTimeout(r, 800));

  assertEqual(dbRow(analysisId)!.status, 'FAILED', 'Брошенная задача должна быть переведена в FAILED');

  token = await login(ADMIN);
  const again = await startAnalysis('proj-2', 'AFTER-RECOVERY');
  assertEqual(again.status, 201, 'После восстановления проект не должен быть заблокирован');

  server?.kill('SIGTERM');
  server = null;
  await new Promise(r => setTimeout(r, 800));
  if (sandbox && fs.existsSync(sandbox)) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* временная директория */ }
  }
});

runAll().then(code => {
  server?.kill('SIGTERM');
  process.exit(code);
});

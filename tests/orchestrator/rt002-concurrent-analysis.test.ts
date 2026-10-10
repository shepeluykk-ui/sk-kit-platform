// RT-002 — integration-тест правила «один проект = максимум один активный анализ».
//
// Тест самодостаточен: поднимает собственный экземпляр production-сборки в
// изолированной директории и сам создаёт условия гонки.
//
// Зачем задержанный провайдер. Без ключа модели конвейер анализа завершается за
// миллисекунды: к моменту прихода второго запроса первый job уже FAILED, двух
// активных задач не возникает, и guard корректно молчит. Чтобы проверить сам
// guard, нужна задача, которая остаётся активной достаточно долго.
//
// Задержка создаётся штатным эндпоинтом /api/ai/chaos-inject с delayMs. В
// aiResilience.ts chaos срабатывает ДО вызова generateContent, поэтому ни одного
// обращения к внешнему провайдеру не происходит: ключ задаётся фиктивный и нужен
// лишь для того, чтобы исполнение дошло до цикла моделей.

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Тест не использует общие helpers намеренно: те рассчитывают на заранее
// запущенный сервер и на SEED_USER_PASSWORD в окружении процесса тестов, тогда
// как здесь пароль задаётся собственному экземпляру сервера. Минимальный
// раннер ниже держит тест самодостаточным.

type TestFn = () => Promise<void>;
const cases: { name: string; fn: TestFn }[] = [];

function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

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
    try {
      await c.fn();
      console.log(`PASS  ${c.name}`);
      passed++;
    } catch (e: any) {
      console.log(`FAIL  ${c.name}`);
      console.log(`      ${e?.message ?? e}`);
      failed.push(c.name);
    }
  }
  console.log(`\nИТОГО: ${passed}/${cases.length} PASS`);
  if (failed.length) console.log(`Провалились: ${failed.join(', ')}`);
  return failed.length ? 1 : 0;
}

// Порт в server.ts задан константой `const PORT = 3000` и не читается из
// окружения, поэтому экземпляр всегда занимает 3000. Тест поднимает свой
// сервер, так что на этом порту не должно быть другого запущенного.
const PORT = 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'rt002-integration';
const SUPER_ADMIN = 'admin@stroycontrol.pro';
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'];
const DELAY_MS = 1500;

let server: ChildProcess | null = null;
let sandbox = '';
let token = '';

async function startServer(): Promise<boolean> {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rt002-'));
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

  server = spawn('node', [path.join(process.cwd(), 'dist', 'server.cjs')], {
    cwd: sandbox,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SEED_USER_PASSWORD: PASSWORD,
      // PORT в server.ts захардкожен; переменная передаётся для полноты окружения.
      PORT: String(PORT),
      DATABASE_URL: '',
      // Фиктивный ключ. Реальных запросов не будет — chaos ниже перехватывает
      // каждую модель раньше, чем дело дойдёт до сети.
      GEMINI_API_KEY: 'rt002-chaos-key-not-real',
      GOOGLE_GENAI_API_KEY: ''
    },
    stdio: 'ignore'
  });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

function stopServer(): void {
  if (server) { server.kill('SIGTERM'); server = null; }
  if (sandbox && fs.existsSync(sandbox)) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* временная директория */ }
  }
}

const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

const startAnalysis = (projectId: string, name: string) =>
  fetch(`${BASE}/api/projects/${projectId}/ai-analysis`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      projectName: name,
      documentIds: ['d'],
      documentsContent: [{ id: 'd', title: 'T', code: 'T', section: 'OB', content: 'x' }],
      // Без ожидания: задача должна остаться активной, пока идёт второй запрос.
      waitForCompletion: false
    })
  });

test('RT-002 setup: сервер поднят, SUPER_ADMIN аутентифицирован, задержка внедрена', async () => {
  const up = await startServer();
  assertTrue(up, `Экземпляр сервера не поднялся на ${BASE}`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SUPER_ADMIN, password: PASSWORD })
  });
  assertEqual(login.status, 200, 'SUPER_ADMIN должен аутентифицироваться');
  const body = await login.json();
  token = body.token;
  assertEqual(body.user.role, 'SUPER_ADMIN', 'Нужна роль SUPER_ADMIN: chaos-inject закрыт в production для прочих');

  for (const modelId of MODELS) {
    const r = await fetch(`${BASE}/api/ai/chaos-inject`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ modelId, failureType: 'REQUEST_TIMEOUT', status: 504, delayMs: DELAY_MS })
    });
    assertEqual(r.status, 200, `Не удалось внедрить задержку для модели ${modelId}`);
  }
});

test('RT-002: параллельный запуск одного проекта даёт 201 и 409', async () => {
  const [r1, r2] = await Promise.all([
    startAnalysis('proj-1', 'RT002-RACE-1'),
    startAnalysis('proj-1', 'RT002-RACE-2')
  ]);
  const codes = [r1.status, r2.status].sort();

  assertEqual(
    JSON.stringify(codes), JSON.stringify([201, 409]),
    `С задержанным провайдером ожидались коды [201,409], получены [${codes}]`
  );

  const created = r1.status === 201 ? await r1.json() : await r2.json();
  const rejected = r1.status === 409 ? await r1.json() : await r2.json();

  // Созданная задача действительно активна — именно это состояние блокирует вторую.
  assertTrue(
    ['QUEUED', 'PARSING', 'EXTRACTING'].includes(created.job.status),
    `Созданная задача должна быть активной, её статус: ${created.job.status}`
  );

  // Ответ 409 не раскрывает ни идентификатор задачи, ни данные проекта.
  const rejectedRaw = JSON.stringify(rejected);
  assertEqual(rejected.success, false, 'Ответ 409 должен явно сообщать об отказе');
  for (const marker of ['analysisId', 'job-ai-', 'dataset', 'extractedItems', 'projectName']) {
    assertTrue(!rejectedRaw.includes(marker), `Ответ 409 не должен содержать «${marker}»`);
  }
});

test('RT-002: пока задача активна, повторный запуск продолжает отклоняться', async () => {
  const again = await startAnalysis('proj-1', 'RT002-RACE-3');
  assertEqual(again.status, 409, 'Пока предыдущая задача активна, новый запуск должен отклоняться');
});

test('RT-002: другой проект запускается, пока первый занят', async () => {
  const other = await startAnalysis('proj-2', 'RT002-OTHER-PROJECT');
  assertEqual(other.status, 201, 'Ограничение действует в пределах проекта, а не глобально');
});

test('RT-002 teardown: после завершения задачи запуск снова разрешён', async () => {
  // Каскад из трёх моделей по DELAY_MS плюс запас на завершение конвейера.
  await new Promise(r => setTimeout(r, MODELS.length * DELAY_MS + 2000));

  const afterTerminal = await startAnalysis('proj-1', 'RT002-AFTER-TERMINAL');
  assertEqual(afterTerminal.status, 201, 'После завершения предыдущей задачи новый запуск должен проходить');

  const job = (await afterTerminal.json()).job;
  assertTrue(!!job.analysisId, 'Новая задача должна получить идентификатор');

  stopServer();
});

runAll().then(code => { stopServer(); process.exit(code); });

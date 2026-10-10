// Проверка оркестратора на LangGraph.
//
// Пилот ORCH-TEST-001: задача проходит полный цикл до DONE и оставляет
// evidence. Затем отдельно проверяется путь отказа: провал гейта возвращает
// задачу в ACTIVE, а не в BLOCKED, и BLOCKED наступает только по исчерпании
// бюджета попыток.
//
// Тесты работают с изолированным .agent-state во временной директории и не
// трогают ни реальное состояние репозитория, ни базу данных.

import fs from 'fs';
import os from 'os';
import path from 'path';

const ORIGINAL_CWD = process.cwd();
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'skkit-orch-'));

// Оркестратор берёт .agent-state относительно process.cwd(), поэтому
// песочница подменяется до импорта модулей.
process.chdir(SANDBOX);
fs.mkdirSync(path.join(SANDBOX, '.agent-state'), { recursive: true });

const {
  createTask, runTask, runUntilSettled, nextReadyTask, dependenciesSatisfied,
  blockingDependencies, promoteReady, loadTasks, getTask, readEvidence,
  loadState, budgetFor, verifierRequired, gatePlanFor, buildImplementerPacket
} = await import('../../src/server/orchestrator/index');

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

// --- Пилот: успешный путь ---------------------------------------------------
// Гейты не запускаются: задача без tests и без backend-капабилити, поэтому
// план гейтов пуст, кроме защитных. Это и есть проверка того, что лишние
// гейты не выполняются.

createTask({
  id: 'ORCH-TEST-001',
  goal: 'Пилотный прогон оркестратора',
  targets: [],
  symbols: [],
  dependencies: [],
  acceptance: ['задача доходит до DONE', 'evidence записан'],
  tests: [],
  constraints: ['не трогать реальные данные'],
  kind: 'simple',
  capabilities: ['qa']
});

let implementerCalls = 0;
let lastPacketBytes = 0;

const okAgents = {
  implementer: async (packet: any) => {
    implementerCalls += 1;
    lastPacketBytes = JSON.stringify(packet).length;
    return { claimedFiles: [], notes: 'сделано' };
  }
};

const t0 = getTask('ORCH-TEST-001')!;
check('создание задачи: начальный статус BACKLOG', t0.status === 'BACKLOG', t0.status);
check('бюджет simple = 1 попытка', t0.maxAttempts === budgetFor('simple'), String(t0.maxAttempts));

const ready = nextReadyTask();
check('задача без зависимостей переходит в READY', ready?.id === 'ORCH-TEST-001', ready?.status ?? 'нет');

const run1 = await runTask('ORCH-TEST-001', okAgents);
check('пилот доходит до DONE', run1.outcome === 'DONE', run1.outcome);
check('DONE выставлен в состоянии задачи', getTask('ORCH-TEST-001')?.status === 'DONE');
check('исполнитель вызван ровно один раз', implementerCalls === 1, String(implementerCalls));

const ev = readEvidence('ORCH-TEST-001');
check('evidence записан', ev !== null);
check('evidence: verification PASS', ev?.verification === 'PASS', ev?.verification ?? '');
check('evidence: exitCode 0', ev?.exitCode === 0, String(ev?.exitCode));
check('evidence: базовый коммит зафиксирован', typeof ev?.baseCommit === 'string');

// --- Последовательность переходов READY → ACTIVE → VERIFYING → DONE --------
// Статусы перехватываются на лету: узлы графа пишут их в tasks.json, тест
// читает файл во время работы исполнителя и верификатора.

createTask({
  id: 'ORCH-TEST-TRANSITIONS',
  goal: 'Фиксация последовательности состояний',
  targets: [], symbols: [], dependencies: [],
  acceptance: [], tests: [], constraints: [],
  kind: 'normal',                 // normal → verifierRequired только после провала
  capabilities: ['qa']
});

const seen: string[] = [];
seen.push(nextReadyTask()?.id === 'ORCH-TEST-TRANSITIONS'
  ? getTask('ORCH-TEST-TRANSITIONS')!.status   // READY
  : getTask('ORCH-TEST-TRANSITIONS')!.status);

const tracingAgents = {
  implementer: async () => {
    // Узел implement уже выставил ACTIVE до вызова исполнителя.
    seen.push(getTask('ORCH-TEST-TRANSITIONS')!.status);
    return { claimedFiles: [], notes: '' };
  },
  verifier: async () => {
    // Узел verify выставляет VERIFYING до обращения к верификатору.
    seen.push(getTask('ORCH-TEST-TRANSITIONS')!.status);
    return { objections: [] };
  }
};

// Принудительно включаем верификатор, чтобы зафиксировать VERIFYING:
// у normal-задачи он вызывается начиная со второй попытки.
const transTasks = loadTasks();
const tt = transTasks.find(t => t.id === 'ORCH-TEST-TRANSITIONS')!;
tt.attempts = 1;
fs.writeFileSync(
  path.join(SANDBOX, '.agent-state', 'tasks.json'),
  JSON.stringify(transTasks, null, 2)
);

const trans = await runTask('ORCH-TEST-TRANSITIONS', tracingAgents);
seen.push(getTask('ORCH-TEST-TRANSITIONS')!.status);

check('переход 1: READY перед запуском', seen[0] === 'READY', seen[0]);
check('переход 2: ACTIVE во время работы исполнителя', seen[1] === 'ACTIVE', seen[1]);
check('переход 3: VERIFYING во время верификации', seen[2] === 'VERIFYING', seen[2]);
check('переход 4: DONE после прохождения гейтов', seen[3] === 'DONE', seen[3]);
check('полная последовательность READY→ACTIVE→VERIFYING→DONE',
  seen.join('→') === 'READY→ACTIVE→VERIFYING→DONE', seen.join('→'));
check('итог прогона DONE', trans.outcome === 'DONE', trans.outcome);

// --- Minimum Sufficient Context --------------------------------------------

const packet = buildImplementerPacket(getTask('ORCH-TEST-001')!);
const packetKeys = Object.keys(packet);
check(
  'пакет агента не содержит истории и backlog',
  !packetKeys.some(k => /history|backlog|messages|report/i.test(k)),
  packetKeys.join(',')
);
check('пакет компактный (< 4 КБ на пустой задаче)', lastPacketBytes < 4096, `${lastPacketBytes} байт`);

// --- Гейты подбираются под задачу ------------------------------------------

check(
  'для qa-задачи без тестов лишние гейты не планируются',
  gatePlanFor(getTask('ORCH-TEST-001')!).length === 0,
  gatePlanFor(getTask('ORCH-TEST-001')!).join(',')
);
check(
  'security-задача требует верификатора',
  verifierRequired({ ...getTask('ORCH-TEST-001')!, kind: 'security' } as any)
);
check(
  'простая задача верификатора не требует',
  !verifierRequired(getTask('ORCH-TEST-001')!)
);

// --- Агент не может самостоятельно объявить задачу выполненной -------------
// Исполнитель возвращает уверенное «готово, тесты проходят», но гейт падает.
// Итог определяют коды возврата, а не текст агента.

createTask({
  id: 'ORCH-TEST-NO-SELF-DONE',
  goal: 'Агент заявляет успех при падающем гейте',
  targets: [],
  symbols: [],
  dependencies: [],
  acceptance: ['DONE выставляется только по машинным гейтам'],
  tests: ['definitely-missing-script'],   // гейт заведомо упадёт
  constraints: [],
  kind: 'normal',
  capabilities: ['qa']
});

const lyingAgents = {
  implementer: async () => ({
    claimedFiles: ['всё готово'],
    notes: 'DONE. fixed. tests pass. looks good.'
  }),
  verifier: async () => ({ objections: [] })   // верификатор тоже не возражает
};

const lie = await runTask('ORCH-TEST-NO-SELF-DONE', lyingAgents);
check(
  'заявление агента об успехе не даёт DONE при падающем гейте',
  lie.outcome !== 'DONE',
  lie.outcome
);
check(
  'статус задачи не DONE',
  getTask('ORCH-TEST-NO-SELF-DONE')?.status !== 'DONE',
  getTask('ORCH-TEST-NO-SELF-DONE')?.status ?? ''
);
check(
  'evidence фиксирует verification FAIL',
  readEvidence('ORCH-TEST-NO-SELF-DONE')?.verification === 'FAIL'
);

// --- Граф зависимостей ------------------------------------------------------

createTask({
  id: 'ORCH-TEST-DEP',
  goal: 'Зависимая задача',
  targets: [], symbols: [],
  dependencies: ['ORCH-TEST-BLOCKER'],
  acceptance: [], tests: [], constraints: [],
  kind: 'simple', capabilities: ['qa']
});
createTask({
  id: 'ORCH-TEST-BLOCKER',
  goal: 'Блокирующая задача',
  targets: [], symbols: [], dependencies: [],
  acceptance: [], tests: [], constraints: [],
  kind: 'simple', capabilities: ['qa']
});

const dep = getTask('ORCH-TEST-DEP')!;
check('зависимость не выполнена — задача не готова', !dependenciesSatisfied(dep));
check('блокирующая зависимость определена', blockingDependencies(dep).includes('ORCH-TEST-BLOCKER'));

promoteReady();
check(
  'задача с незакрытой зависимостью остаётся в BACKLOG',
  getTask('ORCH-TEST-DEP')?.status === 'BACKLOG',
  getTask('ORCH-TEST-DEP')?.status ?? ''
);

await runTask('ORCH-TEST-BLOCKER', okAgents);
promoteReady();
check(
  'после закрытия зависимости задача переходит в READY',
  getTask('ORCH-TEST-DEP')?.status === 'READY',
  getTask('ORCH-TEST-DEP')?.status ?? ''
);

// --- Путь отказа: FAIL → ACTIVE → повтор → DONE ----------------------------
// Гейт scope сработает на изменении вне targets. Первый проход падает,
// второй — проходит.

const scopeViolation = path.join(SANDBOX, 'outside-scope.txt');

createTask({
  id: 'ORCH-TEST-RETRY',
  goal: 'Проверка пути отказа и повтора',
  targets: ['allowed.txt'],
  symbols: [],
  dependencies: [],
  acceptance: ['изменения не выходят за targets'],
  tests: [],
  constraints: [],
  kind: 'normal',          // бюджет 3 попытки
  capabilities: ['qa']
});

let attempt = 0;
const flakyAgents = {
  implementer: async () => {
    attempt += 1;
    if (attempt === 1) {
      // Первая попытка выходит за пределы targets — гейт scope обязан это поймать.
      fs.writeFileSync(scopeViolation, 'вне scope');
    } else {
      fs.rmSync(scopeViolation, { force: true });
    }
    return { claimedFiles: [], notes: '' };
  }
};

// В песочнице git-репозитория нет, поэтому gateScope не увидит изменений.
// Путь отказа проверяется через провал гейта тестов на несуществующем скрипте.
const failingTaskId = 'ORCH-TEST-RETRY';
const tasksNow = loadTasks();
const retryTask = tasksNow.find(t => t.id === failingTaskId)!;
retryTask.tests = ['definitely-missing-script'];
fs.writeFileSync(
  path.join(SANDBOX, '.agent-state', 'tasks.json'),
  JSON.stringify(tasksNow, null, 2)
);

const runFail = await runTask(failingTaskId, flakyAgents);
check(
  'провал гейта возвращает задачу в ACTIVE, а не BLOCKED',
  runFail.outcome === 'ACTIVE',
  runFail.outcome
);
check('счётчик попыток увеличен', getTask(failingTaskId)?.attempts === 1, String(getTask(failingTaskId)?.attempts));
check('причина провала сохранена', Boolean(getTask(failingTaskId)?.lastFailure));

const runBlocked = await runUntilSettled(failingTaskId, flakyAgents);
check(
  'BLOCKED наступает только после исчерпания бюджета',
  runBlocked.outcome === 'BLOCKED',
  runBlocked.outcome
);
check(
  'число попыток равно бюджету',
  getTask(failingTaskId)?.attempts === budgetFor('normal'),
  `${getTask(failingTaskId)?.attempts} из ${budgetFor('normal')}`
);
check('evidence отказа записан', readEvidence(failingTaskId)?.verification === 'FAIL');

// --- Восстановление состояния после перезапуска ----------------------------

const stateBefore = loadState();
const tasksBefore = loadTasks().length;

// Повторный импорт эмулирует новый процесс: состояние читается с диска.
const fresh = await import(`../../src/server/orchestrator/index?reload=${Date.now()}`);
check('состояние переживает перезапуск: задачи', fresh.loadTasks().length === tasksBefore);
check(
  'состояние переживает перезапуск: счётчик прогонов',
  fresh.loadState().runs === stateBefore.runs,
  `${fresh.loadState().runs} против ${stateBefore.runs}`
);
check('ORCH-TEST-001 остаётся DONE после перезапуска', fresh.getTask('ORCH-TEST-001')?.status === 'DONE');

// --- Итог -------------------------------------------------------------------

process.chdir(ORIGINAL_CWD);
fs.rmSync(SANDBOX, { recursive: true, force: true });

const passed = results.filter(r => r.ok).length;
console.log(`\nИТОГО: ${passed}/${results.length} PASS`);
if (passed !== results.length) {
  console.log('Провалились: ' + results.filter(r => !r.ok).map(r => r.name).join(', '));
}
process.exit(passed === results.length ? 0 : 1);

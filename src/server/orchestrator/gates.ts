// Машинные гейты. Только они решают, выполнена задача или нет.
//
// Ни один из гейтов не спрашивает LLM. Источник истины — код возврата
// процесса и фактическое состояние git. Текст агента («готово», «тесты
// проходят») здесь не учитывается вообще.

import { spawnSync } from 'child_process';

export type GateStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface GateResult {
  name: string;
  status: GateStatus;
  exitCode: number | null;
  detail: string;
}

const REPO = process.cwd();

function run(cmd: string, args: string[], timeoutMs = 600_000) {
  return spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    shell: true,
    timeout: timeoutMs,
    env: process.env
  });
}

/** Компиляция бэкенда. Ошибки фронтенда не учитываются — они вне контура оркестратора. */
export function gateTypecheck(scope: 'backend' | 'all' = 'backend'): GateResult {
  const r = run('npx', ['tsc', '--noEmit']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const lines = out.split('\n').filter(l => /error TS/.test(l));
  const relevant = scope === 'backend'
    ? lines.filter(l => /^(server\.ts|src[\\/]server[\\/])/.test(l))
    : lines;

  return {
    name: `typecheck:${scope}`,
    status: relevant.length === 0 ? 'PASS' : 'FAIL',
    exitCode: r.status,
    detail: relevant.length === 0
      ? '0 ошибок'
      : `${relevant.length} ошибок: ${relevant.slice(0, 3).join(' | ').slice(0, 300)}`
  };
}

export function gateBuild(): GateResult {
  const r = run('npm', ['run', 'build']);
  return {
    name: 'build',
    status: r.status === 0 ? 'PASS' : 'FAIL',
    exitCode: r.status,
    detail: r.status === 0 ? 'сборка успешна' : `${r.stderr || r.stdout || ''}`.slice(-300)
  };
}

/**
 * Прогон именованного npm-скрипта. Код возврата — единственный критерий.
 * Сводка вытаскивается из вывода только для evidence, на вердикт не влияет.
 */
export function gateTest(script: string, env: NodeJS.ProcessEnv = {}): GateResult {
  const r = spawnSync('npm', ['run', script], {
    cwd: REPO, encoding: 'utf8', shell: true, timeout: 600_000,
    env: { ...process.env, ...env }
  });
  const out = `${r.stdout || ''}`;
  const summary = (out.match(/ИТОГО: [^\n]*/) || [])[0];
  return {
    name: `test:${script}`,
    status: r.status === 0 ? 'PASS' : 'FAIL',
    exitCode: r.status,
    detail: summary || `${r.stderr || out}`.slice(-300)
  };
}

export function changedFiles(): string[] {
  const r = run('git', ['status', '--porcelain']);
  return (r.stdout || '')
    .split('\n')
    .map(l => l.slice(3).trim())
    .filter(Boolean);
}

export function headCommit(): string {
  const r = run('git', ['rev-parse', 'HEAD']);
  return (r.stdout || '').trim();
}

export function diffStat(): string {
  const r = run('git', ['diff', '--stat']);
  return (r.stdout || '').trim();
}

/**
 * Изменения не должны выходить за пределы targets задачи.
 * Это защита от агента, который «заодно» поправил что-то ещё.
 */
export function gateScope(targets: string[]): GateResult {
  if (targets.length === 0) {
    return { name: 'scope', status: 'SKIPPED', exitCode: null, detail: 'targets не заданы' };
  }
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^"+|"+$/g, '');
  const allowed = targets.map(norm);
  const touched = changedFiles().map(norm);
  const outside = touched.filter(f => !allowed.some(a => f === a || f.startsWith(`${a}/`)));

  return {
    name: 'scope',
    status: outside.length === 0 ? 'PASS' : 'FAIL',
    exitCode: null,
    detail: outside.length === 0
      ? `изменения в пределах ${allowed.length} целей`
      : `вне scope: ${outside.slice(0, 5).join(', ')}`
  };
}

/**
 * Защитный гейт: запрещённые пути не должны попадать в изменения.
 * Реальная БД, .env и секреты не трогаются ни при каких условиях.
 */
export function gateProtectedPaths(): GateResult {
  const forbidden = ['.env', 'data/skkit.db', 'data/skkit.db-wal', 'data/skkit.db-shm'];
  const touched = changedFiles().map(f => f.replace(/\\/g, '/'));
  const hits = touched.filter(f => forbidden.some(p => f === p || f.endsWith(`/${p}`)));
  return {
    name: 'protected-paths',
    status: hits.length === 0 ? 'PASS' : 'FAIL',
    exitCode: null,
    detail: hits.length === 0 ? 'защищённые пути не затронуты' : `затронуто: ${hits.join(', ')}`
  };
}

export function allPassed(results: GateResult[]): boolean {
  return results.every(r => r.status !== 'FAIL');
}

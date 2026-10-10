// Состояние оркестратора и его персистентность.
//
// Runtime-состояние живёт в .agent-state/*.json. Существующие Markdown-файлы
// (TEAM.md, DECISIONS.md, BLOCKERS.md и т.д.) остаются нетронутыми: это
// человекочитаемые записи, а не источник истины для машины. Оркестратор их
// не читает и не перезаписывает.

import fs from 'fs';
import path from 'path';

export const AGENT_STATE_DIR = path.join(process.cwd(), '.agent-state');
export const EVIDENCE_DIR = path.join(AGENT_STATE_DIR, 'evidence');

const STATE_FILE = path.join(AGENT_STATE_DIR, 'state.json');
const TASKS_FILE = path.join(AGENT_STATE_DIR, 'tasks.json');
const DEPS_FILE = path.join(AGENT_STATE_DIR, 'dependencies.json');

export type TaskStatus =
  | 'BACKLOG'
  | 'READY'
  | 'ACTIVE'
  | 'VERIFYING'
  | 'DONE'
  | 'BLOCKED';

export type Capability =
  | 'backend' | 'frontend' | 'database' | 'security'
  | 'qa' | 'e2e' | 'mobile' | 'ux' | 'devops' | 'architecture';

export type TaskKind = 'simple' | 'normal' | 'complex' | 'security' | 'architecture';

/** Контракт задачи — единственное, что получает агент (Minimum Sufficient Context). */
export interface TaskContract {
  id: string;
  goal: string;
  targets: string[];      // файлы, которые разрешено менять
  symbols: string[];      // функции/классы в фокусе
  dependencies: string[]; // id других задач
  acceptance: string[];   // критерии приёмки, проверяемые машиной
  tests: string[];        // npm-скрипты или команды
  constraints: string[];
}

export interface Task extends TaskContract {
  status: TaskStatus;
  kind: TaskKind;
  capabilities: Capability[];
  attempts: number;
  maxAttempts: number;
  lastFailure?: string;
  updatedAt: string;
}

export interface OrchestratorState {
  version: 1;
  updatedAt: string;
  currentTaskId: string | null;
  /** Счётчик прогонов — позволяет убедиться, что resume читает сохранённое, а не создаёт заново. */
  runs: number;
}

function ensureDirs(): void {
  for (const d of [AGENT_STATE_DIR, EVIDENCE_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Запись через временный файл: прерывание процесса не оставляет обрезанный JSON. */
function writeJson(file: string, data: unknown): void {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadState(): OrchestratorState {
  return readJson<OrchestratorState>(STATE_FILE, {
    version: 1,
    updatedAt: new Date().toISOString(),
    currentTaskId: null,
    runs: 0
  });
}

export function saveState(state: OrchestratorState): void {
  writeJson(STATE_FILE, { ...state, updatedAt: new Date().toISOString() });
}

export function loadTasks(): Task[] {
  return readJson<Task[]>(TASKS_FILE, []);
}

export function saveTasks(tasks: Task[]): void {
  writeJson(TASKS_FILE, tasks);
}

/** Граф зависимостей хранится отдельно: его читают и планировщик, и отчётность. */
export function loadDependencies(): Record<string, string[]> {
  return readJson<Record<string, string[]>>(DEPS_FILE, {});
}

export function saveDependencies(deps: Record<string, string[]>): void {
  writeJson(DEPS_FILE, deps);
}

export function upsertTask(task: Task): Task[] {
  const tasks = loadTasks();
  const i = tasks.findIndex(t => t.id === task.id);
  if (i >= 0) tasks[i] = task; else tasks.push(task);
  saveTasks(tasks);

  const deps = loadDependencies();
  deps[task.id] = task.dependencies;
  saveDependencies(deps);

  return tasks;
}

export function getTask(id: string): Task | undefined {
  return loadTasks().find(t => t.id === id);
}

export function setStatus(id: string, status: TaskStatus, lastFailure?: string): Task | undefined {
  const tasks = loadTasks();
  const t = tasks.find(x => x.id === id);
  if (!t) return undefined;
  t.status = status;
  t.updatedAt = new Date().toISOString();
  if (lastFailure !== undefined) t.lastFailure = lastFailure;
  saveTasks(tasks);
  return t;
}

/** Бюджет попыток по типу задачи. adaptive-типы получают больший, но конечный лимит. */
export function budgetFor(kind: TaskKind): number {
  switch (kind) {
    case 'simple': return 1;
    case 'normal': return 3;
    case 'complex': return 5;
    case 'security': return 5;
    case 'architecture': return 5;
  }
}

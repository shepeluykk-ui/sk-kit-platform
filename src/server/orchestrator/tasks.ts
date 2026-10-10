// Планировщик задач: граф зависимостей и допуск в работу.
//
// Решения здесь детерминированные — никаких обращений к LLM. Готовность
// задачи определяется состоянием её зависимостей, а не чьим-то суждением.

import {
  budgetFor, getTask, loadTasks, saveTasks, setStatus, upsertTask,
  type Capability, type Task, type TaskContract, type TaskKind, type TaskStatus
} from './state';

export interface CreateTaskInput extends TaskContract {
  kind?: TaskKind;
  capabilities?: Capability[];
}

export function createTask(input: CreateTaskInput): Task {
  const kind = input.kind ?? 'normal';
  const task: Task = {
    ...input,
    kind,
    capabilities: input.capabilities ?? ['backend'],
    status: 'BACKLOG',
    attempts: 0,
    maxAttempts: budgetFor(kind),
    updatedAt: new Date().toISOString()
  };
  upsertTask(task);
  return task;
}

/** Зависимость считается выполненной, только если она DONE. */
export function dependenciesSatisfied(task: Task, all: Task[] = loadTasks()): boolean {
  return task.dependencies.every(depId => {
    const dep = all.find(t => t.id === depId);
    return dep?.status === 'DONE';
  });
}

export function blockingDependencies(task: Task, all: Task[] = loadTasks()): string[] {
  return task.dependencies.filter(depId => {
    const dep = all.find(t => t.id === depId);
    return dep?.status !== 'DONE';
  });
}

/**
 * Перевод BACKLOG → READY для всех задач, чьи зависимости закрыты.
 * Возвращает id задач, сменивших статус.
 */
export function promoteReady(): string[] {
  const tasks = loadTasks();
  const promoted: string[] = [];
  for (const t of tasks) {
    if (t.status === 'BACKLOG' && dependenciesSatisfied(t, tasks)) {
      t.status = 'READY';
      t.updatedAt = new Date().toISOString();
      promoted.push(t.id);
    }
  }
  if (promoted.length > 0) saveTasks(tasks);
  return promoted;
}

/** Следующая задача в работу: первая READY. Задачи с незакрытыми зависимостями не выбираются. */
export function nextReadyTask(): Task | undefined {
  promoteReady();
  const tasks = loadTasks();
  return tasks.find(t => t.status === 'READY' && dependenciesSatisfied(t, tasks));
}

export function markActive(id: string): Task | undefined {
  return setStatus(id, 'ACTIVE');
}

export function markVerifying(id: string): Task | undefined {
  return setStatus(id, 'VERIFYING');
}

export function markDone(id: string): Task | undefined {
  return setStatus(id, 'DONE');
}

/**
 * Провал проверки. Обычный упавший тест возвращает задачу в ACTIVE для
 * повторной попытки; BLOCKED выставляется только когда бюджет попыток исчерпан.
 */
export function registerFailure(id: string, reason: string): { task: Task | undefined; status: TaskStatus } {
  const tasks = loadTasks();
  const t = tasks.find(x => x.id === id);
  if (!t) return { task: undefined, status: 'BLOCKED' };

  t.attempts += 1;
  t.lastFailure = reason.slice(0, 500);
  t.status = t.attempts >= t.maxAttempts ? 'BLOCKED' : 'ACTIVE';
  t.updatedAt = new Date().toISOString();
  saveTasks(tasks);

  return { task: t, status: t.status };
}

// Пересчёта плана нет по построению: граф не перепланирует очередь после
// задачи, а nextReadyTask() каждый раз берёт следующую задачу, чьи зависимости
// закрыты. Отдельная функция «нужен ли re-plan» была бы абстракцией над
// поведением, которого здесь нет.

export { getTask, loadTasks };

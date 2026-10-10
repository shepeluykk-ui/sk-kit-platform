// Исполняющие роли.
//
// Их ровно две: IMPLEMENTER и VERIFIER. Постоянно работающих агентов нет —
// роль создаётся под задачу и завершается вместе с ней. Специализации
// (backend, security, qa, …) — это признаки задачи, а не отдельные процессы:
// они влияют на набор гейтов, а не на количество запущенных агентов.
//
// Сам вызов LLM вынесен за интерфейс: оркестратор работает с результатом,
// а не с моделью. Это позволяет подставить реального агента, ручной прогон
// или детерминированную функцию, не меняя граф.

import type { ImplementerPacket, VerifierPacket } from './context';
import type { Capability, Task } from './state';

export interface ImplementerResult {
  /** Какие файлы агент заявляет изменёнными. Проверяется гейтами, на веру не берётся. */
  claimedFiles: string[];
  notes: string;
}

export interface VerifierResult {
  /**
   * Мнение верификатора. Не является основанием для DONE: итог определяют
   * машинные гейты. Учитывается только как дополнительный отказ.
   */
  objections: string[];
}

export type ImplementerFn = (packet: ImplementerPacket) => Promise<ImplementerResult>;
export type VerifierFn = (packet: VerifierPacket) => Promise<VerifierResult>;

export interface AgentRegistry {
  implementer: ImplementerFn;
  verifier?: VerifierFn;
}

/**
 * Нужен ли отдельный верификатор.
 * Для простых задач машинных гейтов достаточно — лишний вызов LLM не делаем.
 */
export function verifierRequired(task: Task): boolean {
  if (task.kind === 'security' || task.kind === 'architecture') return true;
  if (task.capabilities.includes('security')) return true;
  if (task.kind === 'simple') return false;
  return task.attempts > 0; // после первого провала — да
}


/** Гейты подбираются под специализацию: лишние не запускаются. */
export function gatePlanFor(task: Task): Array<'typecheck' | 'build' | 'tests' | 'security-tests' | 'e2e'> {
  const plan: Array<'typecheck' | 'build' | 'tests' | 'security-tests' | 'e2e'> = [];
  const caps = new Set<Capability>(task.capabilities);

  if (caps.has('backend') || caps.has('database') || caps.has('architecture') || caps.has('security')) {
    plan.push('typecheck');
  }
  if (caps.has('frontend') || caps.has('ux') || caps.has('mobile') || caps.has('devops')) {
    plan.push('build');
  }
  if (task.tests.length > 0) plan.push('tests');
  if (caps.has('security') || task.kind === 'security') plan.push('security-tests');
  if (caps.has('e2e')) plan.push('e2e');

  return plan;
}

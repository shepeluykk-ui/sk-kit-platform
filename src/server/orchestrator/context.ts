// Сборка Minimum Sufficient Context.
//
// Агент получает контракт задачи и ничего сверх него. Ни истории диалога, ни
// прошлых отчётов, ни полного backlog, ни содержимого .agent-state. Контекст
// расширяется только тогда, когда обнаружена фактическая зависимость.

import fs from 'fs';
import path from 'path';
import type { Task } from './state';

const MAX_FILE_CHARS = 8_000;

export interface ImplementerPacket {
  id: string;
  goal: string;
  targets: string[];
  symbols: string[];
  acceptance: string[];
  tests: string[];
  constraints: string[];
  /** Содержимое только тех файлов, что перечислены в targets. */
  files: Array<{ path: string; content: string; truncated: boolean }>;
  /** Заполняется только при повторной попытке: чем именно закончился прошлый заход. */
  previousFailure?: string;
}

export interface VerifierPacket {
  id: string;
  goal: string;
  acceptance: string[];
  constraints: string[];
  changedFiles: string[];
  diff: string;
  testResults: Array<{ name: string; status: string; detail: string }>;
  securityRequired: boolean;
}

function readTarget(rel: string): { path: string; content: string; truncated: boolean } | null {
  const abs = path.join(process.cwd(), rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  return {
    path: rel,
    content: raw.slice(0, MAX_FILE_CHARS),
    truncated: raw.length > MAX_FILE_CHARS
  };
}

export function buildImplementerPacket(task: Task): ImplementerPacket {
  const files = task.targets
    .map(readTarget)
    .filter((f): f is NonNullable<typeof f> => f !== null);

  return {
    id: task.id,
    goal: task.goal,
    targets: task.targets,
    symbols: task.symbols,
    acceptance: task.acceptance,
    tests: task.tests,
    constraints: task.constraints,
    files,
    previousFailure: task.attempts > 0 ? task.lastFailure : undefined
  };
}

/**
 * Пакет верификатора намеренно не содержит рассуждений исполнителя —
 * только контракт и фактическое состояние репозитория.
 */
export function buildVerifierPacket(
  task: Task,
  changed: string[],
  diff: string,
  testResults: Array<{ name: string; status: string; detail: string }>
): VerifierPacket {
  return {
    id: task.id,
    goal: task.goal,
    acceptance: task.acceptance,
    constraints: task.constraints,
    changedFiles: changed,
    diff: diff.slice(0, 12_000),
    testResults,
    securityRequired: task.kind === 'security' || task.capabilities.includes('security')
  };
}

/** Грубая оценка объёма пакета — используется в evidence для контроля расхода контекста. */
export function packetSize(packet: unknown): number {
  return JSON.stringify(packet).length;
}

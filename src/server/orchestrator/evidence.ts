// Evidence — компактная машинная запись результата задачи.
//
// Достаточна для восстановления состояния: по какому коммиту работали, что
// изменилось, какие гейты отработали и с каким кодом возврата. Текстовых
// отчётов здесь нет.

import fs from 'fs';
import path from 'path';
import { EVIDENCE_DIR } from './state';
import type { GateResult } from './gates';

export interface Evidence {
  taskId: string;
  baseCommit: string;
  resultCommit: string;
  changedFiles: string[];
  tests: Array<{ name: string; status: string; exitCode: number | null; detail: string }>;
  exitCode: number;
  build: 'PASS' | 'FAIL' | 'SKIPPED';
  verification: 'PASS' | 'FAIL';
  attempts: number;
  /** Размер пакета, переданного агенту, — контроль расхода контекста. */
  contextBytes: number;
  finishedAt: string;
}

export function writeEvidence(ev: Evidence): string {
  if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${ev.taskId}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ev, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readEvidence(taskId: string): Evidence | null {
  const file = path.join(EVIDENCE_DIR, `${taskId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Evidence;
  } catch {
    return null;
  }
}

export function gatesToEvidenceTests(gates: GateResult[]): Evidence['tests'] {
  return gates.map(g => ({
    name: g.name,
    status: g.status,
    exitCode: g.exitCode,
    detail: g.detail.slice(0, 200)
  }));
}

export function buildStatusOf(gates: GateResult[]): Evidence['build'] {
  const g = gates.find(x => x.name === 'build');
  if (!g) return 'SKIPPED';
  return g.status === 'PASS' ? 'PASS' : 'FAIL';
}

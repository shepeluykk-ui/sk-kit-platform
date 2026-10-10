// Публичный интерфейс оркестратора.
//
// Модуль самодостаточен: server.ts его не импортирует и от него не зависит.
// Это сделано намеренно — оркестратор управляет разработкой репозитория, а не
// обслуживает HTTP-запросы, и не должен влиять на работу приложения.

export { runTask, runUntilSettled, buildOrchestrationGraph } from './graph';
export type { RunResult } from './graph';

export {
  createTask, nextReadyTask, promoteReady, dependenciesSatisfied,
  blockingDependencies, registerFailure, loadTasks, getTask
} from './tasks';

export {
  loadState, saveState, loadDependencies, budgetFor,
  type Task, type TaskContract, type TaskStatus, type TaskKind, type Capability
} from './state';

export {
  gateTypecheck, gateBuild, gateTest, gateScope,
  gateProtectedPaths, allPassed, changedFiles, diffStat, headCommit,
  type GateResult
} from './gates';

export { buildImplementerPacket, buildVerifierPacket, packetSize } from './context';
export type { ImplementerPacket, VerifierPacket } from './context';

export { verifierRequired, gatePlanFor } from './agents';
export type { AgentRegistry, ImplementerFn, VerifierFn, ImplementerResult, VerifierResult } from './agents';

export { writeEvidence, readEvidence, type Evidence } from './evidence';

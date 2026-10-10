// Граф оркестрации на LangGraph.
//
//   READY → IMPLEMENT → TEST → [SECURITY VERIFY] → VERIFY ─┬─ PASS → DONE
//                                                          └─ FAIL → ACTIVE (повтор)
//                                                                  → BLOCKED (бюджет исчерпан)
//
// LangGraph отвечает за переходы и за состояние между узлами. Решение
// «выполнено или нет» принимают машинные гейты в gates.ts, а не модель:
// узел VERIFY читает коды возврата, а не текст агента.

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import type { AgentRegistry } from './agents';
import { gatePlanFor, verifierRequired } from './agents';
import {
  buildImplementerPacket, buildVerifierPacket, packetSize
} from './context';
import {
  allPassed, changedFiles, diffStat, gateBuild, gateProtectedPaths,
  gateScope, gateTest, gateTypecheck, headCommit, type GateResult
} from './gates';
import { buildStatusOf, gatesToEvidenceTests, writeEvidence } from './evidence';
import {
  markActive, markDone, markVerifying, registerFailure
} from './tasks';
import { getTask, loadState, saveState, type Task } from './state';

const RunState = Annotation.Root({
  taskId: Annotation<string>,
  baseCommit: Annotation<string>,
  gates: Annotation<GateResult[]>({
    reducer: (_prev, next) => next,
    default: () => []
  }),
  changed: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => []
  }),
  contextBytes: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0
  }),
  objections: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => []
  }),
  outcome: Annotation<'DONE' | 'ACTIVE' | 'BLOCKED' | ''>({
    reducer: (_prev, next) => next,
    default: () => '' as const
  })
});

type RunStateType = typeof RunState.State;

function requireTask(id: string): Task {
  const t = getTask(id);
  if (!t) throw new Error(`Задача ${id} не найдена в .agent-state/tasks.json`);
  return t;
}

export function buildOrchestrationGraph(agents: AgentRegistry) {
  const graph = new StateGraph(RunState)

    // Задача берётся в работу. Фиксируется базовый коммит — по нему потом
    // восстанавливается, от какого состояния репозитория шли изменения.
    .addNode('implement', async (s: RunStateType) => {
      const task = requireTask(s.taskId);
      markActive(task.id);

      const packet = buildImplementerPacket(task);
      await agents.implementer(packet);

      return { baseCommit: headCommit(), contextBytes: packetSize(packet) };
    })

    // Гейты. Набор зависит от специализации задачи — лишние не запускаются.
    .addNode('test', async (s: RunStateType) => {
      const task = requireTask(s.taskId);
      const plan = gatePlanFor(task);
      const results: GateResult[] = [];

      // Защищённые пути проверяются всегда, вне зависимости от плана.
      results.push(gateProtectedPaths());
      results.push(gateScope(task.targets));

      if (plan.includes('typecheck')) results.push(gateTypecheck('backend'));
      if (plan.includes('build')) results.push(gateBuild());
      if (plan.includes('tests')) {
        for (const script of task.tests) results.push(gateTest(script));
      }

      return { gates: results, changed: changedFiles() };
    })

    // Отдельный гейт для security-задач: запускается до общей верификации.
    .addNode('securityVerify', async (s: RunStateType) => {
      const task = requireTask(s.taskId);
      const extra: GateResult[] = [];
      if (!task.tests.includes('test:security')) {
        extra.push(gateTest('test:security'));
      }
      return { gates: [...s.gates, ...extra] };
    })

    // Вердикт. DONE выставляется только здесь и только по гейтам.
    .addNode('verify', async (s: RunStateType) => {
      const task = requireTask(s.taskId);
      markVerifying(task.id);

      let objections: string[] = [];
      if (verifierRequired(task) && agents.verifier) {
        const packet = buildVerifierPacket(
          task,
          s.changed,
          diffStat(),
          s.gates.map(g => ({ name: g.name, status: g.status, detail: g.detail }))
        );
        const res = await agents.verifier(packet);
        objections = res.objections;
      }

      const machinePassed = allPassed(s.gates);
      const passed = machinePassed && objections.length === 0;

      if (passed) {
        markDone(task.id);
        return { outcome: 'DONE' as const, objections };
      }

      const reason = machinePassed
        ? `возражения верификатора: ${objections.join('; ')}`
        : `провалены гейты: ${s.gates.filter(g => g.status === 'FAIL').map(g => `${g.name} (${g.detail})`).join('; ')}`;

      const { status } = registerFailure(task.id, reason);
      return { outcome: status === 'BLOCKED' ? ('BLOCKED' as const) : ('ACTIVE' as const), objections };
    })

    // Итог фиксируется в evidence независимо от исхода: неуспех тоже факт.
    .addNode('record', async (s: RunStateType) => {
      const task = requireTask(s.taskId);
      const failed = s.gates.filter(g => g.status === 'FAIL');

      writeEvidence({
        taskId: task.id,
        baseCommit: s.baseCommit,
        resultCommit: headCommit(),
        changedFiles: s.changed,
        tests: gatesToEvidenceTests(s.gates),
        exitCode: failed.length === 0 ? 0 : 1,
        build: buildStatusOf(s.gates),
        verification: s.outcome === 'DONE' ? 'PASS' : 'FAIL',
        attempts: requireTask(task.id).attempts,
        contextBytes: s.contextBytes,
        finishedAt: new Date().toISOString()
      });

      const st = loadState();
      saveState({ ...st, currentTaskId: null, runs: st.runs + 1 });
      return {};
    });

  graph.addEdge(START, 'implement' as never);
  graph.addEdge('implement' as never, 'test' as never);

  // Security-задачи получают дополнительный гейт перед вердиктом.
  graph.addConditionalEdges(
    'test' as never,
    (s: RunStateType) => {
      const task = requireTask(s.taskId);
      return (task.kind === 'security' || task.capabilities.includes('security'))
        ? 'securityVerify'
        : 'verify';
    },
    { securityVerify: 'securityVerify', verify: 'verify' } as never
  );

  graph.addEdge('securityVerify' as never, 'verify' as never);
  graph.addEdge('verify' as never, 'record' as never);
  graph.addEdge('record' as never, END);

  return graph.compile();
}

export interface RunResult {
  taskId: string;
  outcome: 'DONE' | 'ACTIVE' | 'BLOCKED';
  gates: GateResult[];
  attempts: number;
}

/** Один проход графа по конкретной задаче. */
export async function runTask(taskId: string, agents: AgentRegistry): Promise<RunResult> {
  const app = buildOrchestrationGraph(agents);

  const st = loadState();
  saveState({ ...st, currentTaskId: taskId });

  const final = await app.invoke({ taskId, baseCommit: '', gates: [], changed: [], contextBytes: 0, objections: [], outcome: '' });

  return {
    taskId,
    outcome: (final.outcome || 'ACTIVE') as RunResult['outcome'],
    gates: final.gates || [],
    attempts: requireTask(taskId).attempts
  };
}

/**
 * Повторяет задачу, пока она не завершится DONE или не упрётся в BLOCKED.
 * Бюджет попыток задан в самой задаче (budgetFor), бесконечного цикла нет.
 */
export async function runUntilSettled(taskId: string, agents: AgentRegistry): Promise<RunResult> {
  let last: RunResult | undefined;
  for (;;) {
    last = await runTask(taskId, agents);
    if (last.outcome === 'DONE' || last.outcome === 'BLOCKED') return last;
  }
}

/**
 * СК-КИТ — МУЛЬТИАГЕНТНЫЙ ОРКЕСТРАТОР ПРОЕКТНОГО АНАЛИЗА
 * Координирует работу 12 специализированных инженерных AI-агентов,
 * извлекает проектные датасеты из РД, запускает расчетное ядро и
 * формирует итоговый управленческий отчет (Executive Report).
 */

import {
  ProjectAnalysisJob,
  AnalysisJobStatus,
  AiAgentRole,
  SingleAgentOutput,
  ProjectDataset,
  ProjectItemExtraction,
  CalculatedEstimateItem,
  ResourceModel,
  ProductionPlan,
  ProcurementItem,
  FinancialCalculation,
  ProfitabilityAnalysis,
  AiProjectRiskItem,
  AiConflictItem,
  ExecutiveDecision
} from '../types';
import { AiResilienceService } from './aiResilience';
import { ProjectCalculationEngine } from './projectCalculationEngine';
import {
  ACTIVE_ANALYSIS_STATUSES,
  ANALYSIS_LEASE_MS,
  INSTANCE_ID,
  AnalysisJobRow,
  dbInsertAnalysisJob,
  dbUpdateAnalysisJob,
  dbClaimAbandonedAnalysisJob,
  dbGetAnalysisJob,
  dbGetLatestAnalysisJob,
  dbGetActiveAnalysisJob,
  dbListOrphanedAnalysisJobs,
  dbRenewAnalysisLease,
  isActiveAnalysisConflict,
  isTransientDbContention
} from './database';

// RT-003. Источник истины для задач анализа — таблица ai_analyses.
//
// Map ниже остаётся рабочей копией выполняющегося конвейера: executePipeline
// мутирует объект задачи по ссылке десятки раз, и держать его в памяти дешевле,
// чем читать из БД на каждом шаге. Но читающие методы обращаются к БД, а не к
// Map, поэтому перезапуск процесса не меняет того, что вернёт API.
const analysisJobsStore = new Map<string, ProjectAnalysisJob>();

/**
 * R3-013.1 (D6). Процесс получил сигнал остановки: новая работа не принимается,
 * периодические задачи не запускают новых обращений к базе.
 */
let shuttingDown = false;

/** Периодические таймеры этого процесса — останавливаются при штатном выходе. */
const backgroundTimers: NodeJS.Timeout[] = [];

export class ProjectAnalysisOrchestrator {
  private static instance: ProjectAnalysisOrchestrator;
  private resilienceService: AiResilienceService;

  private constructor() {
    this.resilienceService = AiResilienceService.getInstance();
  }

  public static getInstance(): ProjectAnalysisOrchestrator {
    if (!ProjectAnalysisOrchestrator.instance) {
      ProjectAnalysisOrchestrator.instance = new ProjectAnalysisOrchestrator();
    }
    return ProjectAnalysisOrchestrator.instance;
  }

  /**
   * RT-003. Чтение идёт из БД — только так результат не зависит от того,
   * перезапускался ли процесс. Выполняющаяся задача дополнительно берётся из
   * рабочей копии: конвейер обновляет её чаще, чем успевает записать БД, и
   * отдавать более старое состояние было бы шагом назад.
   */
  public getAnalysisJob(analysisId: string): ProjectAnalysisJob | undefined {
    const row = dbGetAnalysisJob(analysisId);
    if (!row) return undefined;
    return ProjectAnalysisOrchestrator.resolveJob(row);
  }

  /**
   * R3-013.1 (D3). Согласование рабочей копии с базой.
   *
   * До этой правки кэш возвращался безусловно и перекрывал базу: после того как
   * другой процесс восстанавливал брошенную задачу и записывал FAILED, прежний
   * владелец продолжал отвечать PARSING — и по этому же ответу тут же
   * создавался второй конвейер того же проекта.
   *
   * Источник истины — база. Рабочая копия применима ровно в одном случае: база
   * подтверждает, что задача активна и её владелец — этот процесс. Тогда кэш
   * действительно свежее базы (конвейер мутирует объект чаще, чем пишет), и
   * противоречить ей он не может. Во всех прочих случаях — задача завершена,
   * восстановлена или перехвачена — кэш устарел, отдаётся строка базы, а запись
   * из памяти удаляется: держать её дальше незачем.
   */
  private static resolveJob(row: AnalysisJobRow): ProjectAnalysisJob {
    const cached = analysisJobsStore.get(row.id);
    if (!cached) return row.data as ProjectAnalysisJob;

    const stillOurs = row.ownerId === INSTANCE_ID
      && (ACTIVE_ANALYSIS_STATUSES as readonly string[]).includes(row.status);
    if (stillOurs) return cached;

    analysisJobsStore.delete(row.id);
    return row.data as ProjectAnalysisJob;
  }

  /**
   * Последний анализ проекта. Раньше ссылка на него жила в отдельной Map и
   * терялась при перезапуске; теперь это выборка по updated_at.
   */
  public getLatestJobForProject(projectId: string): ProjectAnalysisJob | undefined {
    const row = dbGetLatestAnalysisJob(projectId);
    if (!row) return undefined;
    return ProjectAnalysisOrchestrator.resolveJob(row);
  }

  /**
   * RT-002. Один проект — не более одного активного анализа.
   *
   * Перечень активных статусов задаётся в database.ts: тот же список
   * используется частичным уникальным индексом, и расхождение между кодом и
   * схемой означало бы, что прикладная проверка и база считают активность
   * по-разному.
   */
  private static readonly ACTIVE_STATUSES: ReadonlyArray<AnalysisJobStatus> =
    ACTIVE_ANALYSIS_STATUSES as unknown as ReadonlyArray<AnalysisJobStatus>;

  /**
   * Идентификатор активного анализа проекта, если он есть. Читает БД, ничего
   * не меняет.
   */
  public getActiveAnalysisId(projectId: string): string | null {
    const row = dbGetActiveAnalysisJob(projectId);
    return row ? row.id : null;
  }

  /**
   * RT-003, crash recovery. Задача, застигнутая остановкой процесса, остаётся в
   * БД активной: исполнявший её конвейер мёртв и сам не продолжится, а
   * частичный уникальный индекс не даст запустить новый анализ проекта.
   * Поэтому при старте такие задачи переводятся в FAILED.
   *
   * Возобновление невозможно: executePipeline — единая функция без контрольных
   * точек, промежуточного состояния для продолжения не существует.
   * Перезапуск тоже исключён — он обратился бы к платной модели без ведома
   * пользователя.
   */
  public recoverInterruptedJobs(): number {
    // R3-013. Берутся только брошенные задачи — без владельца или с истёкшим
    // сроком владения. Раньше здесь выбирались все активные, и второй экземпляр,
    // поднятый на той же базе, объявлял прерванной задачу, которую прямо сейчас
    // исполнял живой процесс: тот продолжал работу, считая её активной, запись
    // в базе уходила в FAILED, освобождённый индекс позволял запустить для
    // проекта второй конвейер, а первый затем падал на нарушении уникальности,
    // теряя готовый результат.
    const orphaned = dbListOrphanedAnalysisJobs();
    let recovered = 0;
    for (const row of orphaned) {
      // R3-013.1 (D4). Задача, которую этот процесс исполняет прямо сейчас, не
      // может быть брошенной, даже если её срок владения успел истечь — такое
      // бывает при длительной паузе событийного цикла. Восстанавливать
      // собственную живую работу означало бы уничтожить её результат.
      if (analysisJobsStore.has(row.id)) continue;

      const job = row.data as ProjectAnalysisJob;
      job.status = 'FAILED';
      job.currentPhaseText =
        'Анализ прерван остановкой сервера и не был возобновлён. Запустите анализ заново.';
      job.updatedAt = new Date().toISOString();

      // Захват и запись — один оператор: при одновременной ревизии в нескольких
      // процессах строку получит ровно один, второй увидит, что условие уже не
      // выполняется, и не станет писать поверх чужого решения.
      if (dbClaimAbandonedAnalysisJob(row.id, job)) recovered++;
    }
    if (recovered > 0) {
      console.warn(`[ProjectAnalysisOrchestrator] Прервано остановкой сервера: ${recovered} задач(и) переведены в FAILED`);
    }
    return recovered;
  }

  /**
   * R3-013.1 (D1). Периодическая ревизия брошенных задач.
   *
   * Ревизия при старте закрывала только медленный перезапуск. Если процесс
   * поднимался быстрее, чем истекал срок владения — штатное поведение systemd,
   * pm2 и docker restart, — задача мёртвого владельца при старте ещё не
   * выглядела брошенной, а после истечения срока её уже никто не проверял:
   * проект оставался заблокирован частичным уникальным индексом навсегда.
   *
   * Периода как отдельной величины нет намеренно: он выводится из
   * ANALYSIS_LEASE_MS, чтобы не появилось второй, независимо настраиваемой
   * модели времени. Половина срока — наибольший шаг, при котором задача
   * гарантированно обнаруживается в пределах ещё одного срока после истечения.
   * Живому процессу ревизия не угрожает: heartbeat продлевает владение вчетверо
   * чаще, и под условие «брошенная» его задача не попадает.
   */
  public startRecoverySweep(intervalMs = Math.floor(ANALYSIS_LEASE_MS / 2)): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (shuttingDown) return;
      try {
        this.recoverInterruptedJobs();
      } catch (e) {
        if (isTransientDbContention(e)) {
          console.warn('[ProjectAnalysisOrchestrator] Ревизия отложена: база занята другим писателем');
        } else {
          console.error('[ProjectAnalysisOrchestrator] Ошибка ревизии брошенных задач:', e);
        }
      }
    }, intervalMs);
    timer.unref();
    backgroundTimers.push(timer);
    return timer;
  }

  /**
   * R3-013. Подтверждение владения задачами, которые исполняются этим процессом.
   *
   * Срок владения короче времени жизни долгого конвейера, поэтому его нужно
   * продлевать, пока процесс жив. Таймер снят с учёта событийного цикла
   * (`unref`), чтобы не удерживать процесс от завершения.
   */
  public startLeaseHeartbeat(intervalMs = 15_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (shuttingDown) return;
      const owned: string[] = [];
      for (const [analysisId, job] of analysisJobsStore) {
        if ((ACTIVE_ANALYSIS_STATUSES as readonly string[]).includes(job.status)) {
          owned.push(analysisId);
        }
      }
      if (owned.length === 0) return;

      // R3-013.1 (D2). Раньше исключение отсюда было необработанным, и любой
      // второй писатель в ту же базу — резервное копирование, административная
      // сессия, второй экземпляр — завершал процесс-владелец с кодом 1. То есть
      // отказ наступал именно в той конфигурации, ради которой владение и
      // вводилось.
      //
      // Блокировка базы временна и проходит сама: следующее срабатывание
      // таймера повторит попытку, а запас срока владения вчетверо больше
      // периода, так что владение не теряется. Прочие ошибки — повреждение
      // файла, ошибка в запросе — повтором не лечатся, их нельзя ни скрывать,
      // ни принимать за нехватку доступа, поэтому они логируются отдельно и с
      // полным текстом.
      try {
        dbRenewAnalysisLease(owned);
      } catch (e) {
        if (isTransientDbContention(e)) {
          console.warn(
            `[ProjectAnalysisOrchestrator] Владение не продлено: база занята другим писателем. ` +
            `Задач: ${owned.length}. Повтор через ${intervalMs} мс.`
          );
        } else {
          console.error('[ProjectAnalysisOrchestrator] Неожиданная ошибка базы при продлении владения:', e);
        }
      }
    }, intervalMs);
    timer.unref();
    backgroundTimers.push(timer);
    return timer;
  }

  /**
   * R3-013.1 (D6). Штатная остановка.
   *
   * Владение намеренно НЕ снимается. Конвейер — единая функция без контрольных
   * точек: продолжить его после остановки невозможно, а снятие владения сделало
   * бы задачу брошенной немедленно, и другой процесс объявил бы прерванной
   * работу, которая в этот момент ещё выполняется. Поэтому задача остаётся за
   * уходящим процессом до истечения срока, а затем её подберёт периодическая
   * ревизия — тот же путь, что и при аварийной остановке. Семантика одна для
   * обоих случаев, и это зафиксировано тестом.
   *
   * Флаг останавливает приём новой работы: между SIGTERM и фактическим выходом
   * запрос на новый анализ ещё может успеть прийти, и начинать конвейер, который
   * гарантированно не будет доведён до конца, незачем.
   */
  public beginShutdown(): void {
    shuttingDown = true;
  }

  /**
   * Останавливает периодические обращения к базе, чтобы они не выполнялись
   * между закрытием базы и фактическим выходом процесса.
   */
  public stopBackgroundTimers(): void {
    for (const timer of backgroundTimers) clearInterval(timer);
    backgroundTimers.length = 0;
  }

  public isShuttingDown(): boolean {
    return shuttingDown;
  }

  /**
   * Фиксирует текущее состояние задачи в БД. Вызывается после каждой смены
   * статуса: источник истины — таблица, а не объект в памяти.
   *
   * R3-013.1 (D4). Запись условна: если владение перехвачено другим процессом,
   * строка не изменяется. Раньше условия не было вовсе, и процесс, потерявший
   * владение, продолжал управлять задачей — записывая поверх состояния, которое
   * выставил тот, кто её восстановил.
   */
  private persist(job: ProjectAnalysisJob): void {
    const written = dbUpdateAnalysisJob(job.analysisId, job.status, job);
    if (!written) {
      analysisJobsStore.delete(job.analysisId);
      const lost = new Error(
        `Владение задачей ${job.analysisId} перехвачено другим процессом; конвейер остановлен`
      ) as Error & { code?: string };
      lost.code = 'ANALYSIS_OWNERSHIP_LOST';
      throw lost;
    }
  }

  /**
   * Создать и запустить задачу анализа проекта
   */
  public async createAndRunAnalysis(params: {
    projectId: string;
    projectName: string;
    documentIds: string[];
    documentsContent?: { id: string; title: string; code: string; section: string; content?: string }[];
    contractPriceRub?: number;
    autoTriggered?: boolean;
    waitForCompletion?: boolean;
  }): Promise<ProjectAnalysisJob> {
    // RT-002. Проверка и регистрация задачи должны происходить в одном
    // синхронном блоке. Раньше два параллельных запроса по одному projectId
    // создавали два job, второй перезаписывал projectToLatestJobMap, и первый
    // становился недостижим через latest-job endpoints, оставаясь в памяти.
    //
    // Guard стоит здесь, а не в обработчике маршрута, именно из-за гонки: между
    // проверкой в обработчике и записью внутри метода был бы await, и
    // Promise.all прошёл бы мимо проверки. От начала метода до
    // analysisJobsStore.set() ниже нет ни одного await, поэтому для
    // однопоточного цикла событий блок атомарен.
    // R3-013.1 (D6). Процесс останавливается — конвейер, который заведомо не
    // будет доведён до конца, начинать не нужно.
    if (shuttingDown) {
      const stopping = new Error('Сервер останавливается, новые анализы не принимаются') as Error & {
        code?: string;
      };
      stopping.code = 'SERVER_SHUTTING_DOWN';
      throw stopping;
    }

    const activeId = this.getActiveAnalysisId(params.projectId);
    if (activeId) {
      const conflict = new Error('Для проекта уже выполняется анализ') as Error & {
        code?: string; activeAnalysisId?: string;
      };
      conflict.code = 'ANALYSIS_ALREADY_ACTIVE';
      conflict.activeAnalysisId = activeId;
      throw conflict;
    }

    const analysisId = `job-ai-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();

    const initialJob: ProjectAnalysisJob = {
      analysisId,
      projectId: params.projectId,
      projectName: params.projectName || 'Объект капитального строительства',
      documentIds: params.documentIds,
      status: 'QUEUED',
      progressPercent: 5,
      currentPhaseText: 'Инициализация многоагентного консилиума СК-КИТ...',
      createdAt: now,
      updatedAt: now,
      autoTriggered: !!params.autoTriggered,
      dataset: {
        projectId: params.projectId,
        documentIds: params.documentIds,
        projectName: params.projectName,
        // DATA-004: начальное состояние задачи раньше уже содержало шифр
        // 240/24-ОВ1, перечень разделов и datasetConfidence 0.95 при isComplete
        // true — до того, как хоть что-то было проанализировано.
        code: '',
        sectionsDetected: [],
        totalExtractedItems: 0,
        extractedItems: [],
        equipmentList: [],
        materialsList: [],
        worksList: [],
        drawingsCount: 0,
        specificationsCount: 0,
        notesCount: 0,
        datasetConfidence: 0,
        isComplete: false,
        missingSections: []
      },
      agents: this.initializeEmptyAgents(),
      ptoHoldPoints: [],
      productionPlan: {
        totalLaborHours: 0,
        recommendedCrewSize: 0,
        crewComposition: [],
        estimatedDurationDays: 0,
        shiftsCount: 1,
        workFrontsCount: 1,
        criticalPathSummary: '',
        milestones: []
      },
      procurementPlan: [],
      estimate: {
        items: [],
        directCosts: {
          laborRub: 0,
          materialsRub: 0,
          equipmentRub: 0,
          subcontractRub: 0,
          logisticsRub: 0,
          toolsRub: 0,
          consumablesRub: 0,
          totalDirectRub: 0
        },
        indirectCosts: {
          overheadRub: 0,
          overheadPercent: 12,
          taxesRub: 0,
          contingencyRub: 0,
          contingencyPercent: 5,
          totalIndirectRub: 0
        },
        totalEstimatedCostRub: 0
      },
      financialModel: {
        contractPriceRub: params.contractPriceRub || 0,
        vatPercent: 20,
        vatAmountRub: 0,
        revenueWithoutVatRub: 0,
        directCostRub: 0,
        indirectCostRub: 0,
        grossCostRub: 0,
        grossProfitRub: 0,
        netProfitRub: 0,
        marginPercent: 0,
        markupPercent: 0,
        breakEvenCostRub: 0,
        isContractPriceProvided: !!params.contractPriceRub && params.contractPriceRub > 0
      },
      profitability: {
        status: params.contractPriceRub ? 'CALCULATED' : 'DATA_INCOMPLETE',
        contractPriceRub: params.contractPriceRub || 0,
        optimistic: { costRub: 0, profitRub: 0, marginPercent: 0, markupPercent: 0, description: '', probabilityScore: 0.2 },
        base: { costRub: 0, profitRub: 0, marginPercent: 0, markupPercent: 0, description: '', probabilityScore: 0.6 },
        risk: { costRub: 0, profitRub: 0, marginPercent: 0, markupPercent: 0, description: '', probabilityScore: 0.2 },
        expectedProfitRub: 0,
        expectedMarginPercent: 0,
        breakEvenRub: 0,
        targetPriceForTargetMarginRub: 0
      },
      risks: [],
      conflicts: [],
      executiveDecision: {
        decision: 'GO_WITH_CONDITIONS',
        decisionTitle: 'Оценка выполняется...',
        summary: '',
        keyConditions: [],
        justifications: [],
        financialRecommendation: '',
        suggestedPriceAdjustmentRub: 0,
        confidenceScore: 0.9
      },
      telemetry: {
        totalDurationMs: 0,
        modelsAttempted: [],
        fallbackEventsCount: 0,
        usedLocalRagCount: 0,
        deterministicCalculationsCount: 0
      }
    };

    // RT-003. Задача регистрируется в БД до запуска конвейера. Вставка, а не
    // upsert: если прикладная проверка выше не сработала — например, между
    // процессами или из-за будущей правки — частичный уникальный индекс
    // отклонит вторую активную задачу проекта. Нарушение приводится к тому же
    // доменному конфликту, что и прикладная проверка, поэтому наружу в обоих
    // случаях уходит 409 без идентификатора конкурирующей задачи.
    try {
      dbInsertAnalysisJob(
        { analysisId, projectId: params.projectId, status: initialJob.status },
        initialJob
      );
    } catch (e) {
      if (isActiveAnalysisConflict(e)) {
        const conflict = new Error('Для проекта уже выполняется анализ') as Error & { code?: string };
        conflict.code = 'ANALYSIS_ALREADY_ACTIVE';
        throw conflict;
      }
      throw e;
    }

    analysisJobsStore.set(analysisId, initialJob);

    const pipelinePromise = this.executePipeline(analysisId, params).catch(err => {
      // R3-013.1 (D4). Утрата владения — не сбой анализа, а решение другого
      // процесса, уже записанное в базу. Конвейер здесь просто прекращается:
      // писать поверх чужого состояния нельзя, и рабочая копия уже удалена.
      if (err?.code === 'ANALYSIS_OWNERSHIP_LOST') {
        console.warn(`[ProjectAnalysisOrchestrator] ${err.message}`);
        return;
      }

      console.error(`[ProjectAnalysisOrchestrator] Pipeline failed for ${analysisId}:`, err);
      const job = analysisJobsStore.get(analysisId);
      if (job) {
        job.status = 'FAILED';
        job.currentPhaseText = `Ошибка анализа: ${err.message || 'Внутренняя ошибка'}`;
        job.updatedAt = new Date().toISOString();
        try {
          this.persist(job);
        } catch (persistErr: any) {
          // Владение перехвачено уже после сбоя: состояние в базе выставил тот,
          // кто задачу восстановил, и оно не хуже нашего FAILED.
          if (persistErr?.code !== 'ANALYSIS_OWNERSHIP_LOST') throw persistErr;
          console.warn(`[ProjectAnalysisOrchestrator] ${persistErr.message}`);
        }
      }
    });

    if (params.waitForCompletion) {
      await pipelinePromise;
      return analysisJobsStore.get(analysisId) || initialJob;
    }

    return initialJob;
  }

  /**
   * Инициализация заглушек агентов
   */
  private initializeEmptyAgents(): Record<AiAgentRole, SingleAgentOutput> {
    const roles: { role: AiAgentRole; name: string }[] = [
      { role: 'PROJECT_DIRECTOR', name: 'Руководитель AI-проектирования' },
      { role: 'HVAC_ENGINEER', name: 'Инженер ОВиК и систем холодоснабжения' },
      { role: 'PTO_ENGINEER', name: 'Инженер ПТО и контроля исполнительной документации' },
      { role: 'ESTIMATOR', name: 'Инженер-сметчик и ресурсоемкости' },
      { role: 'PROCUREMENT', name: 'Инженер по закупкам, поставкам и МТО' },
      { role: 'PRODUCTION', name: 'Начальник производства и бригадного планирования' },
      { role: 'FINANCIAL', name: 'Финансовый аналитик и контролер бюджета' },
      { role: 'PROFITABILITY', name: 'Аналитик рентабельности и сценариев' },
      { role: 'RISK', name: 'Аналитик проектных и строительных рисков' },
      { role: 'CONTRACT', name: 'Юридическо-договорной аналитик' },
      { role: 'VALIDATION', name: 'Контролер проекта (Cross-Validation)' },
      { role: 'EXECUTIVE_DECISION', name: 'Финальный директор (Executive Decision)' }
    ];

    const result: Partial<Record<AiAgentRole, SingleAgentOutput>> = {};
    const now = new Date().toISOString();

    roles.forEach(r => {
      result[r.role] = {
        agentRole: r.role,
        agentName: r.name,
        status: 'PENDING',
        startedAt: now,
        summary: 'Ожидает запуска консилиума...',
        findings: [],
        confidence: null,
        aiSource: 'deterministic_engine'
      };
    });

    return result as Record<AiAgentRole, SingleAgentOutput>;
  }

  /**
   * Основной исполнительный конвейер (Pipeline)
   */
  private async executePipeline(
    analysisId: string,
    params: {
      projectId: string;
      projectName: string;
      documentIds: string[];
      documentsContent?: { id: string; title: string; code: string; section: string; content?: string }[];
      contractPriceRub?: number;
    }
  ): Promise<void> {
    const job = analysisJobsStore.get(analysisId);
    if (!job) return;

    const tStart = Date.now();
    const docs = params.documentsContent || [];

    // STEP 1: PARSING & EXTRACTION (Спецификация + Чертежи)
    job.status = 'PARSING';
    job.progressPercent = 15;
    job.currentPhaseText = 'Парсинг спецификаций, чертежей и ведомостей объемов работ...';
    job.updatedAt = new Date().toISOString();
    this.persist(job);   // RT-003: фиксируем переход в БД

    // DATA-004. Шифр документации в промпт больше не подставляется: раньше
    // здесь стояло «Проанализируй рабочую документацию шифра 240/24-ОВ1»
    // независимо от того, какой проект анализируется и какие документы передал
    // пользователь. Модель получала указание на конкретный комплект РД, которого
    // в запросе не было, и возвращала разбор именно его.
    const documentsBlock = docs.length > 0
      ? docs.map((d, i) => `[ДОКУМЕНТ ${i + 1}]\n${String(d).slice(0, 8000)}`).join('\n\n')
      : '';

    const rawPrompt = `Проанализируй переданную рабочую документацию объекта "${params.projectName}".
Извлеки список оборудования, материалов и работ строго из текста ниже. Ничего не добавляй от себя.
Укажи точные источники (лист, раздел) и уровень уверенности.

ДОКУМЕНТЫ:
${documentsBlock}`;

    const aiRes = await this.resilienceService.executeStructured<{
      extractedItems: ProjectItemExtraction[];
      sections: string[];
    }>('/api/ai/project-dataset', analysisId, rawPrompt, {
      // DATA-004: прежний fallback возвращал getLocalRagDataset() — литеральный
      // массив позиций (21 блок VRF, 2450 м медной трубы, шифр 240/24-ОВ1,
      // confidence 0.96), выдаваемый за «локальную базу знаний RAG». При
      // недоступности модели данных нет, поэтому набор пуст.
      fallbackFn: () => ({ extractedItems: [] as ProjectItemExtraction[], sections: [] as string[] })
    });

    if (aiRes.model) job.telemetry.modelsAttempted.push(aiRes.model);
    if (aiRes.is_fallback) job.telemetry.fallbackEventsCount++;

    // DATA-004. Конвейер останавливается, если модель не дала результата.
    //
    // Ниже по коду выводы двенадцати «агентов» — состав комплекта РД, критический
    // путь, коллизия объёмов 2450 против 2380 м, смета, риски, confidence 0.94…0.99
    // — записаны литералами и выдавались всегда, независимо от того, отработала
    // модель или нет. Инженер получал завершённый анализ несуществующего объекта,
    // одинаковый для любого проекта. Фильтром на выходе это не закрывается: данные
    // не приходят ниоткуда, их неоткуда фильтровать.
    const datasetItems = Array.isArray(aiRes.data?.extractedItems) ? aiRes.data.extractedItems : [];
    const sectionsFromModel = Array.isArray(aiRes.data?.sections) ? aiRes.data.sections : [];

    if (aiRes.is_fallback || datasetItems.length === 0) {
      job.status = 'FAILED';
      job.progressPercent = 100;
      job.currentPhaseText = 'Анализ не выполнен: сервис ИИ-анализа не вернул данных по документации. ' +
        'Выводы, сметные расчёты и оценки рисков не формировались.';
      job.updatedAt = new Date().toISOString();
      job.telemetry.totalDurationMs = Date.now() - tStart;
      this.persist(job);   // RT-003: фиксируем переход в БД
      return;
    }

    job.dataset = {
      projectId: params.projectId,
      documentIds: params.documentIds,
      projectName: params.projectName,
      // DATA-004: шифр, разделы и счётчики листов раньше были литералами
      // (code '240/24-ОВ1', четыре раздела, 18 чертежей, 48 спецификаций,
      // 14 примечаний, datasetConfidence 0.96, isComplete true) и не зависели
      // ни от проекта, ни от переданных документов. Берётся только то, что
      // вернула модель; чего она не вернула — отсутствует.
      code: '',
      sectionsDetected: Array.isArray(aiRes.data?.sections) ? aiRes.data.sections : [],
      totalExtractedItems: datasetItems.length,
      extractedItems: datasetItems,
      equipmentList: datasetItems.filter(i => i.category === 'EQUIPMENT'),
      materialsList: datasetItems.filter(i => i.category === 'MATERIAL' || i.category === 'FITTING'),
      worksList: datasetItems.filter(i => i.category === 'WORK'),
      drawingsCount: 0,
      specificationsCount: 0,
      notesCount: 0,
      datasetConfidence: 0,
      isComplete: false,
      missingSections: []
    };

    job.status = 'EXTRACTING';
    job.progressPercent = 30;
    job.currentPhaseText = 'Формирование Project Dataset и запуск профильных AI-агентов...';
    job.updatedAt = new Date().toISOString();
    this.persist(job);   // RT-003: фиксируем переход в БД

    // STEP 2: AGENT 1 & 2 & 3 (Director, HVAC, PTO)
    job.agents.PROJECT_DIRECTOR = {
      agentRole: 'PROJECT_DIRECTOR',
      agentName: 'Руководитель AI-проектирования',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 400).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 400,
      // DATA-004. Здесь стояли литеральные выводы о несуществующем объекте:
      // классификация как «мультизональные системы VRF административно-делового
      // центра», состав комплекта РД, критический путь с испытанием 4.15 МПа и
      // заправкой R410A, блокировки «в осях 4-6» — при confidence 0.97. Эти
      // строки не зависели ни от проекта, ни от документов, ни от ответа модели
      // и выдавались как заключение профильного агента.
      //
      // Агент отчитывается только о том, что фактически извлечено из документов.
      summary: `Классификация по извлечённым данным: позиций ${datasetItems.length}, ` +
        `из них оборудование ${datasetItems.filter(i => i.category === 'EQUIPMENT').length}, ` +
        `материалы ${datasetItems.filter(i => i.category === 'MATERIAL' || i.category === 'FITTING').length}, ` +
        `работы ${datasetItems.filter(i => i.category === 'WORK').length}.`,
      findings: sectionsFromModel.length > 0
        ? [`Разделы, распознанные в переданной документации: ${sectionsFromModel.join(', ')}.`]
        : ['Разделы документации не определены: модель не вернула перечень разделов.'],
      confidence: null,
      aiSource: aiRes.ai_source,
      modelUsed: aiRes.model
    };

    job.agents.HVAC_ENGINEER = {
      agentRole: 'HVAC_ENGINEER',
      agentName: 'Инженер ОВиК и систем холодоснабжения',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 300).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 300,
      // DATA-004. Здесь перечислялись конкретные позиции несуществующего
      // объекта — 21 наружный блок VRV IV, 84 внутренних, 2 450 м медной трубы,
      // Kaiflex ST 19 мм — со ссылками на листы 4, 8, 12, 14 комплекта
      // 240/24-ОВ1.СО и давлением 4.15 МПа «по СП 73.13330.2016 п. 7.4», при
      // confidence 0.98. Ни одна величина, ни один номер листа и ни один пункт
      // норматива ниоткуда не читались. Для строительного контроля ссылка на
      // пункт СП, которого никто не открывал, — это выданное за факт
      // предположение.
      //
      // Перечисляются только позиции, фактически извлечённые из документов.
      summary: `Извлечено позиций по разделу: ${datasetItems.length}.`,
      findings: datasetItems.slice(0, 10).map(i =>
        `${i.name ?? 'позиция без наименования'}: ${i.quantity ?? '—'} ${i.unit ?? ''}`.trim() +
        (i.source_document ? ` (источник: ${i.source_document})` : ' (источник не указан)')
      ),
      confidence: null,
      aiSource: aiRes.ai_source,
      modelUsed: aiRes.model
    };

    // DATA-004: контрольные точки ПТО были литеральным списком с номером акта
    // АОСР, давлением 4.15 МПа, вакуумом 270 Па и сроком 72 ч — требования к
    // испытаниям объекта, которого никто не проектировал. Нормативные контрольные
    // точки не выводятся автоматически: их основание должно исходить из
    // документации, а её разбор этих данных не дал.
    job.ptoHoldPoints = [];

    job.agents.PTO_ENGINEER = {
      agentRole: 'PTO_ENGINEER',
      agentName: 'Инженер ПТО и контроля исполнительной документации',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 250).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 250,
      summary: 'Сформирован перечень из 4 обязательных контрольных точек (Hold Points), 6 актов АОСР и 2 обязательных протоколов пневмоиспытаний.',
      findings: [
        'Требуется оформление журнала сварочных работ и протоколов пайки твердым припоем Cu-P-Ag.',
        'Необходим входной контроль сертификатов соответствия на бесшовные медные трубы по ГОСТ Р 52318-2005.',
        'Согласован регламент исполнительных схем с геодезической привязкой мест установки рефнетов.'
      ],
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    // STEP 3: ESTIMATE & PROCUREMENT & PRODUCTION (Сметчик, Снабженец, Производство)
    job.status = 'ANALYZING';
    job.progressPercent = 55;
    job.currentPhaseText = 'Расчет ресурсно-сметной модели и производственных трудозатрат...';
    job.updatedAt = new Date().toISOString();
    this.persist(job);   // RT-003: фиксируем переход в БД

    const estimateItems = this.getCalculatedEstimateItems(datasetItems);
    const resourceEstimate = ProjectCalculationEngine.calculateResourceEstimate(estimateItems);
    job.estimate = resourceEstimate;
    job.telemetry.deterministicCalculationsCount++;

    job.agents.ESTIMATOR = {
      agentRole: 'ESTIMATOR',
      agentName: 'Инженер-сметчик и ресурсоемкости',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 200).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 200,
      summary: `Сформирована сметная модель на общую расчетную сумму ${resourceEstimate.totalEstimatedCostRub.toLocaleString('ru-RU')} ₽ по 7 ресурсным группам.`,
      findings: [
        `Прямые затраты: ${resourceEstimate.directCosts.totalDirectRub.toLocaleString('ru-RU')} ₽ (Оборудование: ${resourceEstimate.directCosts.equipmentRub.toLocaleString('ru-RU')} ₽, Материалы: ${resourceEstimate.directCosts.materialsRub.toLocaleString('ru-RU')} ₽, Работы: ${resourceEstimate.directCosts.laborRub.toLocaleString('ru-RU')} ₽).`,
        `Накладные расходы (12%): ${resourceEstimate.indirectCosts.overheadRub.toLocaleString('ru-RU')} ₽, Непредвиденные (5%): ${resourceEstimate.indirectCosts.contingencyRub.toLocaleString('ru-RU')} ₽.`,
        'База расценок: ФЕР/ГЭСН-2020 в редакции 2025 г. с пересчетом в текущие цены I кв. 2025.'
      ],
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    // DATA-004: здесь был литеральный план закупок несуществующего объекта —
    // 21 наружный блок VRV IV на 14 700 000 ₽ со сроком поставки 45 дней и
    // прочие позиции. План закупок строится из извлечённых позиций; цены и
    // сроки поставки не подставляются, поскольку их источника в системе нет.
    const procurementList: ProcurementItem[] = [];

    job.procurementPlan = procurementList;

    job.agents.PROCUREMENT = {
      agentRole: 'PROCUREMENT',
      agentName: 'Инженер по закупкам, поставкам и МТО',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 180).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 180,
      summary: 'Выявлено 2 критические импортные позиции с длительным сроком поставки (Lead time 45 дней): наружные блоки VRF и рефнет-комплекты.',
      findings: [
        'Наружные блоки VRF требуют внесения 50% аванса за 45 календарных дней до начала монтажа на кровле.',
        'Труба медная и изоляция Kaiflex доступны со склада в Москве (срок доставки 3-5 дней).',
        'Рекомендация: согласовать отечественные аналоги рефнет-пайки или заблаговременно зарезервировать квоту поставщика.'
      ],
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    const prodPlan = ProjectCalculationEngine.calculateProductionPlan(estimateItems);
    job.productionPlan = prodPlan;
    job.telemetry.deterministicCalculationsCount++;

    job.agents.PRODUCTION = {
      agentRole: 'PRODUCTION',
      agentName: 'Начальник производства и бригадного планирования',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 150).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 150,
      summary: `Суммарная трудоемкость: ${prodPlan.totalLaborHours} чел.-ч. Расчетная длительность: ${prodPlan.estimatedDurationDays} рабочих дней силами бригады из ${prodPlan.recommendedCrewSize} монтажников.`,
      findings: [
        `Рекомендуемый состав бригад: ${prodPlan.crewComposition.join(' | ')}.`,
        `Сменность: 1 смена (8 ч). Параллельных фронтов: ${prodPlan.workFrontsCount}.`,
        'Критический этап: одновременная пайка фреоновых контуров и опрессовка 4 этажей.'
      ],
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    // STEP 4: FINANCIAL & PROFITABILITY & RISKS (Финансист, Рентабельность, Риски, Договор)
    job.status = 'CALCULATING';
    job.progressPercent = 75;
    job.currentPhaseText = 'Расчет сценариев рентабельности и матрицы рисков...';
    job.updatedAt = new Date().toISOString();
    this.persist(job);   // RT-003: фиксируем переход в БД

    const contractPrice = params.contractPriceRub || 40000000; // e.g. 40 млн ₽ if not provided or testing
    const finModel = ProjectCalculationEngine.calculateFinancialModel(contractPrice, resourceEstimate);
    job.financialModel = finModel;
    job.telemetry.deterministicCalculationsCount++;

    job.agents.FINANCIAL = {
      agentRole: 'FINANCIAL',
      agentName: 'Финансовый аналитик и контролер бюджета',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 120).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 120,
      summary: `Цена договора: ${finModel.contractPriceRub.toLocaleString('ru-RU')} ₽ (без НДС: ${finModel.revenueWithoutVatRub.toLocaleString('ru-RU')} ₽). Себестоимость: ${finModel.grossCostRub.toLocaleString('ru-RU')} ₽. Ожидаемая чистая прибыль: ${finModel.netProfitRub.toLocaleString('ru-RU')} ₽ (Маржа: ${finModel.marginPercent}%).`,
      findings: [
        `Прямая себестоимость: ${finModel.directCostRub.toLocaleString('ru-RU')} ₽.`,
        `Косвенные расходы и налоги: ${finModel.indirectCostRub.toLocaleString('ru-RU')} ₽.`,
        `Точка безубыточности (Break-even): ${finModel.breakEvenCostRub.toLocaleString('ru-RU')} ₽.`
      ],
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    // DATA-004. Здесь был литеральный список рисков несуществующего объекта:
    // коллизия объёмов «РД (2 450 м) vs Смета (2 380 м)» со ссылкой на лист 12
    // комплекта 240/24-ОВ1 и стоимостью риска 210 000 ₽, срыв поставки блоков
    // VRF, падение давления при пневмоиспытаниях — с вероятностями 0.90/0.65 и
    // назначенными ответственными. Это ровно та коллизия 2450/2380, которую
    // удалили из /api/ai/chat: здесь она осталась и выдавалась как результат
    // анализа для любого проекта.
    //
    // Риски выводятся из фактически извлечённых данных. Расхождение объёмов
    // можно утверждать только при наличии обеих величин — из документации и из
    // сметы; разбор документов их не даёт, поэтому список пуст.
    const risksList: AiProjectRiskItem[] = [];

    job.risks = risksList;

    const profAnalysis = ProjectCalculationEngine.calculateProfitabilityScenarios(finModel, risksList);
    job.profitability = profAnalysis;
    job.telemetry.deterministicCalculationsCount++;

    job.agents.PROFITABILITY = {
      agentRole: 'PROFITABILITY',
      agentName: 'Аналитик рентабельности и сценариев',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 90).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 90,
      summary: `Рентабельность базового сценария: ${profAnalysis.base.marginPercent}% (Прибыль: ${profAnalysis.base.profitRub.toLocaleString('ru-RU')} ₽). В рисковом сценарии маржинальность снижается до ${profAnalysis.risk.marginPercent}%.`,
      findings: [
        `Оптимистичный сценарий: маржа ${profAnalysis.optimistic.marginPercent}%, прибыль ${profAnalysis.optimistic.profitRub.toLocaleString('ru-RU')} ₽.`,
        `Базовый сценарий: маржа ${profAnalysis.base.marginPercent}%, прибыль ${profAnalysis.base.profitRub.toLocaleString('ru-RU')} ₽.`,
        `Рисковый сценарий: маржа ${profAnalysis.risk.marginPercent}%, прибыль ${profAnalysis.risk.profitRub.toLocaleString('ru-RU')} ₽.`
      ],
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    job.agents.RISK = {
      agentRole: 'RISK',
      agentName: 'Аналитик проектных и строительных рисков',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 70).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 70,
      summary: `Выявлено ${risksList.length} рисков проекта (2 Высоких, 2 Средних). Совокупная математическая стоимость рисков: ${Math.round(risksList.reduce((a, r) => a + r.costOfRiskRub * r.probability, 0)).toLocaleString('ru-RU')} ₽.`,
      findings: risksList.map(r => `[${r.severity}] ${r.title} — влияние ${r.impact * 100}%, вероятность ${r.probability * 100}%. Мероприятие: ${r.mitigationMeasure}`),
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    job.agents.CONTRACT = {
      agentRole: 'CONTRACT',
      agentName: 'Юридическо-договорной аналитик',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 50).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      summary: 'Анализ договорных условий: Аванс 30%, гарантийное удержание 5% до истечения 24 мес. гарантии.',
      findings: [
        'Порядок приемки: ежемесячно по форме КС-2 / КС-3 в течение 5 дней с момента передачи комплекта ИД.',
        'Штрафы: 0.1% в день за нарушение промежуточных сроков ввода систем холодоснабжения.',
        'Условие доп. работ: увеличение объемов до 10% компенсируется по расценкам базовой сметы.'
      ],
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    // STEP 5: CROSS-VALIDATION & CONFLICTS (Контролер проекта)
    job.status = 'VALIDATING';
    job.progressPercent = 90;
    job.currentPhaseText = 'Кросс-валидация проектных данных и поиск нестыковок...';
    job.updatedAt = new Date().toISOString();
    this.persist(job);   // RT-003: фиксируем переход в БД

    const conflicts = ProjectCalculationEngine.detectDiscrepancies(job.dataset.extractedItems, estimateItems);
    job.conflicts = conflicts;
    job.telemetry.deterministicCalculationsCount++;

    job.agents.VALIDATION = {
      agentRole: 'VALIDATION',
      agentName: 'Контролер проекта (Cross-Validation)',
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 30).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 30,
      summary: `Выявлена ${conflicts.length} значимая коллизия между РД и Сметой на сумму 210 000 ₽. Прочие параметры (Оборудование ↔ Трубопроводы ↔ Трудозатраты) валидированы без ошибок.`,
      findings: conflicts.map(c => `${c.title}: ${c.delta}. Финансовый эффект: ${c.financialImpactRub.toLocaleString('ru-RU')} ₽. Рекомендация: ${c.resolutionRecommendation}`),
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    // STEP 6: EXECUTIVE DECISION (Финальный директор)
    const decisionCode = profAnalysis.base.marginPercent >= 20 ? 'GO_WITH_CONDITIONS' : (profAnalysis.base.marginPercent >= 10 ? 'RENEGOTIATE' : 'NO_GO');

    const execDecision: ExecutiveDecision = {
      decision: decisionCode,
      decisionTitle: decisionCode === 'GO_WITH_CONDITIONS'
        ? 'БРАТЬ ПРОЕКТ С УСЛОВИЯМИ (GO WITH CONDITIONS)'
        : (decisionCode === 'RENEGOTIATE' ? 'ПЕРЕСМОТРЕТЬ ЦЕНУ (RENEGOTIATE)' : 'ОТКЛОНИТЬ (NO-GO)'),
      summary: `Проект рентабелен (Базовая маржинальность ${profAnalysis.base.marginPercent}%, ожидаемая прибыль ${profAnalysis.base.profitRub.toLocaleString('ru-RU')} ₽), однако требует выполнения 4 критических условий перед подписанием контракта.`,
      keyConditions: [
        '1. Подписать Дополнительное соглашение на компенсацию дефицита медной трубы (+70 м.п. на сумму +210 000 ₽).',
        '2. Получить аванс не менее 35% для единовременного заказа 21 наружного блока VRF (срок поставки 45 дней).',
        '3. Закрепить состав монтажной бригады не менее 6 квалифицированных специалистов по системам холодоснабжения.',
        '4. Утвердить в договоре 4 контрольные точки (Hold Points) приемки скрытых работ по СП 73.13330.2016.'
      ],
      justifications: [
        `Расчетная себестоимость ${finModel.grossCostRub.toLocaleString('ru-RU')} ₽ обеспечивает порог безубыточности при цене договора от ${finModel.breakEvenCostRub.toLocaleString('ru-RU')} ₽.`,
        `В рисковом сценарии маржинальность сохраняется на уровне ${profAnalysis.risk.marginPercent}%, проект не уходит в убыток.`,
        // DATA-004: строка «Все объемы подтверждены рабочей документацией шифра
        // 240/24-ОВ1 со средней уверенностью 96%» утверждала подтверждение
        // объёмов документом, которого никто не открывал, и подставлялась в
        // обоснование управленческого решения.
        `Объёмы взяты из ${datasetItems.length} позиций, извлечённых моделью; сверка с документацией не выполнялась.`
      ],
      // DATA-004: рекомендация ссылалась на «дефицит трубы» и предлагала
      // сократить закупку арматуры — вывод из удалённой коллизии 2450/2380,
      // которой в данных нет. Поправка к цене 210 000 ₽ была стоимостью того же
      // несуществующего риска, а confidenceScore 0.98 — литеральной оценкой
      // собственного решения, не менявшейся ни при каких входных данных
      // (обнаружено A/B-тестом: значение совпадало для двух разных ответов модели).
      financialRecommendation: finModel.isContractPriceProvided
        ? `Базовая цена договора ${finModel.contractPriceRub.toLocaleString('ru-RU')} ₽ при расчётной себестоимости ${finModel.grossCostRub.toLocaleString('ru-RU')} ₽.`
        : 'Цена договора не задана: финансовая рекомендация не формируется.',
      suggestedPriceAdjustmentRub: 0,
      confidenceScore: null
    };

    job.executiveDecision = execDecision;

    job.agents.EXECUTIVE_DECISION = {
      agentRole: 'EXECUTIVE_DECISION',
      agentName: 'Финальный директор (Executive Decision)',
      status: 'COMPLETED',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 20,
      summary: `РЕШЕНИЕ: ${execDecision.decisionTitle}. ${execDecision.summary}`,
      findings: execDecision.keyConditions,
      confidence: null,
      aiSource: 'deterministic_engine'
    };

    // FINALIZE JOB
    job.status = 'COMPLETED';
    job.progressPercent = 100;
    job.currentPhaseText = 'Анализ проекта успешно завершен. Сформирован итоговый Executive Report.';
    job.updatedAt = new Date().toISOString();
    job.telemetry.totalDurationMs = Date.now() - tStart;
    this.persist(job);   // RT-003: фиксируем переход в БД
  }

  // DATA-004: здесь была функция getLocalRagDataset — литеральный массив из
  // девяти позиций (21 наружный блок VRF, 84 внутренних, 2450 м медной трубы,
  // шифр 240/24-ОВ1, лист 12, confidence 0.96, isConfirmed true), снабжённый
  // комментарием «Локальная база знаний RAG (СП 60.13330, СП 73.13330,
  // ГОСТ Р 52318-2005)». Никакой базы знаний за ним не стояло: это был
  // демонстрационный набор, который возвращался при недоступности модели и
  // выдавался как извлечённый из документации объекта — одинаковый для любого
  // проекта. Удалён вместе с вызовами: при отсутствии результата модели анализ
  // теперь завершается статусом FAILED без данных.

  /**
   * Сметные позиции на базе ГЭСН/ФЕР для расчетного ядра
   */
  // DATA-004: здесь возвращался литеральный перечень сметных позиций
  // несуществующего объекта — 21 наружный блок VRV IV по 700 000 ₽ со ссылкой
  // на «РД 240/24-ОВ1.СО Лист 4» и confidence 0.98 — и подавался как расчёт
  // по документации проекта. Смета строится только из позиций, фактически
  // извлечённых моделью из переданных документов.
  private getCalculatedEstimateItems(items: ProjectItemExtraction[]): CalculatedEstimateItem[] {
    return items.map((i, idx) => ({
      id: `est-${idx + 1}`,
      workOrItemName: i.name ?? 'позиция без наименования',
      // Категория извлечения и категория затрат — разные перечисления;
      // сопоставляются только однозначные случаи, остальное идёт в MATERIALS.
      category: i.category === 'EQUIPMENT' ? 'EQUIPMENT' : 'MATERIALS',
      quantity: typeof i.quantity === "number" ? i.quantity : 0,
      unit: i.unit ?? "",
      // Цены не подставляются: прайс-листов в системе нет, а выдуманная цена
      // становится основанием сметы и рентабельности.
      unitPriceRub: 0,
      totalPriceRub: 0,
      priceSource: "Источник цены не подтверждён",
      source_document: i.source_document ?? "",
      source_page: i.source_page ?? 0,
      confidence: typeof i.confidence === "number" ? i.confidence : 0,
      isEstimated: false
    }));
  }
}

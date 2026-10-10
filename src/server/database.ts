import { DatabaseSync } from 'node:sqlite';
import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

// Multi-database support: PostgreSQL for production, SQLite for local dev/testing.
// Reads DATABASE_URL environment variable:
// - If set: connects to PostgreSQL (e.g., postgres://user:pass@host:5432/db)
// - If not set: falls back to SQLite file-based storage (data/skkit.db)

export const TABLES = [
  'users', 'sessions', 'audit_log', 'registration_requests', 'projects', 'work_types',
  'unified_control', 'organizations', 'project_members', 'estimates', 'estimate_items',
  'schedule_tasks', 'inspections', 'defects', 'aosr', 'aosr_signatures', 'executive_docs',
  'financial_entries', 'ks_documents', 'ai_analyses', 'notifications', 'contractor_performance'
] as const;

export type TableName = typeof TABLES[number];

const PROJECT_SCOPED_TABLES = new Set<TableName>([
  'unified_control', 'estimates', 'estimate_items', 'schedule_tasks', 'inspections',
  'defects', 'aosr', 'executive_docs', 'financial_entries', 'ks_documents', 'ai_analyses', 'notifications'
]);

let sqliteDb: DatabaseSync | null = null;
let pgPool: Pool | null = null;
let isPostgres = false;

function initSqlite(): DatabaseSync {
  if (sqliteDb) return sqliteDb;

  const dataDir = path.join(process.cwd(), 'data');
  const dbPath = path.join(dataDir, 'skkit.db');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
  sqliteDb.exec('PRAGMA foreign_keys = ON;');

  for (const table of TABLES) {
    const projectCol = PROJECT_SCOPED_TABLES.has(table) ? ', project_id TEXT' : '';
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL${projectCol}
      )
    `);

    if (PROJECT_SCOPED_TABLES.has(table)) {
      sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project_id);`);
    }
  }

  applyAnalysisJobSchema(sqliteDb);

  return sqliteDb;
}

/**
 * RT-003. Статусы, при которых анализ считается выполняющимся.
 *
 * Единственный источник истины для этого перечня: он задаёт и поведение
 * приложения, и частичный уникальный индекс в схеме. Аудит показал, что
 * конвейер проходит шесть состояний, а не три — ANALYZING, CALCULATING и
 * VALIDATING ранее не учитывались, из-за чего задача в этих фазах не считалась
 * активной.
 */
export const ACTIVE_ANALYSIS_STATUSES = [
  'QUEUED', 'PARSING', 'EXTRACTING', 'ANALYZING', 'CALCULATING', 'VALIDATING'
] as const;

export type ActiveAnalysisStatus = typeof ACTIVE_ANALYSIS_STATUSES[number];

const ACTIVE_STATUS_SQL_LIST = ACTIVE_ANALYSIS_STATUSES.map(s => `'${s}'`).join(', ');

/**
 * RT-003. Доводит ai_analyses до состояния, пригодного для хранения задач анализа.
 *
 * Таблица уже создана общим циклом выше в форме (id, data, updated_at,
 * project_id). Добавляется только колонка status: она нужна снаружи JSON,
 * потому что по ней строится индекс — из поля внутри `data` индекс не построить.
 * Остальные два с лишним десятка полей задачи остаются в `data`, поскольку
 * читаются всегда целиком.
 */
/**
 * R3-013. Идентификатор запущенного экземпляра приложения.
 *
 * Нужен, чтобы отличать задачу, которую прямо сейчас выполняет живой процесс,
 * от задачи, оставшейся от процесса, которого больше нет. Без этого различия
 * второй экземпляр, поднятый на той же базе, считал чужую работающую задачу
 * прерванной и переводил её в FAILED.
 */
export const INSTANCE_ID = `inst-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Срок владения задачей. Владелец продлевает его, пока работает; после
 * остановки процесса срок истекает сам, и задача становится доступной для
 * восстановления.
 *
 * Нижняя граница задана таймаутом обращения к модели
 * (GLOBAL_REQUEST_DEADLINE_MS = 15 с) — это самый долгий отрезок, на котором
 * конвейер не обновляет запись. Взято с четырёхкратным запасом.
 */
export const ANALYSIS_LEASE_MS = 60_000;

function applyAnalysisJobSchema(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(ai_analyses)`).all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'status')) {
    db.exec(`ALTER TABLE ai_analyses ADD COLUMN status TEXT NOT NULL DEFAULT 'QUEUED'`);
  }

  // R3-013. Владение задачей: кто её исполняет и до какого момента это владение
  // действительно. Обе колонки допускают NULL — записи, созданные до появления
  // владения, считаются бесхозными и восстанавливаются как прежде.
  if (!columns.some(c => c.name === 'owner_id')) {
    db.exec(`ALTER TABLE ai_analyses ADD COLUMN owner_id TEXT`);
  }
  if (!columns.some(c => c.name === 'lease_until')) {
    db.exec(`ALTER TABLE ai_analyses ADD COLUMN lease_until TEXT`);
  }

  // Инвариант RT-002 на уровне схемы: для одного проекта не может существовать
  // двух незавершённых задач. Держит его база, а не код, поэтому нарушение
  // невозможно даже в обход прикладной проверки.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_analyses_one_active_per_project
      ON ai_analyses(project_id)
      WHERE status IN (${ACTIVE_STATUS_SQL_LIST})
  `);

  // Выборка последней задачи проекта.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ai_analyses_project_updated
      ON ai_analyses(project_id, updated_at DESC)
  `);
}

async function initPostgres(): Promise<Pool> {
  if (pgPool) return pgPool;

  const databaseUrl = process.env.DATABASE_URL || '';
  pgPool = new Pool({ connectionString: databaseUrl });

  const client = await pgPool.connect();
  try {
    for (const table of TABLES) {
      const projectCol = PROJECT_SCOPED_TABLES.has(table) ? ', project_id TEXT' : '';
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TEXT NOT NULL${projectCol}
        )
      `);

      if (PROJECT_SCOPED_TABLES.has(table)) {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project_id);`);
      }
    }

    console.log('[Database] PostgreSQL initialized and ready');
  } finally {
    client.release();
  }

  return pgPool;
}

export async function initDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    // The PostgreSQL backend below is implemented but NOT wired into the
    // application: every call site in server.ts uses the synchronous dbUpsert/
    // dbLoadAll/dbExists/... family (72 of them), and each of those throws
    // "Use ...Async for PostgreSQL" once isPostgres is true. Nothing anywhere
    // calls the *Async variants. Enabling this path therefore does not give a
    // working Postgres deployment — it gives a server that boots and then
    // throws on its first database touch, which is far worse than refusing.
    //
    // Fail here, with the reason, until the call sites are migrated.
    throw new Error(
      '[Database] DATABASE_URL is set, but the PostgreSQL backend is not wired ' +
      'into the application yet: all 72 call sites still use the synchronous ' +
      'SQLite API, which throws under PostgreSQL. Unset DATABASE_URL to run on ' +
      'SQLite, or migrate the call sites to the *Async variants first.'
    );
  }

  isPostgres = false;
  initSqlite();
  console.log('[Database] Using SQLite');
}

export function dbExists(table: TableName, id: string): boolean {
  if (isPostgres) {
    throw new Error('Use dbExistsAsync for PostgreSQL');
  }

  const row = initSqlite().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  return !!row;
}

export async function dbExistsAsync(table: TableName, id: string): Promise<boolean> {
  if (!isPostgres) {
    return dbExists(table, id);
  }

  const pool = await initPostgres();
  const result = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  return result.rows.length > 0;
}

export function dbUpsert<T extends Record<string, any>>(table: TableName, id: string, data: T): void {
  if (isPostgres) {
    throw new Error('Use dbUpsertAsync for PostgreSQL');
  }

  const database = initSqlite();
  const json = JSON.stringify(data);
  const now = new Date().toISOString();

  if (PROJECT_SCOPED_TABLES.has(table)) {
    const projectId = (data as any)?.projectId ?? null;
    database.prepare(
      `INSERT INTO ${table} (id, data, updated_at, project_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, project_id = excluded.project_id`
    ).run(id, json, now, projectId);
  } else {
    database.prepare(
      `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).run(id, json, now);
  }
}

export async function dbUpsertAsync<T extends Record<string, any>>(
  table: TableName,
  id: string,
  data: T
): Promise<void> {
  if (!isPostgres) {
    return dbUpsert(table, id, data);
  }

  const pool = await initPostgres();
  const projectId = PROJECT_SCOPED_TABLES.has(table) ? (data as any).projectId : null;
  const now = new Date().toISOString();

  const projectCol = projectId ? ', project_id' : '';
  const projectVal = projectId ? `, $4` : '';
  const params = projectId ? [id, JSON.stringify(data), now, projectId] : [id, JSON.stringify(data), now];

  await pool.query(
    `INSERT INTO ${table} (id, data, updated_at${projectCol})
     VALUES ($1, $2, $3${projectVal})
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    params
  );
}

export function dbLoadAll<T = any>(table: TableName): Array<{ id: string; data: T; updatedAt: string }> {
  if (isPostgres) {
    throw new Error('Use dbLoadAllAsync for PostgreSQL');
  }

  const rows = initSqlite()
    .prepare(`SELECT id, data, updated_at as updatedAt FROM ${table}`)
    .all() as any[];
  return rows.map(r => ({ id: r.id, data: JSON.parse(r.data) as T, updatedAt: r.updatedAt }));
}

export async function dbLoadAllAsync<T>(table: TableName): Promise<{ id: string; data: T }[]> {
  if (!isPostgres) {
    return dbLoadAll(table);
  }

  const pool = await initPostgres();
  const result = await pool.query(`SELECT id, data FROM ${table}`);

  return result.rows.map((row: any) => ({
    id: row.id,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  }));
}

export function dbLoadByProject<T = any>(table: TableName, projectId: string): Array<{ id: string; data: T; updatedAt: string }> {
  if (isPostgres) {
    throw new Error('Use dbLoadByProjectAsync for PostgreSQL');
  }

  if (!PROJECT_SCOPED_TABLES.has(table)) {
    throw new Error(`Table ${table} is not project-scoped`);
  }

  const rows = initSqlite()
    .prepare(`SELECT id, data, updated_at as updatedAt FROM ${table} WHERE project_id = ?`)
    .all(projectId) as any[];
  return rows.map(r => ({ id: r.id, data: JSON.parse(r.data) as T, updatedAt: r.updatedAt }));
}

export async function dbLoadByProjectAsync<T>(
  table: TableName,
  projectId: string
): Promise<{ id: string; data: T }[]> {
  if (!isPostgres) {
    return dbLoadByProject(table, projectId);
  }

  if (!PROJECT_SCOPED_TABLES.has(table)) {
    throw new Error(`Table ${table} is not project-scoped`);
  }

  const pool = await initPostgres();
  const result = await pool.query(`SELECT id, data FROM ${table} WHERE project_id = $1`, [projectId]);

  return result.rows.map((row: any) => ({
    id: row.id,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  }));
}

// ---------------------------------------------------------------------------
// RT-003 — хранение задач анализа проекта.
//
// Общие dbUpsert/dbLoadAll здесь не подходят: они кладут в таблицу только
// (id, data, updated_at, project_id) и не знают про колонку status, по которой
// построен частичный уникальный индекс. Операции ниже — тонкая надстройка над
// той же таблицей, а не второй слой хранения.
// ---------------------------------------------------------------------------

export interface AnalysisJobRow {
  id: string;
  projectId: string;
  status: string;
  updatedAt: string;
  data: any;
  /** R3-013.1 (D3). Нужен читающим, чтобы отличить свою задачу от чужой. */
  ownerId: string | null;
}

/** Общий перечень колонок: читающим нужен owner_id, иначе кэш нечем сверить с базой. */
const ANALYSIS_JOB_COLUMNS = 'id, data, updated_at, project_id, status, owner_id';

function rowToJob(row: any): AnalysisJobRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    status: row.status as string,
    updatedAt: row.updated_at as string,
    data: JSON.parse(row.data as string),
    ownerId: (row.owner_id as string | null) ?? null
  };
}

/** Признак нарушения частичного уникального индекса — второй активный анализ проекта. */
export function isActiveAnalysisConflict(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? '');
  return msg.includes('UNIQUE constraint failed') && msg.includes('ai_analyses');
}

/**
 * Вставка новой задачи. Намеренно INSERT, а не UPSERT: попытка создать вторую
 * активную задачу проекта обязана упереться в индекс, а не молча перезаписать
 * существующую.
 */
export function dbInsertAnalysisJob(job: { analysisId: string; projectId: string; status: string }, data: any): void {
  const db = initSqlite();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO ai_analyses (id, data, updated_at, project_id, status, owner_id, lease_until)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // R3-013: задача сразу помечается владельцем — с этого момента чужой процесс
  // не вправе объявить её прерванной.
  stmt.run(
    job.analysisId, JSON.stringify(data), new Date(now).toISOString(),
    job.projectId, job.status, INSTANCE_ID, new Date(now + ANALYSIS_LEASE_MS).toISOString()
  );
}

/**
 * R3-013. Продление владения задачами, которые этот процесс исполняет прямо
 * сейчас. Вызывается по таймеру: пока процесс жив, срок владения не истекает,
 * и другой экземпляр не сочтёт задачу брошенной.
 */
export function dbRenewAnalysisLease(analysisIds: string[]): void {
  if (analysisIds.length === 0) return;
  const db = initSqlite();
  const until = new Date(Date.now() + ANALYSIS_LEASE_MS).toISOString();
  const stmt = db.prepare(
    `UPDATE ai_analyses SET lease_until = ? WHERE id = ? AND owner_id = ?`
  );
  for (const id of analysisIds) stmt.run(until, id, INSTANCE_ID);
}

/**
 * R3-013. Задачи, пригодные для восстановления: активные и при этом брошенные —
 * либо без владельца (созданы до появления владения), либо со сроком владения,
 * истёкшим к текущему моменту.
 *
 * Задачи живого процесса под это условие не подпадают, поэтому второй
 * экземпляр, поднятый на той же базе, их не трогает.
 */
export function dbListOrphanedAnalysisJobs(): AnalysisJobRow[] {
  const db = initSqlite();
  const now = new Date().toISOString();
  const rows = db.prepare(
    `SELECT ${ANALYSIS_JOB_COLUMNS} FROM ai_analyses
     WHERE status IN (${ACTIVE_STATUS_SQL_LIST})
       AND (owner_id IS NULL OR lease_until IS NULL OR lease_until < ?)`
  ).all(now);
  return rows.map(rowToJob);
}

/**
 * Обновление задачи: статус и полезная нагрузка пишутся вместе, одним оператором.
 * Раздельная запись оставила бы окно, в котором индекс видит один статус, а
 * `data` — другой.
 */
/**
 * R3-013.1 (D4). Запись владельцем. Раньше здесь не было условия по владельцу,
 * и процесс, у которого владение уже перехватили, продолжал управлять задачей
 * как ни в чём не бывало — записывая поверх состояния, выставленного тем, кто
 * задачу восстановил.
 *
 * Условие допускает три случая: владение наше, владения нет вовсе (запись
 * создана до появления владения) или срок истёк, но задачу ещё никто не
 * перехватил — в последнем случае владелец законно продлевает своё же владение.
 * Перехваченную другим процессом задачу изменить нельзя.
 *
 * Возвращает признак того, что строка действительно изменена: вызывающая
 * сторона обязана узнать, что владение утрачено, а не считать запись успешной.
 */
export function dbUpdateAnalysisJob(analysisId: string, status: string, data: any): boolean {
  const db = initSqlite();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const active = (ACTIVE_ANALYSIS_STATUSES as readonly string[]).includes(status);

  const stmt = db.prepare(
    `UPDATE ai_analyses
        SET data = ?, status = ?, updated_at = ?, owner_id = ?, lease_until = ?
      WHERE id = ?
        AND (owner_id IS NULL OR owner_id = ? OR lease_until IS NULL OR lease_until < ?)`
  );
  const res = stmt.run(
    JSON.stringify(data), status, nowIso,
    active ? INSTANCE_ID : null,
    active ? new Date(now + ANALYSIS_LEASE_MS).toISOString() : null,
    analysisId, INSTANCE_ID, nowIso
  );
  return Number(res.changes) > 0;
}

/**
 * R3-013.1 (D4). Захват брошенной задачи для восстановления.
 *
 * Условие и захват выполняются одним оператором, поэтому при одновременной
 * ревизии в нескольких процессах строку получит ровно один: второму UPDATE уже
 * не подойдёт под условие, и он увидит changes = 0. Отдельная функция нужна
 * именно потому, что у восстановления и у обычной записи владельцем условия
 * противоположны — одно захватывает чужое брошенное, другое защищает своё.
 */
export function dbClaimAbandonedAnalysisJob(analysisId: string, data: any): boolean {
  const db = initSqlite();
  const nowIso = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE ai_analyses
        SET data = ?, status = 'FAILED', updated_at = ?, owner_id = NULL, lease_until = NULL
      WHERE id = ?
        AND status IN (${ACTIVE_STATUS_SQL_LIST})
        AND (owner_id IS NULL OR lease_until IS NULL OR lease_until < ?)`
  );
  const res = stmt.run(JSON.stringify(data), nowIso, analysisId, nowIso);
  return Number(res.changes) > 0;
}

/**
 * R3-013.1 (D2/D5). Временная недоступность базы: другой писатель держит блокировку.
 *
 * Отличается от прочих ошибок намеренно: contention проходит сама и повтор
 * уместен, тогда как повреждение файла или ошибка в запросе повтором не
 * лечатся и маскировать их нельзя.
 */
export function isTransientDbContention(err: unknown): boolean {
  const e = err as { code?: string; errcode?: number; message?: string };
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || e?.errcode === 5 || e?.errcode === 6
    || /database is locked|database table is locked/i.test(msg);
}

export function dbGetAnalysisJob(analysisId: string): AnalysisJobRow | null {
  const db = initSqlite();
  const row = db.prepare(`SELECT ${ANALYSIS_JOB_COLUMNS} FROM ai_analyses WHERE id = ?`).get(analysisId);
  return row ? rowToJob(row) : null;
}

/** Последняя по времени обновления задача проекта. */
export function dbGetLatestAnalysisJob(projectId: string): AnalysisJobRow | null {
  const db = initSqlite();
  const row = db.prepare(
    `SELECT ${ANALYSIS_JOB_COLUMNS} FROM ai_analyses
     WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`
  ).get(projectId);
  return row ? rowToJob(row) : null;
}

/** Незавершённая задача проекта, если она есть. Индекс гарантирует, что она одна. */
export function dbGetActiveAnalysisJob(projectId: string): AnalysisJobRow | null {
  const db = initSqlite();
  const row = db.prepare(
    `SELECT ${ANALYSIS_JOB_COLUMNS} FROM ai_analyses
     WHERE project_id = ? AND status IN (${ACTIVE_STATUS_SQL_LIST}) LIMIT 1`
  ).get(projectId);
  return row ? rowToJob(row) : null;
}

export function dbListActiveAnalysisJobs(): AnalysisJobRow[] {
  const db = initSqlite();
  const rows = db.prepare(
    `SELECT ${ANALYSIS_JOB_COLUMNS} FROM ai_analyses WHERE status IN (${ACTIVE_STATUS_SQL_LIST})`
  ).all();
  return rows.map(rowToJob);
}

export function dbDelete(table: TableName, id: string): void {
  if (isPostgres) {
    throw new Error('Use dbDeleteAsync for PostgreSQL');
  }

  initSqlite().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

export async function dbDeleteAsync(table: TableName, id: string): Promise<void> {
  if (!isPostgres) {
    return dbDelete(table, id);
  }

  const pool = await initPostgres();
  await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

export function dbCount(table: TableName): number {
  if (isPostgres) {
    throw new Error('Use dbCountAsync for PostgreSQL');
  }

  const row = initSqlite().prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
  return row.c as number;
}

export async function dbCountAsync(table: TableName): Promise<number> {
  if (!isPostgres) {
    return dbCount(table);
  }

  const pool = await initPostgres();
  const result = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);

  return parseInt(result.rows[0].count, 10);
}

export function createRealBackup(): { path: string; sizeBytes: number; createdAt: string } {
  if (isPostgres) {
    throw new Error('PostgreSQL backup not yet implemented — use pg_dump / managed snapshots');
  }

  const database = initSqlite();
  const backupDir = path.join(process.cwd(), 'data', 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const createdAt = new Date().toISOString();
  const fileName = `skkit-${createdAt.replace(/[:.]/g, '-')}.db`;
  const backupPath = path.join(backupDir, fileName);

  // node:sqlite's DatabaseSync has no online-backup API, so force a WAL
  // checkpoint (flush pending writes into the main file) before copying —
  // without it the copy can miss committed transactions still in the WAL.
  database.exec('PRAGMA wal_checkpoint(FULL);');
  fs.copyFileSync(path.join(process.cwd(), 'data', 'skkit.db'), backupPath);

  return { path: backupPath, sizeBytes: fs.statSync(backupPath).size, createdAt };
}

export function listBackups(): Array<{ fileName: string; sizeBytes: number; createdAt: string }> {
  const backupDir = path.join(process.cwd(), 'data', 'backups');
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { fileName: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function restoreFromBackup(fileName: string): void {
  if (isPostgres) {
    throw new Error('PostgreSQL restore not yet implemented — use managed snapshot restore');
  }

  const backupPath = path.join(process.cwd(), 'data', 'backups', fileName);
  const dbPath = path.join(process.cwd(), 'data', 'skkit.db');

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Файл резервной копии не найден: ${fileName}`);
  }

  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }

  fs.copyFileSync(backupPath, dbPath);

  // Drop stale WAL/SHM sidecar files from before the restore so the copied
  // main db file is read as-is on reopen.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }

  initSqlite();
}

export async function closeDatabase(): Promise<void> {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }

  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
}

// Repository layer for the "field work" cluster: schedule, inspections,
// defects. Grouped in one file (not one-file-per-entity) — each is small
// and they're used together by the same views.
import crypto from 'crypto';
import { dbUpsert, dbLoadByProject } from '../database';

export interface ScheduleTask {
  id: string;
  projectId: string;
  wbsCode: string;
  title: string;
  section: string;
  startDate: string;
  finishDate: string;
  forecastFinishDate: string;
  durationDays: number;
  plannedVolume: number;
  actualVolume: number;
  unit: string;
  progressPercent: number;
  spi?: number;
  isCriticalPath: boolean;
  predecessorIds: string[];
  assignedContractorId?: string;
  assignedContractorName?: string;
  responsiblePerson?: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'HOLD_POINT_BLOCKED' | 'COMPLETED' | 'DELAYED';
  holdPointRequired: boolean;
  holdPointPassed: boolean;
  lastInspectionDate?: string;
  createdAt: string;
  updatedAt: string;
}

export function listScheduleTasks(projectId: string): ScheduleTask[] {
  return dbLoadByProject<ScheduleTask>('schedule_tasks', projectId).map(r => r.data);
}

export function createScheduleTask(input: Omit<ScheduleTask, 'id' | 'createdAt' | 'updatedAt'>): ScheduleTask {
  const now = new Date().toISOString();
  const task: ScheduleTask = { ...input, id: `sch-${crypto.randomBytes(6).toString('hex')}`, createdAt: now, updatedAt: now };
  dbUpsert('schedule_tasks', task.id, task);
  return task;
}

export function updateScheduleTask(id: string, projectId: string, patch: Partial<ScheduleTask>): ScheduleTask | null {
  const existing = listScheduleTasks(projectId).find(t => t.id === id);
  if (!existing) return null;
  const updated: ScheduleTask = { ...existing, ...patch, id, projectId, updatedAt: new Date().toISOString() };
  dbUpsert('schedule_tasks', id, updated);
  return updated;
}

// ---------------------------------------------------------------------------

export interface Inspection {
  id: string;
  projectId: string;
  workId?: string;
  taskId?: string;
  workName?: string;
  inspectorId: string;   // from session — never from request body
  inspectorName: string;
  inspectorRole?: string;
  inspectionType: string;
  inspectionDate: string;
  pointType: 'STANDARD' | 'WITNESS_POINT' | 'HOLD_POINT';
  isHoldPointSatisfied: boolean;
  result: 'PASSED' | 'FAILED' | 'REWORK_REQUIRED' | 'UNDER_REVIEW';
  findings: string;
  regulatoryBasis?: string;
  designDocReference?: string;
  location?: { building?: string; floor?: string | number; room?: string; axes?: string };
  contractorOrgId?: string;
  contractorOrgName?: string;
  actNumberSigned?: string;
  measurements?: Array<{ parameter: string; standardValue: string; actualValue: string; pass: boolean }>;
  photoIds: string[];
  defectsGeneratedIds: string[];
  createdAt: string;
}

export function listInspections(projectId: string): Inspection[] {
  return dbLoadByProject<Inspection>('inspections', projectId).map(r => r.data);
}

export function createInspection(input: Omit<Inspection, 'id' | 'createdAt' | 'defectsGeneratedIds'>): Inspection {
  const inspection: Inspection = { ...input, id: `insp-${crypto.randomBytes(6).toString('hex')}`, defectsGeneratedIds: [], createdAt: new Date().toISOString() };
  dbUpsert('inspections', inspection.id, inspection);
  return inspection;
}

export function updateInspectionResult(id: string, projectId: string, patch: { result?: Inspection['result']; isHoldPointSatisfied?: boolean }): Inspection | null {
  const existing = listInspections(projectId).find(i => i.id === id);
  if (!existing) return null;
  const updated: Inspection = { ...existing, ...patch };
  dbUpsert('inspections', id, updated);
  return updated;
}

export function linkDefectToInspection(inspectionId: string, projectId: string, defectId: string): void {
  const inspection = listInspections(projectId).find(i => i.id === inspectionId);
  if (!inspection) return;
  inspection.defectsGeneratedIds = [...inspection.defectsGeneratedIds, defectId];
  dbUpsert('inspections', inspectionId, inspection);
}

// ---------------------------------------------------------------------------

export interface DefectAuditEntry {
  timestamp: string;
  author: string;
  action: string;
  comment: string;
}

export interface Defect {
  id: string;
  projectId: string;
  workId?: string;
  inspectionId?: string;
  defectNumber: string;
  title: string;
  description: string;
  category: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  sourceType: string;
  contractorOrgId?: string;
  contractorOrgName?: string;
  responsiblePersonName?: string;
  issuedByInspectorName?: string;
  issuedByUserId: string;   // from session — never from request body
  issuedByName: string;
  issuedDate: string;
  deadlineDate: string;
  closedDate?: string;
  status: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'REJECTED' | 'CLOSED';
  location?: { building?: string; floor?: string | number; room?: string; axes?: string };
  reinspectionNotes?: string;
  reinspectionCount: number;
  beforePhotoUrls: string[];
  afterPhotoUrls: string[];
  auditTrail: DefectAuditEntry[];
}

let defectSequence = 0;

export function listDefects(projectId: string): Defect[] {
  return dbLoadByProject<Defect>('defects', projectId).map(r => r.data);
}

export function createDefect(input: Omit<Defect, 'id' | 'defectNumber' | 'status' | 'reinspectionCount' | 'auditTrail'>): Defect {
  defectSequence += 1;
  const year = new Date().getFullYear();
  const defect: Defect = {
    ...input,
    id: `def-${crypto.randomBytes(6).toString('hex')}`,
    defectNumber: `ЗАМ-${year}-${String(defectSequence).padStart(4, '0')}`,
    status: 'OPEN',
    reinspectionCount: 0,
    auditTrail: [{ timestamp: new Date().toISOString(), author: input.issuedByName, action: 'CREATE', comment: 'Замечание зарегистрировано' }]
  };
  dbUpsert('defects', defect.id, defect);
  return defect;
}

export function updateDefectStatus(id: string, projectId: string, status: Defect['status'], author: string, comment: string, afterPhotoUrl?: string): Defect | null {
  const existing = listDefects(projectId).find(d => d.id === id);
  if (!existing) return null;
  const updated: Defect = {
    ...existing,
    status,
    closedDate: status === 'CLOSED' ? new Date().toISOString() : existing.closedDate,
    afterPhotoUrls: afterPhotoUrl ? [...existing.afterPhotoUrls, afterPhotoUrl] : existing.afterPhotoUrls,
    reinspectionCount: status === 'REJECTED' ? existing.reinspectionCount + 1 : existing.reinspectionCount,
    auditTrail: [...existing.auditTrail, { timestamp: new Date().toISOString(), author, action: 'UPDATE', comment }]
  };
  dbUpsert('defects', id, updated);
  return updated;
}

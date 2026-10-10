// КС-2 (акт о приёмке выполненных работ) / КС-3 (справка о стоимости) as a
// real persistent entity with a server-enforced approval state machine —
// same pattern as src/server/repositories/aosr.ts. Before this, FinanceView
// only ever mutated local mock state (INITIAL_KS_DOCUMENTS) and the "approve"
// action picked the next status by branching on the CALLER's own role
// client-side (CUSTOMER -> SIGNED_CUSTOMER, everyone else -> APPROVED_SUPERVISOR),
// the same "UI decides the transition" anti-pattern fixed for AOSR.
import crypto from 'crypto';
import { dbUpsert, dbLoadByProject } from '../database';

export type KsDocStatus = 'DRAFT' | 'VERIFIED_PTO' | 'APPROVED_SUPERVISOR' | 'SIGNED_CUSTOMER' | 'PAID';

export interface Ks2Item {
  id: string;
  estimateItemId?: string;
  workName: string;
  unit: string;
  quantityExecuted: number;
  unitPriceRub: number;
  totalSumRub: number;
  aoSrConfirmed: boolean;
}

export interface KsDocument {
  id: string;
  projectId: string;
  docType: 'KS2' | 'KS3';
  docNumber: string;
  periodStart: string;
  periodEnd: string;
  contractorOrgId: string;
  contractorOrgName: string;
  totalSumWithoutVatRub: number;
  vatAmountRub: number;
  totalSumWithVatRub: number;
  status: KsDocStatus;
  items: Ks2Item[];
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export function listKsDocuments(projectId: string): KsDocument[] {
  return dbLoadByProject<KsDocument>('ks_documents', projectId).map(r => r.data);
}

export function getKsDocument(id: string, projectId: string): KsDocument | null {
  const doc = listKsDocuments(projectId).find(d => d.id === id);
  return doc || null;
}

export function createKsDocument(input: {
  projectId: string; docType: 'KS2' | 'KS3'; docNumber: string; periodStart: string; periodEnd: string;
  contractorOrgId: string; contractorOrgName: string; items: Omit<Ks2Item, 'id' | 'totalSumRub'>[];
  createdByUserId: string;
}): KsDocument {
  const now = new Date().toISOString();
  const items: Ks2Item[] = input.items.map(it => ({
    ...it,
    id: `ks2i-${crypto.randomBytes(6).toString('hex')}`,
    totalSumRub: Number((it.quantityExecuted * it.unitPriceRub).toFixed(2))
  }));
  const totalSumWithoutVatRub = Number(items.reduce((s, i) => s + i.totalSumRub, 0).toFixed(2));
  const vatAmountRub = Number((totalSumWithoutVatRub * 0.2).toFixed(2));
  const doc: KsDocument = {
    id: `ks-${crypto.randomBytes(6).toString('hex')}`,
    projectId: input.projectId,
    docType: input.docType,
    docNumber: input.docNumber,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    contractorOrgId: input.contractorOrgId,
    contractorOrgName: input.contractorOrgName,
    totalSumWithoutVatRub,
    vatAmountRub,
    totalSumWithVatRub: Number((totalSumWithoutVatRub + vatAmountRub).toFixed(2)),
    status: 'DRAFT',
    items,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now
  };
  dbUpsert('ks_documents', doc.id, doc);
  return doc;
}

// Each real UserRole that can advance a KS document to the next stage, and
// which stored status is required for that role's action to be valid.
// Keyed by role (not by target status) — the server derives the transition,
// the client never gets to pick one. Deliberately NOT keyed by ADMIN/
// CHIEF_ENGINEER despite their broad can() permissions elsewhere — same
// principle as AOSR's NEXT_STAGE (src/server/repositories/aosr.ts): a
// multi-party sign-off chain should not be forgeable by an administrative
// override, only the real holder of each specific role can advance their
// own stage.
const NEXT_STAGE: Partial<Record<string, KsDocStatus>> = {
  PTO_ENGINEER: 'VERIFIED_PTO',
  CONSTRUCTION_CONTROL: 'APPROVED_SUPERVISOR',
  CUSTOMER: 'SIGNED_CUSTOMER'
};

const REQUIRED_PRIOR_STATUS: Partial<Record<string, KsDocStatus>> = {
  PTO_ENGINEER: 'DRAFT',
  CONSTRUCTION_CONTROL: 'VERIFIED_PTO',
  CUSTOMER: 'APPROVED_SUPERVISOR'
};

// PAID is a distinct, separate action (recording an actual payment having
// been made) rather than part of the approval chain above — restricted to
// ADMIN/SUPER_ADMIN at the route level, not modeled as a "role signs" stage.
export function advanceKsDocument(id: string, projectId: string, role: string): { ok: true; doc: KsDocument } | { ok: false; error: string } {
  const doc = getKsDocument(id, projectId);
  if (!doc) return { ok: false, error: 'Документ КС не найден' };

  const nextStage = NEXT_STAGE[role];
  const requiredPrior = REQUIRED_PRIOR_STATUS[role];
  if (!nextStage || !requiredPrior) return { ok: false, error: 'Роль не участвует в согласовании КС' };

  if (doc.status !== requiredPrior) {
    return {
      ok: false,
      error: `Недопустимый переход: документ сейчас в статусе "${doc.status}", для согласования ролью ${role} требуется "${requiredPrior}"`
    };
  }

  const updated: KsDocument = { ...doc, status: nextStage, updatedAt: new Date().toISOString() };
  dbUpsert('ks_documents', doc.id, updated);
  return { ok: true, doc: updated };
}

export function markKsDocumentPaid(id: string, projectId: string): { ok: true; doc: KsDocument } | { ok: false; error: string } {
  const doc = getKsDocument(id, projectId);
  if (!doc) return { ok: false, error: 'Документ КС не найден' };
  if (doc.status !== 'SIGNED_CUSTOMER') {
    return { ok: false, error: `Недопустимый переход: оплата возможна только после подписания заказчиком (сейчас "${doc.status}")` };
  }
  const updated: KsDocument = { ...doc, status: 'PAID', updatedAt: new Date().toISOString() };
  dbUpsert('ks_documents', doc.id, updated);
  return { ok: true, doc: updated };
}

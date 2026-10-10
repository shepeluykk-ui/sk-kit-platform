// АОСР (Акт освидетельствования скрытых работ, РД-11-02-2006) as a real
// persistent entity with a server-enforced state machine.
//
// Before Phase 9, /api/aosr/:id/sign was fully stateless: `currentStage`
// came from the client's request body and was trusted directly, so a
// client could claim any stage and skip the sequence (see DATA_INVENTORY.md,
// "critical finding #2"). Now the transition is validated against the real
// stored Aosr.status — the client's opinion about the current stage is
// never consulted.
import crypto from 'crypto';
import { dbUpsert, dbLoadByProject, dbLoadAll } from '../database';

export type AosrStatus = 'DRAFT' | 'SIGNED_BY_CONTRACTOR' | 'SIGNED_BY_TECH_SUPERVISOR' | 'FULLY_APPROVED' | 'REJECTED';

export interface Aosr {
  id: string;
  projectId: string;
  workId?: string;
  workName: string;
  status: AosrStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AosrSignature {
  id: string;
  aosrId: string;
  signedByUserId: string;
  signedByName: string;
  signedByRole: string;
  stage: AosrStatus;
  signedAt: string;
  hashCertificate: string;
}

export function listAosr(projectId: string): Aosr[] {
  return dbLoadByProject<Aosr>('aosr', projectId).map(r => r.data);
}

export function getAosr(id: string): Aosr | null {
  const row = dbLoadAll<Aosr>('aosr').find(r => r.id === id);
  return row ? row.data : null;
}

export function createAosr(input: { projectId: string; workId?: string; workName: string }): Aosr {
  const now = new Date().toISOString();
  const aosr: Aosr = { ...input, id: `aosr-${crypto.randomBytes(6).toString('hex')}`, status: 'DRAFT', createdAt: now, updatedAt: now };
  dbUpsert('aosr', aosr.id, aosr);
  return aosr;
}

// Keyed by the real UserRole strings (src/types/index.ts) — CONSTRUCTION_CONTROL
// is the "Инженер строительного контроля / Технадзор" role; a prior
// 'TECH_SUPERVISOR' key here never matched any actual user's role, which
// silently broke the middle (technical-supervision) sign-off stage.
const NEXT_STAGE: Record<string, AosrStatus> = {
  CONTRACTOR: 'SIGNED_BY_CONTRACTOR',
  CONSTRUCTION_CONTROL: 'SIGNED_BY_TECH_SUPERVISOR',
  CUSTOMER: 'FULLY_APPROVED'
};

const REQUIRED_PRIOR_STATUS: Record<string, AosrStatus> = {
  CONTRACTOR: 'DRAFT',
  CONSTRUCTION_CONTROL: 'SIGNED_BY_CONTRACTOR',
  CUSTOMER: 'SIGNED_BY_TECH_SUPERVISOR'
};

// Attempts to advance the AOSR's real, stored status by one stage for the
// given (authenticated, server-verified) role. Returns an error string if
// the transition is invalid given the ACTUAL current status — not
// whatever a client might have claimed.
export function signAosr(aosrId: string, role: string, signedByUserId: string, signedByName: string): { ok: true; aosr: Aosr; signature: AosrSignature } | { ok: false; error: string } {
  const aosr = getAosr(aosrId);
  if (!aosr) return { ok: false, error: 'АОСР не найден' };

  const nextStage = NEXT_STAGE[role];
  const requiredPrior = REQUIRED_PRIOR_STATUS[role];
  if (!nextStage || !requiredPrior) return { ok: false, error: 'Роль не участвует в подписании АОСР' };

  if (aosr.status !== requiredPrior) {
    return {
      ok: false,
      error: `Недопустимый переход: АОСР сейчас в статусе "${aosr.status}", для подписи ролью ${role} требуется "${requiredPrior}"`
    };
  }

  const updated: Aosr = { ...aosr, status: nextStage, updatedAt: new Date().toISOString() };
  dbUpsert('aosr', aosr.id, updated);

  const signature: AosrSignature = {
    id: `aosrsig-${crypto.randomBytes(6).toString('hex')}`,
    aosrId,
    signedByUserId,
    signedByName,
    signedByRole: role,
    stage: nextStage,
    signedAt: new Date().toISOString(),
    hashCertificate: `GOST-34.10-${crypto.randomBytes(9).toString('hex').toUpperCase()}`
  };
  dbUpsert('aosr_signatures', signature.id, signature);

  return { ok: true, aosr: updated, signature };
}

export function listAosrSignatures(aosrId: string): AosrSignature[] {
  return dbLoadAll<AosrSignature>('aosr_signatures').map(r => r.data).filter(s => s.aosrId === aosrId);
}

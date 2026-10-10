// Financial entries — the primary source of truth for a project's actual
// money (budget lines, КС-2/КС-3, payments). Kept strictly separate from AI
// analysis output (ai_analyses table / ProjectAnalysisJob.financialModel),
// which is derived analytics, not primary financial data — see
// DOMAIN_MODEL.md, "Financial vs AI".
import crypto from 'crypto';
import Decimal from 'decimal.js';
import { dbUpsert, dbLoadByProject } from '../database';
import { listKsDocuments } from './ksDocuments';

export type FinancialEntryType = 'BUDGET' | 'ESTIMATE_COST' | 'ACTUAL_COST' | 'KS2' | 'KS3' | 'PAYMENT';

export interface FinancialEntry {
  id: string;
  projectId: string;
  entryType: FinancialEntryType;
  amountRub: number;
  relatedEstimateItemId?: string;
  relatedWorkId?: string;
  periodStart?: string;
  periodEnd?: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'PAID';
  createdByUserId: string; // from session — never from request body
  createdByName: string;
  createdAt: string;
}

export function listFinancialEntries(projectId: string): FinancialEntry[] {
  return dbLoadByProject<FinancialEntry>('financial_entries', projectId).map(r => r.data);
}

export function createFinancialEntry(input: Omit<FinancialEntry, 'id' | 'createdAt' | 'status'> & { status?: FinancialEntry['status'] }): FinancialEntry {
  const entry: FinancialEntry = {
    ...input,
    id: `fin-${crypto.randomBytes(6).toString('hex')}`,
    status: input.status || 'DRAFT',
    createdAt: new Date().toISOString()
  };
  dbUpsert('financial_entries', entry.id, entry);
  return entry;
}

// Aggregate summary — what Project.budgetContractRub/executedRub/paidRub etc.
// are derived from, instead of being separately-mutable fields that can
// drift from reality (see DOMAIN_MODEL.md).
// Uses Decimal.js for precise financial calculations (no floating-point errors).
export function summarizeProjectFinancials(projectId: string) {
  const entries = listFinancialEntries(projectId);
  const sum = (type: FinancialEntryType, status?: FinancialEntry['status']) => {
    return entries
      .filter(e => e.entryType === type && (!status || e.status === status))
      .reduce((s, e) => s.plus(new Decimal(e.amountRub)), new Decimal(0))
      .toNumber();
  };

  // "Принято технадзором" is primarily driven by the real КС-2/КС-3
  // documents (src/server/repositories/ksDocuments.ts) once a document has
  // cleared the supervisor stage — not by a separately-entered KS2/KS3
  // financial_entries row, which would require someone to duplicate the
  // same figure in two places. Legacy KS2/KS3-typed entries (if any) still
  // add on top, so nothing already recorded that way is lost.
  const acceptedFromKsDocuments = listKsDocuments(projectId)
    .filter(d => d.status === 'APPROVED_SUPERVISOR' || d.status === 'SIGNED_CUSTOMER' || d.status === 'PAID')
    .reduce((s, d) => s.plus(new Decimal(d.totalSumWithVatRub)), new Decimal(0))
    .toNumber();

  const ks2ks3Sum = new Decimal(sum('KS2', 'APPROVED')).plus(new Decimal(sum('KS3', 'APPROVED'))).plus(new Decimal(acceptedFromKsDocuments)).toNumber();

  return {
    budgetContractRub: sum('BUDGET'),
    budgetEstimateRub: sum('ESTIMATE_COST'),
    executedRub: sum('ACTUAL_COST'),
    acceptedRub: ks2ks3Sum,
    paidRub: sum('PAYMENT', 'PAID')
  };
}

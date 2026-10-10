// Dedicated API client for КС-2/КС-3 documents (Phase 9L.2, Financial
// module), same pattern as src/api/estimates.ts. Identity/authorization is
// never decided here — only the session's Bearer token is sent, the backend
// (requireAuth/requireProjectAccess/requireRole + the real advance state
// machine in src/server/repositories/ksDocuments.ts) is the sole authority.
import type { KsDocument } from '../types';

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
}

function authHeaders(token: string | null): Record<string, string> {
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

// Raw backend shape (src/server/repositories/ksDocuments.ts KsDocument) —
// has a real `items` array instead of the frontend's `itemsCount` number.
export interface BackendKsDocument {
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
  status: 'DRAFT' | 'VERIFIED_PTO' | 'APPROVED_SUPERVISOR' | 'SIGNED_CUSTOMER' | 'PAID';
  items: Array<{ id: string; workName: string; unit: string; quantityExecuted: number; unitPriceRub: number; totalSumRub: number; aoSrConfirmed: boolean }>;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export function mapKsDocument(b: BackendKsDocument): KsDocument {
  return {
    id: b.id,
    projectId: b.projectId,
    docType: b.docType,
    docNumber: b.docNumber,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    contractorOrgId: b.contractorOrgId,
    contractorOrgName: b.contractorOrgName,
    totalSumWithoutVatRub: b.totalSumWithoutVatRub,
    vatAmountRub: b.vatAmountRub,
    totalSumWithVatRub: b.totalSumWithVatRub,
    status: b.status,
    itemsCount: b.items.length,
    createdAt: b.createdAt
  };
}

export async function fetchKsDocuments(projectId: string, token: string | null): Promise<ApiResult<KsDocument[]>> {
  try {
    const res = await fetch(`/api/projects/${projectId}/ks-documents`, { headers: authHeaders(token) });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})`, status: res.status };
    }
    return { success: true, data: (data.documents as BackendKsDocument[]).map(mapKsDocument), status: res.status };
  } catch {
    return { success: false, error: 'Не удалось соединиться с сервером', status: 0 };
  }
}

export async function advanceKsDocument(projectId: string, docId: string, token: string | null): Promise<ApiResult<KsDocument>> {
  try {
    const res = await fetch(`/api/projects/${projectId}/ks-documents/${docId}/advance`, { method: 'POST', headers: authHeaders(token) });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})`, status: res.status };
    }
    return { success: true, data: mapKsDocument(data.document as BackendKsDocument), status: res.status };
  } catch {
    return { success: false, error: 'Не удалось соединиться с сервером', status: 0 };
  }
}

export interface FinancialSummary {
  budgetContractRub: number;
  budgetEstimateRub: number;
  executedRub: number;
  acceptedRub: number;
  paidRub: number;
}

export async function fetchFinancialSummary(projectId: string, token: string | null): Promise<ApiResult<FinancialSummary>> {
  try {
    const res = await fetch(`/api/projects/${projectId}/financial`, { headers: authHeaders(token) });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})`, status: res.status };
    }
    return { success: true, data: data.summary as FinancialSummary, status: res.status };
  } catch {
    return { success: false, error: 'Не удалось соединиться с сервером', status: 0 };
  }
}

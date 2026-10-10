// Dedicated API client for Estimates (Phase 9L.2 hardening). The project
// has no unified API client yet — every other module still calls fetch()
// directly from AppContext.tsx. Per the migration brief, only Estimates is
// extracted here (not a project-wide rewrite); this is the pattern to
// follow when the other modules get the same treatment later.
//
// Identity/authorization is never decided here or by the caller: every
// request carries only the session's Bearer token (never x-user-id/
// x-tenant-id/x-organization-id, never a client-supplied role) — the
// backend (requireAuth/requireProjectAccess/requireRole) is the sole
// authority, exactly as for every other endpoint in this codebase.
import type { EstimateItem, DataStatus } from '../types';

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** HTTP status, so callers can distinguish 401/403/network failure for error UI. */
  status?: number;
}

function authHeaders(token: string | null): Record<string, string> {
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

// Raw backend shape (src/server/repositories/estimates.ts EstimateItem) —
// kept distinct from the frontend EstimateItem type on purpose: the two are
// not identical (backend has estimateId, no documentId/coveragePercent/
// riskScore — those are frontend-only derived fields). mapEstimateItem
// below is the one place that reconciles them, instead of scattering `any`
// through AppContext.
export interface BackendEstimateItem {
  id: string;
  estimateId: string;
  projectId: string;
  itemNumber: string;
  name: string;
  category: 'EQUIPMENT' | 'MATERIAL' | 'WORK';
  unit: string;
  plannedQty: number;
  estimateQty: number;
  actualFactQty: number;
  acceptedQty: number;
  unitPriceRub: number;
  totalPriceRub: number;
  contractorOrgId?: string;
  status: string;
  conflictReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapEstimateItem(b: BackendEstimateItem): EstimateItem {
  return {
    id: b.id,
    projectId: b.projectId,
    documentId: '',
    itemNumber: b.itemNumber,
    name: b.name,
    category: b.category,
    unit: b.unit,
    plannedQty: b.plannedQty,
    estimateQty: b.estimateQty,
    actualFactQty: b.actualFactQty,
    acceptedQty: b.acceptedQty,
    unitPriceRub: b.unitPriceRub,
    totalPriceRub: b.totalPriceRub,
    contractorOrgId: b.contractorOrgId || '',
    status: b.status as DataStatus,
    conflictReason: b.conflictReason,
    coveragePercent: b.plannedQty ? Math.round((b.actualFactQty / b.plannedQty) * 1000) / 10 : 0,
    riskScore: b.status === 'CONFLICT' ? 'HIGH' : 'LOW'
  };
}

export async function fetchEstimateItems(projectId: string, token: string | null): Promise<ApiResult<EstimateItem[]>> {
  try {
    const res = await fetch(`/api/projects/${projectId}/estimate-items`, { headers: authHeaders(token) });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})`, status: res.status };
    }
    return { success: true, data: (data.items as BackendEstimateItem[]).map(mapEstimateItem), status: res.status };
  } catch (err: any) {
    return { success: false, error: 'Не удалось соединиться с сервером', status: 0 };
  }
}

export async function updateEstimateItem(
  projectId: string,
  itemId: string,
  token: string | null,
  patch: { actualFactQty: number; status: DataStatus; conflictReason: string | null }
): Promise<ApiResult<EstimateItem>> {
  try {
    const res = await fetch(`/api/projects/${projectId}/estimate-items/${itemId}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(patch)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})`, status: res.status };
    }
    return { success: true, data: mapEstimateItem(data.item as BackendEstimateItem), status: res.status };
  } catch (err: any) {
    return { success: false, error: 'Не удалось соединиться с сервером', status: 0 };
  }
}

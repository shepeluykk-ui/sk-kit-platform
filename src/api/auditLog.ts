// Dedicated API client for the audit log (Phase 9L.2, final module). Same
// pattern as src/api/estimates.ts / src/api/ksDocuments.ts.
import type { AuditLogEntry } from '../types';

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

// Raw backend shape (server.ts logAudit()) — action is a free-form string
// (e.g. 'ESTIMATE_ITEM_UPDATED', 'AOSR_SIGNED'), not the frontend's old
// 7-value enum, which was never rich enough for the real action types the
// backend actually records.
export interface BackendAuditLogEntry {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  role: string;
  action: string;
  resource: string;
  entityType: string;
  entityId: string;
  projectId: string;
  status: string;
  ipAddress: string;
  details: Record<string, unknown>;
}

export function mapAuditLogEntry(b: BackendAuditLogEntry): AuditLogEntry {
  return {
    id: b.id,
    userId: b.userId,
    userName: b.userName,
    userRole: b.role as AuditLogEntry['userRole'],
    projectId: b.projectId,
    action: b.action,
    entityType: b.entityType,
    entityId: b.entityId,
    newValue: b.status === 'REJECTED' ? `Отклонено: ${(b.details as any)?.reason || b.status}` : (Object.keys(b.details || {}).length ? JSON.stringify(b.details) : b.status),
    ipAddress: b.ipAddress || '—',
    timestamp: b.timestamp,
    source: 'WEB_APP'
  };
}

export async function fetchAuditLogs(token: string | null, projectId?: string): Promise<ApiResult<AuditLogEntry[]>> {
  try {
    const url = projectId ? `/api/audit/logs?projectId=${encodeURIComponent(projectId)}` : '/api/audit/logs';
    const res = await fetch(url, { headers: authHeaders(token) });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})`, status: res.status };
    }
    return { success: true, data: (data.logs as BackendAuditLogEntry[]).map(mapAuditLogEntry), status: res.status };
  } catch {
    return { success: false, error: 'Не удалось соединиться с сервером', status: 0 };
  }
}

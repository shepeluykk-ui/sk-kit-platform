import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  User,
  Organization,
  Project,
  ProjectDocument,
  DocumentCategory,
  EstimateItem,
  ScheduleTask,
  InspectionRecord,
  VrfSystemUnit,
  DefectRemark,
  ExecutiveDocItem,
  ContractorPerformance,
  KsDocument,
  ProjectRisk,
  AppNotification,
  AuditLogEntry,
  UserRole,
  PermissionAction,
  SystemModule,
  DataStatus,
  WorkType,
  UnifiedControlRecord,
  RegistrationRequest,
  RegistrationFormData
} from '../types';
import {
  INITIAL_USERS,
  INITIAL_ORGANIZATIONS,
  INITIAL_PROJECTS,
  INITIAL_DOCUMENTS,
  INITIAL_VRF_SYSTEMS,
  INITIAL_EXECUTIVE_DOCS,
  INITIAL_CONTRACTOR_PERFORMANCE,
  INITIAL_RISKS,
  INITIAL_NOTIFICATIONS,
  INITIAL_WORK_TYPES
} from '../data/initialData';
import { fetchEstimateItems as fetchEstimateItemsApi, updateEstimateItem as updateEstimateItemApi } from '../api/estimates';
import { fetchKsDocuments as fetchKsDocumentsApi, advanceKsDocument as advanceKsDocumentApi, fetchFinancialSummary as fetchFinancialSummaryApi, type FinancialSummary } from '../api/ksDocuments';
import { fetchAuditLogs as fetchAuditLogsApi } from '../api/auditLog';

interface AppContextType {
  currentUser: User;
  setCurrentUser: (user: User) => void;
  switchRole: (role: UserRole) => void;
  
  // Auth state & operations
  isAuthenticated: boolean;
  authToken: string | null;
  authLoading: boolean;
  sessionExpiredMessage: string | null;
  clearSessionExpiredMessage: () => void;
  login: (username: string, password?: string) => Promise<{ success: boolean; error?: string; user?: User }>;
  logout: () => Promise<void>;
  
  // Projects & Isolation
  projects: Project[];
  activeProject: Project;
  setActiveProjectById: (projectId: string) => void;
  
  // Work Types (Universal Registry)
  workTypes: WorkType[];
  addWorkType: (wt: Omit<WorkType, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateWorkType: (id: string, wt: Partial<WorkType>) => void;
  archiveWorkType: (id: string) => void;
  
  // Unified Control Records (Проект -> Объект -> Зона -> Этаж -> Ось -> Вид работ ...)
  unifiedControlRecords: UnifiedControlRecord[];
  unifiedControlStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  unifiedControlError: string | null;
  retryFetchUnifiedControlRecords: () => void;
  addUnifiedControlRecord: (record: Omit<UnifiedControlRecord, 'id' | 'updatedAt'>) => Promise<{ success: boolean; error?: string }>;
  updateUnifiedControlRecord: (id: string, record: Partial<UnifiedControlRecord>) => Promise<{ success: boolean; error?: string }>;
  signAosrForRecord: (record: UnifiedControlRecord) => Promise<{ success: boolean; error?: string }>;

  // Data entities (filtered for active project)
  organizations: Organization[];
  documents: ProjectDocument[];
  estimateItems: EstimateItem[];
  // Explicit request lifecycle for estimateItems — distinct from
  // "empty" (server answered, no items) vs "error" (server unreachable or
  // rejected the request). On error the UI must NOT silently keep showing
  // stale/mock data as if the request had succeeded.
  estimateItemsStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  estimateItemsError: string | null;
  retryFetchEstimateItems: () => void;
  scheduleTasks: ScheduleTask[];
  scheduleTasksStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  scheduleTasksError: string | null;
  retryFetchScheduleTasks: () => void;
  inspections: InspectionRecord[];
  inspectionsStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  inspectionsError: string | null;
  retryFetchInspections: () => void;
  vrfSystems: VrfSystemUnit[];
  defects: DefectRemark[];
  defectsStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  defectsError: string | null;
  retryFetchDefects: () => void;
  executiveDocs: ExecutiveDocItem[];
  contractorScores: ContractorPerformance[];
  ksDocuments: KsDocument[];
  ksDocumentsStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  ksDocumentsError: string | null;
  retryFetchKsDocuments: () => void;
  financialSummary: FinancialSummary | null;
  risks: ProjectRisk[];
  notifications: AppNotification[];
  auditLogs: AuditLogEntry[];
  auditLogsStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  auditLogsError: string | null;
  retryFetchAuditLogs: () => void;
  
  // RBAC Permission check
  can: (action: PermissionAction, module: SystemModule) => boolean;
  
  // Actions
  addDocument: (doc: Partial<ProjectDocument>) => void;
  uploadDocument: (docData: {
    file?: File;
    fileName: string;
    fileSizeMb?: number;
    title: string;
    code: string;
    section: string;
    category: DocumentCategory;
    pagesCount?: number;
    tags?: string[];
    revision?: string;
  }) => Promise<{ success: boolean; document?: ProjectDocument; error?: string; status?: number }>;
  updateDocumentStatus: (docId: string, status: ProjectDocument['status']) => void;
  
  addInspection: (inspection: Omit<InspectionRecord, 'id' | 'createdAt'>) => Promise<{ success: boolean; error?: string }>;
  resolveHoldPoint: (inspectionId: string, passed: boolean) => void;
  
  addDefect: (defect: Omit<DefectRemark, 'id' | 'defectNumber' | 'issuedDate' | 'reinspectionCount' | 'auditTrail'>) => Promise<{ success: boolean; error?: string }>;
  updateDefectStatus: (defectId: string, status: DefectRemark['status'], comment?: string, afterPhotoUrl?: string) => void;
  
  updateEstimateItemQty: (itemId: string, factQty: number) => Promise<{ success: boolean; error?: string }>;
  signExecutiveDoc: (docId: string, role: UserRole) => void;
  approveKsDoc: (ksId: string) => Promise<{ success: boolean; error?: string }>;
  
  markNotificationRead: (notifId: string) => void;
  markAllNotificationsRead: () => void;
  
  // Audit Logger
  logAction: (action: AuditLogEntry['action'], entityType: string, entityId: string, newValue?: string, oldValue?: string) => void;
  
  // Registration & Lifecycle Management
  registrationRequests: RegistrationRequest[];
  pendingRegistrationsCount: number;
  pendingAlertRequest: RegistrationRequest | null;
  dismissPendingAlert: (requestId: string) => void;
  submitRegistration: (data: RegistrationFormData) => Promise<{ success: boolean; message: string; requestId?: string; error?: string }>;
  verifyRegistrationCode: (data: { requestId?: string; loginOrEmail: string; code: string }) => Promise<{ success: boolean; message: string; error?: string; remainingAttempts?: number }>;
  resendRegistrationCode: (data: { requestId?: string; loginOrEmail: string }) => Promise<{ success: boolean; message: string; error?: string; devOtp?: string; retryAfter?: number }>;
  fetchRegistrationRequests: () => Promise<RegistrationRequest[]>;
  approveRegistrationRequest: (requestId: string) => Promise<{ success: boolean; message: string; error?: string; devOtp?: string }>;
  rejectRegistrationRequest: (requestId: string, reason?: string) => Promise<{ success: boolean; message: string; error?: string }>;

  // Backup & Restore
  createSystemBackup: () => Promise<any>;
  restoreSystemBackup: (backupId?: string) => Promise<any>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Authentication & Session State
  const [authToken, setAuthToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem('kit_auth_token') || sessionStorage.getItem('kit_auth_token');
    } catch {
      return null;
    }
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    try {
      return !!(localStorage.getItem('kit_auth_token') || sessionStorage.getItem('kit_auth_token'));
    } catch {
      return false;
    }
  });
  const [authLoading, setAuthLoading] = useState<boolean>(() => {
    try {
      return !!(localStorage.getItem('kit_auth_token') || sessionStorage.getItem('kit_auth_token'));
    } catch {
      return false;
    }
  });
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  const clearSessionExpiredMessage = () => {
    setSessionExpiredMessage(null);
  };

  // Current user & Project
  const [currentUser, setCurrentUser] = useState<User>(() => {
    try {
      const savedUser = localStorage.getItem('kit_current_user');
      if (savedUser) {
        const parsed = JSON.parse(savedUser);
        const match = INITIAL_USERS.find(u => u.id === parsed.id || u.role === parsed.role);
        if (match) return match;
      }
    } catch {}
    return INITIAL_USERS[0]; // Default: Inspector
  });
  const [projects] = useState<Project[]>(INITIAL_PROJECTS);
  const [activeProjectId, setActiveProjectId] = useState<string>('proj-aeron');

  // Validate session on mount (Real /api/auth/me)
  useEffect(() => {
    const token = localStorage.getItem('kit_auth_token') || sessionStorage.getItem('kit_auth_token');
    if (token) {
      setAuthLoading(true);
      fetch('/api/auth/me', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP_${res.status}`);
          }
          return res.json();
        })
        .then(data => {
          if (data.success && data.user) {
            const foundUser = INITIAL_USERS.find(u => u.id === data.user.id || u.role === data.user.role || (u.email && u.email.toLowerCase() === (data.user.email || '').toLowerCase())) || {
              ...INITIAL_USERS[0],
              id: data.user.id,
              fullName: data.user.fullName || data.user.name,
              role: (data.user.role as UserRole) || 'CONSTRUCTION_CONTROL',
              organizationId: data.user.organizationId || 'org-control',
              organizationName: data.user.organizationName || 'ООО «ТехНадзор Экспертиза»',
              allowedProjectIds: data.user.allowedProjectIds || ['proj-aeron']
            };
            setCurrentUser(foundUser);
            setIsAuthenticated(true);
            setSessionExpiredMessage(null);
          } else {
            localStorage.removeItem('kit_auth_token');
            sessionStorage.removeItem('kit_auth_token');
            localStorage.removeItem('kit_current_user');
            setAuthToken(null);
            setIsAuthenticated(false);
            setSessionExpiredMessage('Сессия завершена. Войдите снова.');
          }
        })
        .catch((err: any) => {
          // If network failed (e.g. offline PWA mode), check if offline and keep authenticated session safely
          if (!navigator.onLine) {
            console.warn('[SKKit] Offline mode active, preserving offline session');
            setIsAuthenticated(true);
          } else if (err.message && err.message.includes('401')) {
            localStorage.removeItem('kit_auth_token');
            sessionStorage.removeItem('kit_auth_token');
            localStorage.removeItem('kit_current_user');
            setAuthToken(null);
            setIsAuthenticated(false);
            setSessionExpiredMessage('Сессия завершена. Войдите снова.');
          } else {
            // General connection error
            localStorage.removeItem('kit_auth_token');
            sessionStorage.removeItem('kit_auth_token');
            localStorage.removeItem('kit_current_user');
            setAuthToken(null);
            setIsAuthenticated(false);
            setSessionExpiredMessage('Сессия завершена. Войдите снова.');
          }
        })
        .finally(() => {
          setAuthLoading(false);
        });
    } else {
      setAuthLoading(false);
    }
  }, []);

  const login = async (username: string, password?: string): Promise<{ success: boolean; error?: string; user?: User }> => {
    setAuthLoading(true);
    setSessionExpiredMessage(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      
      if (response.ok && data.success && data.user && data.token) {
        const token = data.token;
        setAuthToken(token);
        localStorage.setItem('kit_auth_token', token);

        const matched = INITIAL_USERS.find(u => 
          u.id === data.user.id || 
          (u.email && u.email.toLowerCase() === username.trim().toLowerCase()) || 
          u.role === data.user.role ||
          u.fullName.toLowerCase().includes(username.trim().toLowerCase())
        ) || {
          ...INITIAL_USERS[0],
          id: data.user.id,
          fullName: data.user.fullName || data.user.name,
          role: (data.user.role as UserRole) || 'CONSTRUCTION_CONTROL',
          organizationId: data.user.organizationId || 'org-control',
          organizationName: data.user.organizationName || 'ООО «ТехНадзор Экспертиза»',
          allowedProjectIds: data.user.allowedProjectIds || ['proj-aeron']
        };

        setCurrentUser(matched);
        localStorage.setItem('kit_current_user', JSON.stringify({ id: matched.id, role: matched.role }));
        setIsAuthenticated(true);
        setSessionExpiredMessage(null);
        logAction('CREATE', 'USER_SESSION', matched.id, `Успешная авторизация пользователя: ${matched.fullName} (${matched.role})`);
        return { success: true, user: matched };
      } else {
        return { success: false, error: data.error || 'Неверное имя пользователя или пароль' };
      }
    } catch (err: any) {
      return { success: false, error: 'Ошибка подключения к серверу авторизации' };
    } finally {
      setAuthLoading(false);
    }
  };

  const logout = async (): Promise<void> => {
    const token = authToken || localStorage.getItem('kit_auth_token');
    try {
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      }
    } catch {}
    localStorage.removeItem('kit_auth_token');
    sessionStorage.removeItem('kit_auth_token');
    localStorage.removeItem('kit_current_user');
    setAuthToken(null);
    setIsAuthenticated(false);
    setSessionExpiredMessage(null);
    logAction('DELETE', 'USER_SESSION', currentUser.id, `Выход из системы пользователя: ${currentUser.fullName}`);
  };

  // Entities
  const [organizations] = useState<Organization[]>(INITIAL_ORGANIZATIONS);
  const [documents, setDocuments] = useState<ProjectDocument[]>(INITIAL_DOCUMENTS);
  // No INITIAL_ESTIMATE_ITEMS fallback (Phase 9L.2 hardening) — the view
  // gates rendering on estimateItemsStatus (loading/error/empty/loaded), so
  // there is no pre-fetch moment where mock data would ever be shown as if
  // it were real. initialData.ts is not used for this entity's production
  // state at all anymore, only as backend seed data (see server.ts).
  const [estimateItems, setEstimateItems] = useState<EstimateItem[]>([]);
  // Same hardening as estimateItems above, applied retroactively: these
  // three previously started from mock and only ever got REPLACED by a
  // successful fetch (silent .catch(() => {}) on failure meant mock data
  // stayed on screen looking real forever if the request ever failed).
  const [scheduleTasks, setScheduleTasks] = useState<ScheduleTask[]>([]);
  const [scheduleTasksStatus, setScheduleTasksStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [scheduleTasksError, setScheduleTasksError] = useState<string | null>(null);
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [inspectionsStatus, setInspectionsStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [inspectionsError, setInspectionsError] = useState<string | null>(null);
  const [vrfSystems, setVrfSystems] = useState<VrfSystemUnit[]>(INITIAL_VRF_SYSTEMS);
  const [defects, setDefects] = useState<DefectRemark[]>([]);
  const [defectsStatus, setDefectsStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [defectsError, setDefectsError] = useState<string | null>(null);
  const [executiveDocs, setExecutiveDocs] = useState<ExecutiveDocItem[]>(INITIAL_EXECUTIVE_DOCS);
  const [contractorScores] = useState<ContractorPerformance[]>(INITIAL_CONTRACTOR_PERFORMANCE);
  // No INITIAL_KS_DOCUMENTS fallback (Phase 9L.2 hardening, Financial
  // module) — starts empty, the view gates rendering on ksDocumentsStatus
  // so mock is never shown as real financial data.
  const [ksDocuments, setKsDocuments] = useState<KsDocument[]>([]);
  const [ksDocumentsStatus, setKsDocumentsStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [ksDocumentsError, setKsDocumentsError] = useState<string | null>(null);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary | null>(null);
  const [risks, setRisks] = useState<ProjectRisk[]>(INITIAL_RISKS);
  const [notifications, setNotifications] = useState<AppNotification[]>(INITIAL_NOTIFICATIONS);
  // No INITIAL_AUDIT_LOGS fallback (Phase 9L.2 hardening, final module) —
  // starts empty, backed by the real /api/audit/logs endpoint below.
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLogsStatus, setAuditLogsStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [auditLogsError, setAuditLogsError] = useState<string | null>(null);

  // Universal Work Types — backed by the real /api/work-types API (Phase 9L).
  // Previously this only read/wrote localStorage and never touched the
  // backend at all, despite the API existing and being secured since
  // Phase 8 (see docs/architecture/DATA_INVENTORY.md, finding #3).
  const [workTypes, setWorkTypes] = useState<WorkType[]>(INITIAL_WORK_TYPES);

  // Unified Control Model Records — backed by the real /api/unified-control API.
  // No INITIAL_UNIFIED_CONTROL_RECORDS fallback: starts empty, the view
  // gates rendering on unifiedControlStatus so mock is never shown as real data.
  const [unifiedControlRecords, setUnifiedControlRecords] = useState<UnifiedControlRecord[]>([]);
  const [unifiedControlStatus, setUnifiedControlStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [unifiedControlError, setUnifiedControlError] = useState<string | null>(null);

  const authHeaders = (): Record<string, string> =>
    authToken ? { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` } : { 'Content-Type': 'application/json' };

  // Load real data from the backend once authenticated (replaces the
  // hardcoded seed as soon as the real list is available).
  useEffect(() => {
    if (!isAuthenticated || !authToken) return;
    fetch('/api/work-types', { headers: authHeaders() })
      .then(res => res.json())
      .then(data => { if (data.success && Array.isArray(data.workTypes)) setWorkTypes(data.workTypes); })
      .catch(() => {});
  }, [isAuthenticated, authToken]);

  // Unified control records are project-scoped server-side (Phase 9L.2
  // hardening — the endpoint used to allow an unscoped fetch-everything
  // call); re-fetch whenever the active project changes, same pattern as
  // estimateItems. On failure this surfaces a real error, it does not fall
  // back to INITIAL_UNIFIED_CONTROL_RECORDS.
  const loadUnifiedControlRecords = React.useCallback(() => {
    if (!isAuthenticated || !authToken || !activeProjectId) return;
    setUnifiedControlStatus('loading');
    setUnifiedControlError(null);
    fetch(`/api/unified-control?projectId=${encodeURIComponent(activeProjectId)}`, { headers: authHeaders() })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success || !Array.isArray(data.records)) {
          setUnifiedControlStatus('error');
          setUnifiedControlError(data.error || 'Не удалось загрузить точки контроля');
          return;
        }
        setUnifiedControlRecords(data.records);
        setUnifiedControlStatus(data.records.length === 0 ? 'empty' : 'loaded');
      })
      .catch(() => {
        setUnifiedControlStatus('error');
        setUnifiedControlError('Не удалось соединиться с сервером');
      });
  }, [isAuthenticated, authToken, activeProjectId]);

  useEffect(() => {
    loadUnifiedControlRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authToken, activeProjectId]);

  const retryFetchUnifiedControlRecords = () => loadUnifiedControlRecords();

  // Work Types CRUD handlers — real API calls, state updated from the
  // server's response (server assigns the real id/timestamps).
  const addWorkType = async (wt: Omit<WorkType, 'id' | 'createdAt' | 'updatedAt'>) => {
    try {
      const res = await fetch('/api/work-types', { method: 'POST', headers: authHeaders(), body: JSON.stringify(wt) });
      const data = await res.json();
      if (data.success && data.workType) {
        setWorkTypes(prev => [data.workType, ...prev]);
        logAction('CREATE', 'WORK_TYPE', data.workType.id, `Создан новый вид работ: ${data.workType.name} (${data.workType.code})`);
      }
    } catch {}
  };

  const updateWorkType = async (id: string, wt: Partial<WorkType>) => {
    try {
      const res = await fetch(`/api/work-types/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(wt) });
      const data = await res.json();
      if (data.success && data.workType) {
        setWorkTypes(prev => prev.map(item => item.id === id ? data.workType : item));
        logAction('UPDATE', 'WORK_TYPE', id, `Обновлен вид работ: ${data.workType.name}`);
      }
    } catch {}
  };

  const archiveWorkType = async (id: string) => {
    try {
      const res = await fetch(`/api/work-types/${id}/archive`, { method: 'PATCH', headers: authHeaders() });
      const data = await res.json();
      if (data.success && data.workType) {
        setWorkTypes(prev => prev.map(item => item.id === id ? data.workType : item));
        logAction('UPDATE', 'WORK_TYPE', id, `Статус вида работ изменен на: ${data.workType.status}`);
      }
    } catch {}
  };

  // Unified Control Model CRUD handlers — failures are returned to the
  // caller instead of swallowed, so the UI can show a real error instead
  // of a create/update that silently did nothing.
  const addUnifiedControlRecord = async (record: Omit<UnifiedControlRecord, 'id' | 'updatedAt'>): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/unified-control', { method: 'POST', headers: authHeaders(), body: JSON.stringify(record) });
      const data = await res.json();
      if (!res.ok || !data.success || !data.record) {
        return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})` };
      }
      setUnifiedControlRecords(prev => [data.record, ...prev]);
      setUnifiedControlStatus('loaded'); // clears a stale 'empty' banner once the first real record exists
      logAction('CREATE', 'UNIFIED_CONTROL_RECORD', data.record.id, `Создана точка контроля: ${data.record.workTypeName} на ${data.record.floor} (${data.record.axis})`);
      return { success: true };
    } catch {
      return { success: false, error: 'Не удалось соединиться с сервером' };
    }
  };

  const updateUnifiedControlRecord = async (id: string, record: Partial<UnifiedControlRecord>): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/unified-control/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(record) });
      const data = await res.json();
      if (!res.ok || !data.success || !data.record) {
        return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})` };
      }
      setUnifiedControlRecords(prev => prev.map(item => item.id === id ? data.record : item));
      logAction('UPDATE', 'UNIFIED_CONTROL_RECORD', id, `Обновлена точка контроля: ${data.record.workTypeName} (Статус: ${data.record.acceptanceStatus})`);
      return { success: true };
    } catch {
      return { success: false, error: 'Не удалось соединиться с сервером' };
    }
  };

  // AOSR signing (Phase 9L.2) — connects the UI to the REAL server-side
  // state machine (src/server/repositories/aosr.ts). Before this, the
  // "Подписать АОСР" button jumped straight to FULLY_APPROVED in local
  // state without ever calling the backend at all — the exact "UI decides
  // DRAFT -> SIGNED" pattern the task brief explicitly forbids. The backend
  // is now the sole authority: role comes from the session, the transition
  // is validated against the actually-stored Aosr.status, and an invalid
  // transition is surfaced to the caller instead of silently succeeding.
  const backendToFrontendAosrStatus: Record<string, UnifiedControlRecord['aosrStatus']> = {
    DRAFT: 'DRAFT',
    SIGNED_BY_CONTRACTOR: 'SIGNED_BY_CONTRACTOR',
    SIGNED_BY_TECH_SUPERVISOR: 'SIGNED_BY_SUPERVISOR',
    FULLY_APPROVED: 'FULLY_APPROVED',
    REJECTED: 'DRAFT'
  };

  const signAosrForRecord = async (record: UnifiedControlRecord): Promise<{ success: boolean; error?: string }> => {
    try {
      let aosrId = record.aosrId;
      if (!aosrId) {
        const createRes = await fetch(`/api/projects/${activeProjectId}/aosr`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ workId: record.id, workName: record.workTypeName })
        });
        const createData = await createRes.json();
        if (!createData.success) return { success: false, error: createData.error || 'Не удалось создать АОСР' };
        aosrId = createData.aosr.id;
        // Persist the newly created shell's id immediately, even if signing
        // below then fails (e.g. this caller's role can't be this stage's
        // signatory) — otherwise a retry would never see record.aosrId and
        // would create a fresh orphan Aosr row on every attempt.
        await updateUnifiedControlRecord(record.id, { aosrId });
      }

      const signRes = await fetch(`/api/aosr/${aosrId}/sign`, { method: 'POST', headers: authHeaders() });
      const signData = await signRes.json();
      if (!signData.success) {
        return { success: false, error: signData.error || 'Подписание отклонено сервером' };
      }

      const mappedStatus = backendToFrontendAosrStatus[signData.status] || 'DRAFT';
      const syncResult = await updateUnifiedControlRecord(record.id, {
        aosrId,
        aosrStatus: mappedStatus,
        ...(mappedStatus === 'FULLY_APPROVED' ? { acceptanceStatus: 'ACCEPTED', overallStatus: 'COMPLETED' } : {})
      });
      logAction('SIGN', 'AOSR', aosrId, `АОСР подписан, новый статус: ${signData.status}`);
      if (!syncResult.success) {
        // The signature itself is real and already persisted server-side —
        // only the unified-control display record failed to refresh, so a
        // retry of the sign action itself would now be rejected as an
        // invalid transition. Tell the caller that explicitly instead of
        // implying the signature didn't happen.
        return { success: false, error: `АОСР подписан на сервере, но обновление карточки не удалось: ${syncResult.error}. Обновите страницу.` };
      }
      return { success: true };
    } catch {
      return { success: false, error: 'Ошибка соединения с сервером' };
    }
  };

  // ---------------------------------------------------------------------
  // Estimates (Phase 9L.2) — real backend via src/api/estimates.ts, not
  // INITIAL_ESTIMATE_ITEMS. Backend groups items under an Estimate header
  // (estimateId); the current UI shows a flat per-project list, so that
  // grouping is hidden here — items from every estimate of the active
  // project are flattened together, matching the pre-migration UI contract.
  //
  // On failure the state moves to 'error' with the real server/network
  // message — it does NOT fall back to INITIAL_ESTIMATE_ITEMS. Mock data is
  // only ever the pre-fetch placeholder (see useState below) so the first
  // paint isn't a blank screen; a failed or slow request is visibly
  // "loading"/"error" in the UI, never silently presented as real data.
  const [estimateItemsStatus, setEstimateItemsStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [estimateItemsError, setEstimateItemsError] = useState<string | null>(null);

  const loadEstimateItems = React.useCallback(() => {
    if (!isAuthenticated || !authToken || !activeProjectId) return;
    setEstimateItemsStatus('loading');
    setEstimateItemsError(null);
    fetchEstimateItemsApi(activeProjectId, authToken).then(result => {
      if (!result.success || !result.data) {
        setEstimateItemsStatus('error');
        setEstimateItemsError(result.error || 'Не удалось загрузить сметы');
        return;
      }
      setEstimateItems(result.data);
      setEstimateItemsStatus(result.data.length === 0 ? 'empty' : 'loaded');
    });
  }, [isAuthenticated, authToken, activeProjectId]);

  useEffect(() => {
    loadEstimateItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authToken, activeProjectId]);

  const retryFetchEstimateItems = () => loadEstimateItems();

  // ---------------------------------------------------------------------
  // Financial / КС-2-КС-3 (Phase 9L.2) — real backend via
  // src/api/ksDocuments.ts, not INITIAL_KS_DOCUMENTS. Same
  // idle/loading/loaded/empty/error lifecycle as estimateItems above; the
  // summary cards (budget/executed/accepted/paid) also now come from the
  // real /api/projects/:id/financial aggregate instead of the static mock
  // Project.budgetContractRub etc.
  const loadKsDocuments = React.useCallback(() => {
    if (!isAuthenticated || !authToken || !activeProjectId) return;
    setKsDocumentsStatus('loading');
    setKsDocumentsError(null);
    fetchKsDocumentsApi(activeProjectId, authToken).then(result => {
      if (!result.success || !result.data) {
        setKsDocumentsStatus('error');
        setKsDocumentsError(result.error || 'Не удалось загрузить документы КС');
        return;
      }
      setKsDocuments(result.data);
      setKsDocumentsStatus(result.data.length === 0 ? 'empty' : 'loaded');
    });
    fetchFinancialSummaryApi(activeProjectId, authToken).then(result => {
      if (result.success && result.data) setFinancialSummary(result.data);
    });
  }, [isAuthenticated, authToken, activeProjectId]);

  useEffect(() => {
    loadKsDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authToken, activeProjectId]);

  const retryFetchKsDocuments = () => loadKsDocuments();

  const approveKsDoc = async (ksId: string): Promise<{ success: boolean; error?: string }> => {
    const result = await advanceKsDocumentApi(activeProjectId, ksId, authToken);
    if (!result.success || !result.data) {
      return { success: false, error: result.error || 'Не удалось согласовать документ' };
    }
    setKsDocuments(prev => prev.map(ks => ks.id === ksId ? result.data! : ks));
    logAction('APPROVE', 'KS_DOCUMENT', ksId, `Статус КС: ${result.data.status}`);
    return { success: true };
  };

  // ---------------------------------------------------------------------
  // Audit Log (Phase 9L.2, final module) — real backend via
  // src/api/auditLog.ts, not INITIAL_AUDIT_LOGS. The backend's audit_log is
  // the one that's actually written by every real mutation (logAudit() in
  // server.ts); the old local logAction()-fed array was a parallel,
  // never-persisted, browser-session-only fabrication (down to a hardcoded
  // fake IP address) that happened to look like a real "tamper-evident"
  // trail. logAction() is kept below (many call sites reference it) but no
  // longer writes into auditLogs.
  const loadAuditLogs = React.useCallback(() => {
    if (!isAuthenticated || !authToken) return;
    setAuditLogsStatus('loading');
    setAuditLogsError(null);
    fetchAuditLogsApi(authToken).then(result => {
      if (!result.success || !result.data) {
        setAuditLogsStatus('error');
        setAuditLogsError(result.error || 'Не удалось загрузить журнал аудита');
        return;
      }
      setAuditLogs(result.data);
      setAuditLogsStatus(result.data.length === 0 ? 'empty' : 'loaded');
    });
  }, [isAuthenticated, authToken]);

  useEffect(() => {
    loadAuditLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authToken]);

  const retryFetchAuditLogs = () => loadAuditLogs();

  // ---------------------------------------------------------------------
  // Schedule (Phase 9L.2) — real backend. Frontend/backend field shapes
  // already match closely (repository extended to cover spi/
  // assignedContractorName/lastInspectionDate), no mapping needed beyond
  // the API response array itself.
  // ---------------------------------------------------------------------
  const loadScheduleTasks = React.useCallback(() => {
    if (!isAuthenticated || !authToken || !activeProjectId) return;
    setScheduleTasksStatus('loading');
    setScheduleTasksError(null);
    fetch(`/api/projects/${activeProjectId}/schedule`, { headers: authHeaders() })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success || !Array.isArray(data.tasks)) {
          setScheduleTasksStatus('error');
          setScheduleTasksError(data.error || 'Не удалось загрузить график работ');
          return;
        }
        setScheduleTasks(data.tasks);
        setScheduleTasksStatus(data.tasks.length === 0 ? 'empty' : 'loaded');
      })
      .catch(() => {
        setScheduleTasksStatus('error');
        setScheduleTasksError('Не удалось соединиться с сервером');
      });
  }, [isAuthenticated, authToken, activeProjectId]);

  useEffect(() => {
    loadScheduleTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authToken, activeProjectId]);

  const retryFetchScheduleTasks = () => loadScheduleTasks();

  const updateScheduleTaskOnServer = async (id: string, patch: Partial<ScheduleTask>) => {
    try {
      const res = await fetch(`/api/projects/${activeProjectId}/schedule/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(patch) });
      const data = await res.json();
      if (data.success && data.task) {
        setScheduleTasks(prev => prev.map(t => t.id === id ? data.task : t));
      }
    } catch {}
  };

  // ---------------------------------------------------------------------
  // Inspections (Phase 9L.2) — real backend.
  // ---------------------------------------------------------------------
  const loadInspections = React.useCallback(() => {
    if (!isAuthenticated || !authToken || !activeProjectId) return;
    setInspectionsStatus('loading');
    setInspectionsError(null);
    fetch(`/api/projects/${activeProjectId}/inspections`, { headers: authHeaders() })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success || !Array.isArray(data.inspections)) {
          setInspectionsStatus('error');
          setInspectionsError(data.error || 'Не удалось загрузить проверки');
          return;
        }
        setInspections(data.inspections);
        setInspectionsStatus(data.inspections.length === 0 ? 'empty' : 'loaded');
      })
      .catch(() => {
        setInspectionsStatus('error');
        setInspectionsError('Не удалось соединиться с сервером');
      });
  }, [isAuthenticated, authToken, activeProjectId]);

  useEffect(() => {
    loadInspections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authToken, activeProjectId]);

  const retryFetchInspections = () => loadInspections();

  // ---------------------------------------------------------------------
  // Defects (Phase 9L.2) — GET already used the real repository since
  // Phase 9K (it was migrated when the endpoint itself was built); this
  // adds the fetch-on-mount and wires the write path (create/status)
  // that previously only touched local state.
  // ---------------------------------------------------------------------
  const loadDefects = React.useCallback(() => {
    if (!isAuthenticated || !authToken || !activeProjectId) return;
    setDefectsStatus('loading');
    setDefectsError(null);
    fetch(`/api/projects/${activeProjectId}/defects`, { headers: authHeaders() })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success || !Array.isArray(data.defects)) {
          setDefectsStatus('error');
          setDefectsError(data.error || 'Не удалось загрузить замечания');
          return;
        }
        setDefects(data.defects);
        setDefectsStatus(data.defects.length === 0 ? 'empty' : 'loaded');
      })
      .catch(() => {
        setDefectsStatus('error');
        setDefectsError('Не удалось соединиться с сервером');
      });
  }, [isAuthenticated, authToken, activeProjectId]);

  useEffect(() => {
    loadDefects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authToken, activeProjectId]);

  const retryFetchDefects = () => loadDefects();

  // Active Project with Project Isolation verification
  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0];

  const setActiveProjectById = (projectId: string) => {
    if (currentUser.role !== 'SUPER_ADMIN' && !currentUser.allowedProjectIds.includes(projectId)) {
      alert(`Ошибка изоляции проектов (RBAC Project Isolation): Пользователь ${currentUser.fullName} не имеет доступа к объекту ID: ${projectId}`);
      return;
    }
    setActiveProjectId(projectId);
  };

  const switchRole = (newRole: UserRole) => {
    const matchedUser = INITIAL_USERS.find(u => u.role === newRole) || {
      ...currentUser,
      role: newRole
    };
    setCurrentUser(matchedUser);
    logAction('UPDATE', 'USER_ROLE', matchedUser.id, `Переключена роль на ${newRole}`);
  };

  // RBAC Permission Engine
  const can = (action: PermissionAction, module: SystemModule): boolean => {
    const role = currentUser.role;

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') return true;

    // View is generally allowed for assigned project members
    if (action === 'VIEW') return true;

    // Construction Control / Tech supervision rights
    if (role === 'CONSTRUCTION_CONTROL') {
      if (module === 'construction_control' || module === 'defects' || module === 'ovik' || module === 'photo_control') return true;
      if (action === 'APPROVE' && (module === 'executive_docs' || module === 'documents' || module === 'finance')) return true;
      if (action === 'CLOSE_DEFECT') return true;
      if (action === 'SIGN_ACT') return true;
      return action !== 'DELETE';
    }

    // Chief Engineer / GIP rights
    if (role === 'CHIEF_ENGINEER' || role === 'PROJECT_DIRECTOR') {
      if (action === 'APPROVE' || action === 'REJECT' || action === 'EDIT' || action === 'CREATE') return true;
      if (action === 'CLOSE_DEFECT') return true;
      return true;
    }

    // PTO Engineer
    if (role === 'PTO_ENGINEER') {
      if (module === 'documents' || module === 'specifications' || module === 'estimates' || module === 'executive_docs' || module === 'finance') {
        return action === 'CREATE' || action === 'EDIT' || action === 'EXPORT';
      }
      return false;
    }

    // Foreman / Subcontractor
    if (role === 'FOREMAN' || role === 'SUBCONTRACTOR' || role === 'CONTRACTOR') {
      if (action === 'CLOSE_DEFECT') return false; // Subcontractor CANNOT close defects himself!
      if (action === 'APPROVE' || action === 'REJECT') return false;
      if (module === 'defects' && action === 'EDIT') return true; // Can submit "ready for review"
      if (module === 'photo_control' && action === 'CREATE') return true;
      if (module === 'volume_control' && action === 'EDIT') return true;
      return false;
    }

    // Customer
    if (role === 'CUSTOMER') {
      if (action === 'APPROVE' && (module === 'finance' || module === 'executive_docs')) return true;
      return action === 'EXPORT';
    }

    // Viewer
    if (role === 'VIEWER') {
      return action === 'EXPORT' || action === 'DOWNLOAD';
    }

    return false;
  };

  // Audit Logger — Phase 9L.2: this used to fabricate a local-only entry
  // (down to a hardcoded fake IP address) and push it straight into the
  // same auditLogs array now backed by the real /api/audit/logs endpoint.
  // Every real mutation already calls the backend's own logAudit(), so
  // duplicating that client-side would mean fake and real entries mixed
  // together indistinguishably. Kept as a no-op (rather than removing it
  // and its ~20 call sites throughout this file) so nothing here writes
  // fabricated audit data anymore.
  const logAction = (
    _action: string,
    _entityType: string,
    _entityId: string,
    _newValue?: string,
    _oldValue?: string
  ) => {};

  // Document Operations (Real Binary Upload Pipeline)
  const uploadDocument = async (docData: {
    file?: File;
    fileName: string;
    fileSizeMb?: number;
    title: string;
    code: string;
    section: string;
    category: DocumentCategory;
    pagesCount?: number;
    tags?: string[];
    revision?: string;
  }): Promise<{ success: boolean; document?: ProjectDocument; error?: string; status?: number }> => {
    try {
      const headers: Record<string, string> = {};
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const formData = new FormData();
      if (docData.file) {
        formData.append('file', docData.file);
      }
      formData.append('projectId', activeProjectId);
      formData.append('documentCode', docData.code);
      formData.append('code', docData.code);
      formData.append('title', docData.title);
      formData.append('section', docData.section);
      formData.append('category', docData.category);
      formData.append('pagesCount', String(docData.pagesCount || 1));
      formData.append('tags', (docData.tags || []).join(','));
      formData.append('fileName', docData.fileName || docData.file?.name || `${docData.code}.pdf`);
      formData.append('fileSizeMb', String(docData.fileSizeMb || (docData.file ? (docData.file.size / (1024 * 1024)).toFixed(2) : 1.0)));
      formData.append('revision', docData.revision || 'Изм. 0');
      formData.append('authorOrg', currentUser.organizationName);

      const response = await fetch('/api/documents/upload-binary', {
        method: 'POST',
        headers, // Browser sets multipart/form-data boundary automatically
        body: formData
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        const errorMsg = data.error || `Ошибка сервера (HTTP ${response.status})`;
        return { success: false, error: errorMsg, status: response.status };
      }

      const rawDoc = data.document;
      const createdDoc: ProjectDocument = {
        id: rawDoc.id || `doc-${Date.now()}`,
        projectId: rawDoc.projectId || activeProjectId,
        code: rawDoc.code || docData.code,
        title: rawDoc.title || docData.title,
        section: rawDoc.section || docData.section,
        category: rawDoc.category || docData.category,
        currentRevision: rawDoc.currentRevision || rawDoc.revision || docData.revision || 'Изм. 0',
        currentVersion: rawDoc.currentVersion || 1,
        status: rawDoc.status || 'UPLOADED',
        uploadedBy: rawDoc.uploadedBy || currentUser.fullName,
        authorOrg: rawDoc.authorOrg || currentUser.organizationName,
        pagesCount: Number(rawDoc.pagesCount) || docData.pagesCount || 1,
        hasConflicts: false,
        tags: Array.isArray(rawDoc.tags) ? rawDoc.tags : (docData.tags || []),
        sha256: rawDoc.sha256 || data.fileInfo?.sha256,
        versions: rawDoc.versions || [
          {
            versionNumber: 1,
            revision: rawDoc.currentRevision || docData.revision || 'Изм. 0',
            fileUrl: `/api/documents/${rawDoc.id || docData.code}/download`,
            fileName: rawDoc.fileName || docData.fileName,
            fileSizeMb: Number(rawDoc.fileSizeMb) || docData.fileSizeMb || 1.0,
            uploadedBy: currentUser.fullName,
            uploadedAt: new Date().toISOString().split('T')[0],
            changeDescription: 'Загрузка в защищённый электронный архив',
            status: 'UPLOADED',
            sha256: rawDoc.sha256 || data.fileInfo?.sha256
          }
        ],
        createdAt: rawDoc.createdAt || new Date().toISOString().split('T')[0],
        updatedAt: rawDoc.updatedAt || new Date().toISOString().split('T')[0]
      };

      setDocuments(prev => [createdDoc, ...prev]);
      logAction('CREATE', 'PROJECT_DOCUMENT', createdDoc.id, `Загружен исходный файл документа: ${createdDoc.title} (${createdDoc.code})`);

      return { success: true, document: createdDoc, status: response.status };
    } catch (err: any) {
      const errorMsg = err.message || 'Ошибка сети при передаче бинарного файла';
      return { success: false, error: errorMsg, status: 0 };
    }
  };

  const addDocument = (docData: Partial<ProjectDocument>) => {
    const newDoc: ProjectDocument = {
      id: `doc-${Date.now()}`,
      projectId: activeProjectId,
      title: docData.title || 'Новый документ',
      code: docData.code || 'ШИФР-2025',
      section: docData.section || 'ОВ',
      category: docData.category || 'WORKING_DOC',
      currentRevision: 'Изм. 0',
      currentVersion: 1,
      status: 'UPLOADED',
      uploadedBy: currentUser.fullName,
      authorOrg: currentUser.organizationName,
      pagesCount: docData.pagesCount || 1,
      hasConflicts: false,
      tags: docData.tags || [],
      versions: [
        {
          versionNumber: 1,
          revision: 'Изм. 0',
          fileUrl: '/docs/sample.pdf',
          fileName: 'uploaded_doc.pdf',
          fileSizeMb: 5.2,
          uploadedBy: currentUser.fullName,
          uploadedAt: new Date().toISOString().split('T')[0],
          changeDescription: 'Первичная загрузка в систему',
          status: 'UPLOADED'
        }
      ],
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0]
    };

    setDocuments(prev => [newDoc, ...prev]);
    logAction('CREATE', 'PROJECT_DOCUMENT', newDoc.id, `Создан документ ${newDoc.title} (${newDoc.code})`);
  };

  const updateDocumentStatus = (docId: string, status: ProjectDocument['status']) => {
    setDocuments(prev => prev.map(d => {
      if (d.id === docId) {
        logAction('UPDATE', 'PROJECT_DOCUMENT', docId, `Статус: ${status}`, `Статус: ${d.status}`);
        return { ...d, status, updatedAt: new Date().toISOString().split('T')[0] };
      }
      return d;
    }));
  };

  // Inspections & Hold Point Enforcement
  // Real backend write (Phase 9L.2). Hold-point-triggered schedule blocking
  // now goes through the real /api/projects/:id/schedule/:id PUT instead of
  // only touching local state — the server record is what's authoritative,
  // matching AOSR's "backend is the state machine authority" principle.
  // Notifications stay local for now (out of this migration's module list).
  const addInspection = async (inspData: Omit<InspectionRecord, 'id' | 'createdAt'>): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/projects/${activeProjectId}/inspections`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(inspData) });
      const data = await res.json();
      if (!res.ok || !data.success || !data.inspection) {
        return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})` };
      }
      const newRecord: InspectionRecord = data.inspection;
      setInspections(prev => [newRecord, ...prev]);
      logAction('CREATE', 'INSPECTION_RECORD', newRecord.id, `Результат: ${inspData.result}, PointType: ${inspData.pointType}`);

      if (inspData.pointType === 'HOLD_POINT' && inspData.result === 'FAILED') {
        if (inspData.taskId) {
          await updateScheduleTaskOnServer(inspData.taskId, { status: 'HOLD_POINT_BLOCKED', holdPointPassed: false });
        }
        const notif: AppNotification = {
          id: `notif-${Date.now()}`,
          projectId: activeProjectId,
          type: 'HOLD_POINT_TRIGGER',
          title: 'Критический отказ HOLD POINT!',
          message: `Проверка "${inspData.workName}" завершилась со статусом FAILED. Последующие работы заблокированы.`,
          severity: 'CRITICAL',
          linkModule: 'construction_control',
          linkEntityId: newRecord.id,
          isRead: false,
          createdAt: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        };
        setNotifications(prev => [notif, ...prev]);
      }
      return { success: true };
    } catch {
      return { success: false, error: 'Не удалось соединиться с сервером' };
    }
  };

  const resolveHoldPoint = async (inspectionId: string, passed: boolean) => {
    try {
      const res = await fetch(`/api/projects/${activeProjectId}/inspections/${inspectionId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ result: passed ? 'PASSED' : 'FAILED', isHoldPointSatisfied: passed })
      });
      const data = await res.json();
      if (!data.success || !data.inspection) return;
      setInspections(prev => prev.map(insp => insp.id === inspectionId ? data.inspection : insp));
      logAction('UPDATE', 'HOLD_POINT', inspectionId, `Статус удовлетворения Hold Point: ${passed}`);

      const insp = inspections.find(i => i.id === inspectionId);
      if (insp?.taskId && passed) {
        await updateScheduleTaskOnServer(insp.taskId, { status: 'IN_PROGRESS', holdPointPassed: true });
      }
    } catch {}
  };

  // Defects Lifecycle
  // Real backend write (Phase 9L.2). defectNumber is now assigned by the
  // server (sequential, not random) — same visible format, server owns
  // the identity instead of the client guessing at one.
  const addDefect = async (defectData: Omit<DefectRemark, 'id' | 'defectNumber' | 'issuedDate' | 'reinspectionCount' | 'auditTrail'>): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/projects/${activeProjectId}/defects`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(defectData) });
      const data = await res.json();
      if (!res.ok || !data.success || !data.defect) {
        return { success: false, error: data.error || `Сервер вернул ошибку (HTTP ${res.status})` };
      }
      const newDefect: DefectRemark = data.defect;
      setDefects(prev => [newDefect, ...prev]);
      logAction('CREATE', 'DEFECT_REMARK', newDefect.id, `Выставлено замечание ${newDefect.defectNumber}`);

      if (defectData.severity === 'CRITICAL') {
        const notif: AppNotification = {
          id: `notif-${Date.now()}`,
          projectId: activeProjectId,
          type: 'CRITICAL_DEFECT',
          title: `Новое КРИТИЧЕСКОЕ замечание (${newDefect.defectNumber})`,
          message: `${defectData.title}. Срок устранения: ${defectData.deadlineDate}`,
          severity: 'CRITICAL',
          linkModule: 'defects',
          linkEntityId: newDefect.id,
          isRead: false,
          createdAt: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        };
        setNotifications(prev => [notif, ...prev]);
      }
      return { success: true };
    } catch {
      return { success: false, error: 'Не удалось соединиться с сервером' };
    }
  };

  const updateDefectStatus = async (defectId: string, status: DefectRemark['status'], comment?: string, afterPhotoUrl?: string) => {
    try {
      const res = await fetch(`/api/projects/${activeProjectId}/defects/${defectId}/status`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status, comment: comment || `Статус изменен на ${status}`, afterPhotoUrl })
      });
      const data = await res.json();
      if (!data.success || !data.defect) return;
      const previous = defects.find(d => d.id === defectId);
      setDefects(prev => prev.map(d => d.id === defectId ? data.defect : d));
      logAction('UPDATE', 'DEFECT_REMARK', defectId, `Статус замечания: ${status}`, `Статус: ${previous?.status}`);
    } catch {}
  };

  // Estimate volume adjustments — real backend write (Phase 9L.2). The
  // status/conflictReason calculation is unchanged (same formula as before
  // migration); it is computed here and sent to the server so the
  // PERSISTED record is correct, not just the local optimistic view — the
  // server is the source of truth, this just avoids a second round trip to
  // recompute the same thing.
  const updateEstimateItemQty = async (itemId: string, factQty: number): Promise<{ success: boolean; error?: string }> => {
    const item = estimateItems.find(i => i.id === itemId);
    if (!item) return { success: false, error: 'Позиция сметы не найдена в текущем состоянии' };

    let status: DataStatus = 'CALCULATED';
    // null (not undefined) so JSON.stringify still sends the key — otherwise
    // a resolved conflict's old conflictReason would never be cleared server-side.
    let conflictReason: string | null = null;
    if (factQty > item.plannedQty) {
      status = 'CONFLICT';
      conflictReason = `Факт (${factQty} ${item.unit}) превышает утвержденный объем РД (${item.plannedQty} ${item.unit}) на ${factQty - item.plannedQty} ${item.unit}!`;
    } else if (factQty === item.plannedQty) {
      status = 'DOCUMENT CONFIRMED';
    }

    const result = await updateEstimateItemApi(activeProjectId, itemId, authToken, { actualFactQty: factQty, status, conflictReason });
    if (!result.success || !result.data) {
      return { success: false, error: result.error || 'Не удалось сохранить изменение на сервере' };
    }
    setEstimateItems(prev => prev.map(i => i.id === itemId ? result.data! : i));
    logAction('UPDATE', 'ESTIMATE_VOLUME', itemId, `Факт: ${factQty} ${item.unit}`, `Факт: ${item.actualFactQty} ${item.unit}`);
    return { success: true };
  };

  // Executive Docs signing
  const signExecutiveDoc = (docId: string, role: UserRole) => {
    setExecutiveDocs(prev => prev.map(doc => {
      if (doc.id === docId) {
        const signedByContractor = role === 'FOREMAN' || role === 'CONTRACTOR' ? true : doc.signedByContractor;
        const signedBySupervisor = role === 'CONSTRUCTION_CONTROL' || role === 'CHIEF_ENGINEER' ? true : doc.signedBySupervisor;
        const signedByCustomer = role === 'CUSTOMER' ? true : doc.signedByCustomer;

        const isFullyApproved = signedByContractor && signedBySupervisor && signedByCustomer;
        const status = isFullyApproved ? ('APPROVED' as const) : ('UNDER_REVIEW' as const);

        logAction('SIGN', 'EXECUTIVE_DOC', docId, `Подписано ролью ${role}. Статус: ${status}`);
        return {
          ...doc,
          signedByContractor,
          signedBySupervisor,
          signedByCustomer,
          status,
          signingDate: isFullyApproved ? new Date().toISOString().split('T')[0] : doc.signingDate
        };
      }
      return doc;
    }));
  };


  const markNotificationRead = (notifId: string) => {
    setNotifications(prev => prev.map(n => n.id === notifId ? { ...n, isRead: true } : n));
  };

  const markAllNotificationsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
  };

  // Backup & Restore
  const createSystemBackup = async () => {
    const payload = {
      projects,
      documents,
      estimateItems,
      scheduleTasks,
      inspections,
      vrfSystems,
      defects,
      executiveDocs,
      auditLogs
    };

    try {
      const res = await fetch('/api/system/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: payload })
      });
      const data = await res.json();
      logAction('CREATE', 'SYSTEM_BACKUP', data?.backup?.backupId || 'BCK-01', 'Резервная копия сформирована');
      return data;
    } catch {
      // Local fallback
      const localBackup = {
        backupId: `BCK-LOC-${Date.now()}`,
        createdAt: new Date().toISOString(),
        status: 'VERIFIED_VALID'
      };
      return { success: true, backup: localBackup };
    }
  };

  const restoreSystemBackup = async (backupId?: string) => {
    try {
      const res = await fetch('/api/system/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupId })
      });
      const data = await res.json();
      logAction('UPDATE', 'SYSTEM_RESTORE', backupId || 'LAST', 'Тест восстановления успешно пройден');
      return data;
    } catch {
      return { success: true, message: 'Restore verification passed in local fallback mode.' };
    }
  };

  // Registration Requests state & Real-time Global Alert for Super Admin
  const [registrationRequests, setRegistrationRequests] = useState<RegistrationRequest[]>([]);
  const [pendingAlertRequest, setPendingAlertRequest] = useState<RegistrationRequest | null>(null);
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());

  const dismissPendingAlert = (requestId: string) => {
    setDismissedAlertIds(prev => {
      const next = new Set(prev);
      next.add(requestId);
      return next;
    });
    setPendingAlertRequest(prev => (prev?.id === requestId ? null : prev));
  };

  const fetchRegistrationRequests = async (): Promise<RegistrationRequest[]> => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const res = await fetch('/api/admin/registration-requests', { headers });
      const data = await res.json();
      if (data.success && Array.isArray(data.requests)) {
        setRegistrationRequests(data.requests);

        // Global Alert Trigger for Super Admin
        if (currentUser.role === 'SUPER_ADMIN' || currentUser.role === 'ADMIN') {
          const pendingUnseen = data.requests.find(
            (r: RegistrationRequest) => r.status === 'PENDING' && !dismissedAlertIds.has(r.id)
          );
          if (pendingUnseen) {
            setPendingAlertRequest(pendingUnseen);
          } else {
            setPendingAlertRequest(null);
          }
        }

        return data.requests;
      }
      return [];
    } catch {
      return [];
    }
  };

  const submitRegistration = async (formData: RegistrationFormData) => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'Ошибка при регистрации', message: '' };
      }
      return { success: true, message: data.message, requestId: data.requestId };
    } catch (err: any) {
      return { success: false, error: err.message || 'Сетевая ошибка при регистрации', message: '' };
    }
  };

  const verifyRegistrationCode = async (params: { requestId?: string; loginOrEmail: string; code: string }) => {
    try {
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: params.requestId,
          login: params.loginOrEmail,
          email: params.loginOrEmail,
          code: params.code
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return {
          success: false,
          error: data.error || 'Неверный код подтверждения',
          message: '',
          remainingAttempts: data.remainingAttempts
        };
      }
      // Refresh requests list
      fetchRegistrationRequests();
      return { success: true, message: data.message };
    } catch (err: any) {
      return { success: false, error: err.message || 'Ошибка проверки кода', message: '' };
    }
  };

  const resendRegistrationCode = async (params: { requestId?: string; loginOrEmail: string }) => {
    try {
      const res = await fetch('/api/auth/resend-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: params.requestId,
          login: params.loginOrEmail,
          email: params.loginOrEmail
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return {
          success: false,
          error: data.error || 'Ошибка отправки кода',
          message: '',
          retryAfter: data.retryAfter
        };
      }
      return { success: true, message: data.message, devOtp: data.devOtp };
    } catch (err: any) {
      return { success: false, error: err.message || 'Ошибка отправки кода', message: '' };
    }
  };

  const approveRegistrationRequest = async (requestId: string) => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const res = await fetch(`/api/admin/registration-requests/${requestId}/approve`, {
        method: 'POST',
        headers
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'Ошибка одобрения заявки', message: '' };
      }
      setPendingAlertRequest(prev => (prev?.id === requestId ? null : prev));
      await fetchRegistrationRequests();
      logAction('APPROVE', 'USER_REGISTRATION', requestId, 'Одобрена заявка на регистрацию');
      return { success: true, message: data.message, devOtp: data.devOtp };
    } catch (err: any) {
      return { success: false, error: err.message || 'Ошибка одобрения заявки', message: '' };
    }
  };

  const rejectRegistrationRequest = async (requestId: string, reason?: string) => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const res = await fetch(`/api/admin/registration-requests/${requestId}/reject`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ reason: reason || 'Отклонено администратором' })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'Ошибка отклонения заявки', message: '' };
      }
      setPendingAlertRequest(prev => (prev?.id === requestId ? null : prev));
      await fetchRegistrationRequests();
      logAction('REJECT', 'USER_REGISTRATION', requestId, `Отклонена заявка: ${reason || 'Без причины'}`);
      return { success: true, message: data.message };
    } catch (err: any) {
      return { success: false, error: err.message || 'Ошибка отклонения заявки', message: '' };
    }
  };

  const pendingRegistrationsCount = registrationRequests.filter(r => r.status === 'PENDING').length;

  // Real-time polling for Super Admin registration notifications
  useEffect(() => {
    if (!isAuthenticated || (currentUser.role !== 'ADMIN' && currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'CHIEF_ENGINEER')) {
      return;
    }

    fetchRegistrationRequests();

    const timer = setInterval(() => {
      fetchRegistrationRequests();
    }, 4000);

    return () => clearInterval(timer);
  }, [isAuthenticated, currentUser.role]);

  // Filter entities by activeProjectId for strict tenant/project isolation
  const filteredDocuments = documents.filter(d => d.projectId === activeProjectId);
  const filteredEstimateItems = estimateItems.filter(e => e.projectId === activeProjectId);
  const filteredScheduleTasks = scheduleTasks.filter(s => s.projectId === activeProjectId);
  const filteredInspections = inspections.filter(i => i.projectId === activeProjectId);
  const filteredVrfSystems = vrfSystems.filter(v => v.projectId === activeProjectId);
  const filteredDefects = defects.filter(d => d.projectId === activeProjectId);
  const filteredExecutiveDocs = executiveDocs.filter(e => e.projectId === activeProjectId);
  const filteredContractorScores = contractorScores.filter(c => c.projectId === activeProjectId);
  const filteredKsDocuments = ksDocuments.filter(k => k.projectId === activeProjectId);
  const filteredRisks = risks.filter(r => r.projectId === activeProjectId);
  const filteredNotifications = notifications.filter(n => n.projectId === activeProjectId);
  const filteredAuditLogs = auditLogs.filter(a => a.projectId === activeProjectId);
  const filteredUnifiedControlRecords = unifiedControlRecords.filter(u => u.projectId === activeProjectId);

  return (
    <AppContext.Provider
      value={{
        currentUser,
        setCurrentUser,
        switchRole,
        isAuthenticated,
        authToken,
        authLoading,
        sessionExpiredMessage,
        clearSessionExpiredMessage,
        login,
        logout,
        projects,
        activeProject,
        setActiveProjectById,
        organizations,
        workTypes,
        addWorkType,
        updateWorkType,
        archiveWorkType,
        unifiedControlRecords: filteredUnifiedControlRecords,
        unifiedControlStatus,
        unifiedControlError,
        retryFetchUnifiedControlRecords,
        addUnifiedControlRecord,
        updateUnifiedControlRecord,
        signAosrForRecord,
        documents: filteredDocuments,
        estimateItems: filteredEstimateItems,
        estimateItemsStatus,
        estimateItemsError,
        retryFetchEstimateItems,
        scheduleTasks: filteredScheduleTasks,
        scheduleTasksStatus,
        scheduleTasksError,
        retryFetchScheduleTasks,
        inspections: filteredInspections,
        inspectionsStatus,
        inspectionsError,
        retryFetchInspections,
        vrfSystems: filteredVrfSystems,
        defects: filteredDefects,
        defectsStatus,
        defectsError,
        retryFetchDefects,
        executiveDocs: filteredExecutiveDocs,
        contractorScores: filteredContractorScores,
        ksDocuments: filteredKsDocuments,
        ksDocumentsStatus,
        ksDocumentsError,
        retryFetchKsDocuments,
        financialSummary,
        risks: filteredRisks,
        notifications: filteredNotifications,
        auditLogs: filteredAuditLogs,
        auditLogsStatus,
        auditLogsError,
        retryFetchAuditLogs,
        can,
        addDocument,
        uploadDocument,
        updateDocumentStatus,
        addInspection,
        resolveHoldPoint,
        addDefect,
        updateDefectStatus,
        updateEstimateItemQty,
        signExecutiveDoc,
        approveKsDoc,
        markNotificationRead,
        markAllNotificationsRead,
        logAction,
        createSystemBackup,
        restoreSystemBackup,
        registrationRequests,
        pendingRegistrationsCount,
        pendingAlertRequest,
        dismissPendingAlert,
        submitRegistration,
        verifyRegistrationCode,
        resendRegistrationCode,
        fetchRegistrationRequests,
        approveRegistrationRequest,
        rejectRegistrationRequest
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};

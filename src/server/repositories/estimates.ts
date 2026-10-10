import crypto from 'crypto';
import { dbUpsert, dbLoadByProject, dbDelete } from '../database';

export interface Estimate {
  id: string;
  projectId: string;
  documentId?: string;
  title: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export interface EstimateItem {
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

export function listEstimates(projectId: string): Estimate[] {
  return dbLoadByProject<Estimate>('estimates', projectId).map(r => r.data);
}

export function createEstimate(input: { projectId: string; title: string; documentId?: string }): Estimate {
  const now = new Date().toISOString();
  const estimate: Estimate = {
    id: `est-${crypto.randomBytes(6).toString('hex')}`,
    projectId: input.projectId,
    documentId: input.documentId,
    title: input.title,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now
  };
  dbUpsert('estimates', estimate.id, estimate);
  return estimate;
}

export function listEstimateItems(projectId: string, estimateId?: string): EstimateItem[] {
  const items = dbLoadByProject<EstimateItem>('estimate_items', projectId).map(r => r.data);
  return estimateId ? items.filter(i => i.estimateId === estimateId) : items;
}

export function addEstimateItem(input: Omit<EstimateItem, 'id' | 'createdAt' | 'updatedAt' | 'totalPriceRub'>): EstimateItem {
  const now = new Date().toISOString();
  const item: EstimateItem = {
    ...input,
    id: `esti-${crypto.randomBytes(6).toString('hex')}`,
    totalPriceRub: Number((input.estimateQty * input.unitPriceRub).toFixed(2)),
    createdAt: now,
    updatedAt: now
  };
  dbUpsert('estimate_items', item.id, item);
  return item;
}

export function updateEstimateItem(id: string, projectId: string, patch: Partial<EstimateItem>): EstimateItem | null {
  const existing = listEstimateItems(projectId).find(i => i.id === id);
  if (!existing) return null;
  const updated: EstimateItem = { ...existing, ...patch, id, projectId, updatedAt: new Date().toISOString() };
  updated.totalPriceRub = Number((updated.estimateQty * updated.unitPriceRub).toFixed(2));
  dbUpsert('estimate_items', id, updated);
  return updated;
}

export function deleteEstimateItem(id: string): void {
  dbDelete('estimate_items', id);
}

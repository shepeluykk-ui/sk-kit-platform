import crypto from 'crypto';
import { dbUpsert, dbLoadAll, dbDelete } from '../database';

export interface Organization {
  id: string;
  name: string;
  inn: string;
  ogrn: string;
  type: 'CUSTOMER' | 'GENERAL_CONTRACTOR' | 'SUBCONTRACTOR' | 'DESIGN_INSTITUTE' | 'SUPERVISION' | 'SUPPLIER';
  sroNumber?: string;
  sroExpiryDate?: string;
  directorName: string;
  contactEmail: string;
  contactPhone: string;
  createdAt: string;
  updatedAt: string;
}

export function listOrganizations(): Organization[] {
  return dbLoadAll<Organization>('organizations').map(r => r.data);
}

export function getOrganization(id: string): Organization | null {
  return listOrganizations().find(o => o.id === id) || null;
}

export function createOrganization(input: Omit<Organization, 'id' | 'createdAt' | 'updatedAt'>): Organization {
  const now = new Date().toISOString();
  const org: Organization = { ...input, id: `org-${crypto.randomBytes(6).toString('hex')}`, createdAt: now, updatedAt: now };
  dbUpsert('organizations', org.id, org);
  return org;
}

export function updateOrganization(id: string, patch: Partial<Organization>): Organization | null {
  const existing = getOrganization(id);
  if (!existing) return null;
  const updated: Organization = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
  dbUpsert('organizations', id, updated);
  return updated;
}

// -----------------------------------------------------------------------
// Project membership — replaces implicit user.allowedProjectIds as the
// source of truth (see DOMAIN_MODEL.md). user.allowedProjectIds stays as a
// derived/backward-compatible field so the existing API contract doesn't
// break, but membership is now also recorded here explicitly.
// -----------------------------------------------------------------------

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  roleInProject: string;
  addedAt: string;
  addedBy: string;
}

export function listProjectMembers(projectId?: string): ProjectMember[] {
  const all = dbLoadAll<ProjectMember>('project_members').map(r => r.data);
  return projectId ? all.filter(m => m.projectId === projectId) : all;
}

export function addProjectMember(input: Omit<ProjectMember, 'id' | 'addedAt'>): ProjectMember {
  const member: ProjectMember = { ...input, id: `pm-${crypto.randomBytes(6).toString('hex')}`, addedAt: new Date().toISOString() };
  dbUpsert('project_members', member.id, member);
  return member;
}

export function removeProjectMember(id: string): void {
  dbDelete('project_members', id);
}

import { apiRequest, apiRequestEnvelope } from '../../lib/api-client';

export type WorkspaceRole = 'OWNER' | 'MEMBER';

/** One row of GET /workspaces: public workspace fields plus the caller's role. */
export interface WorkspaceListItem {
  id: string;
  name: string;
  createdAt: string;
  role: WorkspaceRole;
}

export interface WorkspacePage {
  workspaces: WorkspaceListItem[];
  /** Opaque token for the next page; null on the last page. */
  nextCursor: string | null;
}

export const WORKSPACE_PAGE_SIZE = 20;

export async function listWorkspaces(
  { cursor, limit = WORKSPACE_PAGE_SIZE }: { cursor?: string | undefined; limit?: number } = {},
  signal?: AbortSignal,
): Promise<WorkspacePage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);

  const { data, meta } = await apiRequestEnvelope<
    { workspaces: WorkspaceListItem[] },
    { nextCursor?: string | null }
  >(`/workspaces?${query}`, signal ? { signal } : {});
  return { workspaces: data.workspaces, nextCursor: meta?.nextCursor ?? null };
}

export interface CreatedWorkspace {
  workspace: { id: string; name: string; createdAt: string };
  membership: { role: WorkspaceRole };
}

/** POST; the API client attaches the in-memory CSRF token. */
export function createWorkspace(name: string): Promise<CreatedWorkspace> {
  return apiRequest('/workspaces', { method: 'POST', body: { name } });
}

/** GET /workspaces/:id: the workspace plus the caller's role (404 if not a member). */
export interface WorkspaceDetail {
  workspace: { id: string; name: string; createdAt: string };
  membership: { role: WorkspaceRole };
}

export function getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceDetail> {
  return apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}`, signal ? { signal } : {});
}

export interface WorkspaceMember {
  userId: string;
  /** Optional display name (absent from older API responses). */
  name?: string | null;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export const MEMBER_PAGE_SIZE = 20;

export async function listMembers(
  workspaceId: string,
  { cursor, limit = MEMBER_PAGE_SIZE }: { cursor?: string | undefined; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ members: WorkspaceMember[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);

  const { data, meta } = await apiRequestEnvelope<
    { members: WorkspaceMember[] },
    { nextCursor?: string | null }
  >(`/workspaces/${encodeURIComponent(workspaceId)}/members?${query}`, signal ? { signal } : {});
  return { members: data.members, nextCursor: meta?.nextCursor ?? null };
}

/** DELETE (owner only, MEMBER targets only); the API client attaches the CSRF token. */
export function removeMember(workspaceId: string, userId: string): Promise<{ removed: true }> {
  return apiRequest(
    `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

/** PATCH (owner only); the API client attaches the CSRF token. */
export function changeMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<{ member: { userId: string; role: WorkspaceRole }; changed: boolean }> {
  return apiRequest(
    `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/role`,
    { method: 'PATCH', body: { role } },
  );
}

/** GET/PATCH /workspaces/:id/settings. Any member reads; owners edit. */
export interface WorkspaceSettings {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  /** Send back as `expectedUpdatedAt` when editing (409 if someone changed it since). */
  updatedAt: string;
}

export interface WorkspaceSettingsDetail {
  settings: WorkspaceSettings;
  membership: { role: WorkspaceRole };
}

export function getWorkspaceSettings(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceSettingsDetail> {
  return apiRequest(
    `/workspaces/${encodeURIComponent(workspaceId)}/settings`,
    signal ? { signal } : {},
  );
}

export function updateWorkspaceSettings(
  workspaceId: string,
  changes: { name?: string; description?: string | null; expectedUpdatedAt: string },
): Promise<WorkspaceSettingsDetail> {
  return apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/settings`, {
    method: 'PATCH',
    body: changes,
  });
}

/** DELETE (owners only): permanently deletes the workspace and everything in it. */
export function deleteWorkspace(workspaceId: string): Promise<{ deleted: true }> {
  return apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
}

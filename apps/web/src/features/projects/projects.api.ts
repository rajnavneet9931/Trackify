import { apiRequest, apiRequestEnvelope } from '../../lib/api-client';

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED';

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** POST (owner only); the API client attaches the CSRF token. */
export function createProject(
  workspaceId: string,
  input: { name: string; description?: string },
): Promise<{ project: Project }> {
  return apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
    method: 'POST',
    body: input,
  });
}

export const PROJECT_PAGE_SIZE = 20;

/** GET (any workspace member), newest first. `nextCursor` is null on the last page. */
export async function listProjects(
  workspaceId: string,
  { cursor, limit = PROJECT_PAGE_SIZE }: { cursor?: string | undefined; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ projects: Project[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);

  const { data, meta } = await apiRequestEnvelope<
    { projects: Project[] },
    { nextCursor?: string | null }
  >(`/workspaces/${encodeURIComponent(workspaceId)}/projects?${query}`, signal ? { signal } : {});
  return { projects: data.projects, nextCursor: meta?.nextCursor ?? null };
}

export interface ProjectDetail {
  project: Project;
  /** Only while the creator is still a member of the workspace; otherwise null. */
  creator: { id: string; email: string } | null;
}

const projectPath = (workspaceId: string, projectId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`;

/** GET (any workspace member, archived projects included). */
export function getProject(
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectDetail> {
  return apiRequest(projectPath(workspaceId, projectId), signal ? { signal } : {});
}

/**
 * PATCH (owner only, ACTIVE projects only). `expectedUpdatedAt` is the
 * `updatedAt` the user saw: if someone changed the project since, the API
 * answers 409 instead of overwriting their change.
 */
export function updateProject(
  workspaceId: string,
  projectId: string,
  input: { name: string; description: string | null; expectedUpdatedAt: string },
): Promise<{ project: Project }> {
  return apiRequest(projectPath(workspaceId, projectId), { method: 'PATCH', body: input });
}

/** POST (owner only). Idempotent: `changed` is false if it already had that status. */
export function archiveProject(
  workspaceId: string,
  projectId: string,
): Promise<{ project: Project; changed: boolean }> {
  return apiRequest(`${projectPath(workspaceId, projectId)}/archive`, { method: 'POST' });
}

export function restoreProject(
  workspaceId: string,
  projectId: string,
): Promise<{ project: Project; changed: boolean }> {
  return apiRequest(`${projectPath(workspaceId, projectId)}/restore`, { method: 'POST' });
}

/** DELETE (owner only): permanent. */
export function deleteProject(workspaceId: string, projectId: string): Promise<{ deleted: true }> {
  return apiRequest(projectPath(workspaceId, projectId), { method: 'DELETE' });
}

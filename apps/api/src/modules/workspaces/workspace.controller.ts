import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import { getAuth } from '../sessions/index.js';
import type { WorkspaceSettings, WorkspaceSummary } from './workspace.model.js';
import type { WorkspaceService } from './workspace.service.js';
import type {
  ChangeRoleBody,
  CreateWorkspaceBody,
  ListMembersQuery,
  MemberParams,
  ListWorkspacesQuery,
  UpdateSettingsBody,
  WorkspaceParams,
} from './workspace.validators.js';

/** Response shape for a workspace. Built field by field so nothing else can leak. */
function toWorkspaceResponse(workspace: WorkspaceSummary) {
  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt.toISOString(),
  };
}

/** Response shape for workspace settings. Built field by field. */
function toSettingsResponse(settings: WorkspaceSettings) {
  return {
    id: settings.id,
    name: settings.name,
    description: settings.description,
    createdAt: settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt.toISOString(),
  };
}

export class WorkspaceController {
  constructor(private readonly service: WorkspaceService) {}

  /** Behind requireSession + validate(): the owner comes from the session, never the body. */
  create = async (req: Request, res: Response): Promise<void> => {
    const { name } = req.body as CreateWorkspaceBody;
    const { workspace, membership } = await this.service.create({
      userId: getAuth(req).user.id,
      name,
    });

    sendSuccess(
      res,
      { workspace: toWorkspaceResponse(workspace), membership: { role: membership.role } },
      201,
    );
  };

  /** Behind requireSession + validate(): lists only the session user's memberships. */
  list = async (req: Request, res: Response): Promise<void> => {
    const { limit, cursor } = req.query as unknown as ListWorkspacesQuery;
    const page = await this.service.list({ userId: getAuth(req).user.id, limit, cursor });

    // User-specific data: never cache in shared caches or the browser.
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(
      res,
      {
        workspaces: page.items.map((item) => ({ ...toWorkspaceResponse(item), role: item.role })),
      },
      200,
      { limit, nextCursor: page.nextCursor },
    );
  };

  /** One workspace the session user belongs to (404 otherwise). */
  get = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    const { workspace, membership } = await this.service.get(workspaceId, getAuth(req).user.id);

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, {
      workspace: toWorkspaceResponse(workspace),
      membership: { role: membership.role },
    });
  };

  /** Members of a workspace the session user belongs to (404 otherwise). */
  listMembers = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    const { limit, cursor } = req.query as unknown as ListMembersQuery;
    const page = await this.service.listMembers(workspaceId, {
      userId: getAuth(req).user.id,
      limit,
      cursor,
    });

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(
      res,
      {
        members: page.items.map((member) => ({
          userId: member.userId,
          name: member.name,
          email: member.email,
          role: member.role,
          joinedAt: member.joinedAt.toISOString(),
        })),
      },
      200,
      { limit, nextCursor: page.nextCursor },
    );
  };

  /** Owner removes a MEMBER. Requester from the session; target only from the URL. */
  removeMember = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, userId } = req.params as MemberParams;
    await this.service.removeMember(workspaceId, getAuth(req).user.id, userId);
    sendSuccess(res, { removed: true });
  };

  /** Owner sets a member's role. Requester from the session; target from the URL. */
  changeRole = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, userId } = req.params as MemberParams;
    const { role } = req.body as ChangeRoleBody;
    const result = await this.service.changeRole(workspaceId, getAuth(req).user.id, userId, role);
    sendSuccess(res, {
      member: { userId: result.userId, role: result.role },
      changed: result.changed,
    });
  };

  /** Settings of a workspace the session user belongs to (404 otherwise). */
  getSettings = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    const { settings, membership } = await this.service.getSettings(
      workspaceId,
      getAuth(req).user.id,
    );
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, {
      settings: toSettingsResponse(settings),
      membership: { role: membership.role },
    });
  };

  /** Owner edits the settings; the requester always comes from the session. */
  updateSettings = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    const { expectedUpdatedAt, name, description } = req.body as UpdateSettingsBody;
    const { settings, membership } = await this.service.updateSettings(
      workspaceId,
      getAuth(req).user.id,
      expectedUpdatedAt,
      { name, description },
    );
    sendSuccess(res, {
      settings: toSettingsResponse(settings),
      membership: { role: membership.role },
    });
  };

  /** Owner permanently deletes the workspace in the URL (and only that one). */
  deleteWorkspace = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    await this.service.deleteWorkspace(workspaceId, getAuth(req).user.id);
    sendSuccess(res, { deleted: true });
  };
}

import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import { getAuth } from '../sessions/index.js';
import type { WorkspaceParams } from '../workspaces/index.js';
import type { ProjectView } from './project.model.js';
import type { ProjectService } from './project.service.js';
import type {
  CreateProjectBody,
  ListProjectsQuery,
  ProjectParams,
  UpdateProjectBody,
} from './project.validators.js';

/** Response shape for a project. Built field by field so nothing else can leak. */
function toProjectResponse(project: ProjectView) {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    description: project.description,
    status: project.status,
    createdById: project.createdById,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export class ProjectController {
  constructor(private readonly service: ProjectService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    const body = req.body as CreateProjectBody;
    const project = await this.service.create(workspaceId, getAuth(req).user.id, body);
    sendSuccess(res, { project: toProjectResponse(project) }, 201);
  };

  /** Projects of a workspace the session user belongs to (404 otherwise). */
  list = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    const { limit, cursor } = req.query as unknown as ListProjectsQuery;
    const page = await this.service.list(workspaceId, {
      userId: getAuth(req).user.id,
      limit,
      cursor,
    });

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { projects: page.items.map(toProjectResponse) }, 200, {
      limit,
      nextCursor: page.nextCursor,
    });
  };

  /** One project of a workspace the session user belongs to (404 otherwise). */
  get = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId } = req.params as ProjectParams;
    const { creator, ...project } = await this.service.get(
      workspaceId,
      projectId,
      getAuth(req).user.id,
    );

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, {
      project: toProjectResponse(project),
      // Only id and email, and only while the creator is a member of this workspace.
      creator: creator && { id: creator.id, email: creator.email },
    });
  };

  /** Owner edits name/description. Requester from the session; project only from the URL. */
  update = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId } = req.params as ProjectParams;
    const body = req.body as UpdateProjectBody;
    const project = await this.service.update(workspaceId, projectId, getAuth(req).user.id, body);
    sendSuccess(res, { project: toProjectResponse(project) });
  };

  archive = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId } = req.params as ProjectParams;
    const result = await this.service.archive(workspaceId, projectId, getAuth(req).user.id);
    sendSuccess(res, { project: toProjectResponse(result.project), changed: result.changed });
  };

  restore = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId } = req.params as ProjectParams;
    const result = await this.service.restore(workspaceId, projectId, getAuth(req).user.id);
    sendSuccess(res, { project: toProjectResponse(result.project), changed: result.changed });
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId } = req.params as ProjectParams;
    await this.service.delete(workspaceId, projectId, getAuth(req).user.id);
    sendSuccess(res, { deleted: true });
  };
}

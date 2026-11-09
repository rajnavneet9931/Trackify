import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import { getAuth } from '../sessions/index.js';
import type { ActivityService, ActivityView } from './activity.service.js';
import type { ListActivitiesQuery, TaskActivitiesParams } from './activity.validators.js';

/** Response shape for an activity. Built field by field so nothing else can leak. */
function toActivityResponse(activity: ActivityView) {
  return {
    id: activity.id,
    taskId: activity.taskId,
    type: activity.type,
    actorId: activity.actorId,
    actor: activity.actor && { id: activity.actor.id, email: activity.actor.email },
    details: activity.details,
    createdAt: activity.createdAt.toISOString(),
  };
}

export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId, taskId } = req.params as TaskActivitiesParams;
    const { limit, cursor } = req.query as unknown as ListActivitiesQuery;
    const page = await this.service.list(workspaceId, projectId, taskId, {
      userId: getAuth(req).user.id,
      limit,
      cursor,
    });

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { activities: page.items.map(toActivityResponse) }, 200, {
      limit,
      nextCursor: page.nextCursor,
    });
  };
}

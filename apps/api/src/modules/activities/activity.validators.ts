import { z } from 'zod';

import { ACTIVITY_PAGE_SIZE_DEFAULT, ACTIVITY_PAGE_SIZE_MAX } from './activity.model.js';

/** List query. Strict like the other lists: unknown or repeated parameters are rejected. */
export const listActivitiesQuerySchema = z.strictObject({
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be an integer' })
    .min(1, { error: 'limit must be at least 1' })
    .max(ACTIVITY_PAGE_SIZE_MAX, { error: `limit must be at most ${ACTIVITY_PAGE_SIZE_MAX}` })
    .default(ACTIVITY_PAGE_SIZE_DEFAULT),
  cursor: z.string({ error: 'cursor must be a string' }).min(1).max(300).optional(),
});

export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;

/** A UUID route parameter, compared in lower case (same rule as the other routes). */
const uuidParam = (field: string) =>
  z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: `${field} must be a valid UUID` }));

/** `…/projects/:projectId/tasks/:taskId/activities` route parameters. */
export const taskActivitiesParamsSchema = z.strictObject({
  workspaceId: uuidParam('workspaceId'),
  projectId: uuidParam('projectId'),
  taskId: uuidParam('taskId'),
});

export type TaskActivitiesParams = z.infer<typeof taskActivitiesParamsSchema>;

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { sendSuccess } from '../../core/http/api-response.js';
import { validate } from '../../core/middleware/validate.js';
import { getAuth } from '../sessions/index.js';
import {
  NOTIFICATION_PAGE_SIZE_DEFAULT,
  NOTIFICATION_PAGE_SIZE_MAX,
  type NotificationView,
} from './notification.model.js';
import type { NotificationService } from './notification.service.js';

const listQuerySchema = z.strictObject({
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be an integer' })
    .min(1, { error: 'limit must be at least 1' })
    .max(NOTIFICATION_PAGE_SIZE_MAX, {
      error: `limit must be at most ${NOTIFICATION_PAGE_SIZE_MAX}`,
    })
    .default(NOTIFICATION_PAGE_SIZE_DEFAULT),
  cursor: z.string({ error: 'cursor must be a string' }).min(1).max(300).optional(),
  unreadOnly: z
    .enum(['true', 'false'], { error: 'unreadOnly must be true or false' })
    .default('false')
    .transform((v) => v === 'true'),
});

const idParamsSchema = z.strictObject({
  notificationId: z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: 'notificationId must be a valid UUID' })),
});

const noInputSchema = z.strictObject({});
/** Mutations take no input besides the URL; any query parameter or body field is a 400. */
const noInput = { query: noInputSchema, body: noInputSchema.optional() };

/** Response shape. Built field by field so nothing else can leak. */
function toResponse(n: NotificationView) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    workspaceId: n.workspaceId,
    resourceType: n.resourceType,
    resourceId: n.resourceId,
    actorId: n.actorId,
    actor: n.actor && { id: n.actor.id, email: n.actor.email },
    isRead: n.isRead,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
    target: n.target && {
      workspaceId: n.target.workspaceId,
      projectId: n.target.projectId,
      taskId: n.target.taskId,
    },
  };
}

/**
 * Mounted at /notifications: the signed-in user's own notifications only.
 * Unsafe methods need the CSRF token (requireSession) and a same-origin request.
 */
export function createNotificationRouter(
  service: NotificationService,
  guards: { requireSession: RequestHandler },
): Router {
  const router = Router();
  router.use(guards.requireSession);

  router.get('/', validate({ query: listQuerySchema }), async (req: Request, res: Response) => {
    const { limit, cursor, unreadOnly } = req.query as unknown as z.infer<typeof listQuerySchema>;
    const page = await service.list(getAuth(req).user.id, { limit, cursor, unreadOnly });
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { notifications: page.items.map(toResponse) }, 200, {
      limit,
      nextCursor: page.nextCursor,
    });
  });

  router.get(
    '/unread-count',
    validate({ query: noInputSchema }),
    async (req: Request, res: Response) => {
      const unreadCount = await service.unreadCount(getAuth(req).user.id);
      res.setHeader('Cache-Control', 'no-store');
      sendSuccess(res, { unreadCount });
    },
  );

  // Registered before /:notificationId/read so "read-all" is never taken for an ID.
  router.patch('/read-all', validate(noInput), async (req: Request, res: Response) => {
    const updated = await service.markAllRead(getAuth(req).user.id);
    sendSuccess(res, { updated });
  });

  const markRead = async (req: Request, res: Response) => {
    const { notificationId } = req.params as z.infer<typeof idParamsSchema>;
    const notification = await service.markRead(getAuth(req).user.id, notificationId);
    sendSuccess(res, { notification: toResponse(notification) });
  };
  const readValidation = validate({ params: idParamsSchema, ...noInput });
  router.patch('/:notificationId/read', readValidation, markRead);
  // Step 18's original route, kept so existing clients keep working.
  router.post('/:notificationId/read', readValidation, markRead);

  router.delete(
    '/:notificationId',
    validate({ params: idParamsSchema, ...noInput }),
    async (req: Request, res: Response) => {
      const { notificationId } = req.params as z.infer<typeof idParamsSchema>;
      await service.delete(getAuth(req).user.id, notificationId);
      sendSuccess(res, { deleted: true });
    },
  );

  return router;
}

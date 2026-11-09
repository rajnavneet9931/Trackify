import type { RequestHandler, Router } from 'express';

import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import {
  PrismaNotificationRepository,
  type NotificationRepository,
} from './notification.repository.js';
import { createNotificationRouter } from './notification.routes.js';
import { NotificationService } from './notification.service.js';

// Public API of the notifications module.
export { createNotifications } from './notification-writer.js';
export { formatUtc, taskAssigned, taskCommented, taskReminder } from './notification-messages.js';
export {
  NotificationResourceType,
  NotificationType,
  type NotificationInput,
  type NotificationTarget,
  type NotificationView,
} from './notification.model.js';
export {
  PrismaNotificationRepository,
  type NotificationPageQuery,
  type NotificationRepository,
} from './notification.repository.js';

export interface NotificationModuleDeps {
  db: DatabaseClient;
  requireSession: RequestHandler;
  /** Override for tests. Defaults to the Prisma-backed implementation. */
  repository?: NotificationRepository | undefined;
}

/** Composition root for the in-app notification center API. */
export function createNotificationModule({
  db,
  requireSession,
  repository,
}: NotificationModuleDeps): Router {
  const service = new NotificationService(repository ?? new PrismaNotificationRepository(db));
  return createNotificationRouter(service, { requireSession });
}

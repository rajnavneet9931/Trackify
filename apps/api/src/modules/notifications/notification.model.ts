import { NotificationResourceType, NotificationType } from '../../generated/prisma/enums.js';

export { NotificationResourceType, NotificationType };

export const NOTIFICATION_PAGE_SIZE_DEFAULT = 20;
export const NOTIFICATION_PAGE_SIZE_MAX = 50;
export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_MESSAGE_MAX = 500;

/** A notification to create. The recipient always comes from server-side data. */
export interface NotificationInput {
  recipientId: string;
  type: NotificationType;
  title: string;
  message: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  /** Identifies the event, e.g. "comment:<id>": one notification per event and recipient. */
  eventKey: string;
}

/** Where a notification leads, resolved when reading; null if the resource is gone. */
export interface NotificationTarget {
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
}

/** A notification as read back by its recipient. */
export interface NotificationView {
  id: string;
  workspaceId: string;
  type: NotificationType;
  title: string;
  message: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  /** Null for system events (reminders) or once the account was deleted. */
  actorId: string | null;
  /** Only while the actor is still a member of the workspace. */
  actor: { id: string; email: string } | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
  target: NotificationTarget | null;
}

export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

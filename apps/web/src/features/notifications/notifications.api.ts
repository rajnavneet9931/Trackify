import { apiRequest, apiRequestEnvelope } from '../../lib/api-client';

export type NotificationType = 'TASK_ASSIGNED' | 'TASK_COMMENTED' | 'TASK_REMINDER';

/** Where a notification leads; null when the task or project no longer exists. */
export interface NotificationTarget {
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
}

/** One of the signed-in user's notifications (the API only ever returns their own). */
export interface AppNotification {
  id: string;
  type: NotificationType | string;
  title: string;
  message: string;
  workspaceId: string;
  resourceType: 'TASK' | 'PROJECT' | 'WORKSPACE';
  resourceId: string;
  /** Null for reminders (sent by the system) or once the account was deleted. */
  actorId: string | null;
  /** Null when the actor is not (or no longer) a member of the workspace. */
  actor: { id: string; email: string } | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  target: NotificationTarget | null;
}

export const NOTIFICATION_PAGE_SIZE = 20;

/** GET: newest first; `unreadOnly` lists unread ones only. */
export async function listNotifications(
  {
    cursor,
    limit = NOTIFICATION_PAGE_SIZE,
    unreadOnly = false,
  }: { cursor?: string | undefined; limit?: number; unreadOnly?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ notifications: AppNotification[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (unreadOnly) query.set('unreadOnly', 'true');
  if (cursor) query.set('cursor', cursor);
  const { data, meta } = await apiRequestEnvelope<
    { notifications: AppNotification[] },
    { nextCursor?: string | null }
  >(`/notifications?${query}`, signal ? { signal } : {});
  return { notifications: data.notifications, nextCursor: meta?.nextCursor ?? null };
}

export async function getUnreadCount(signal?: AbortSignal): Promise<number> {
  const { unreadCount } = await apiRequest<{ unreadCount: number }>(
    '/notifications/unread-count',
    signal ? { signal } : {},
  );
  return unreadCount;
}

/** PATCH (idempotent): marks one notification as read. */
export async function markNotificationRead(id: string): Promise<AppNotification> {
  const { notification } = await apiRequest<{ notification: AppNotification }>(
    `/notifications/${encodeURIComponent(id)}/read`,
    { method: 'PATCH' },
  );
  return notification;
}

/** PATCH: marks every notification as read; returns how many changed. */
export async function markAllNotificationsRead(): Promise<number> {
  const { updated } = await apiRequest<{ updated: number }>('/notifications/read-all', {
    method: 'PATCH',
  });
  return updated;
}

export async function deleteNotification(id: string): Promise<void> {
  await apiRequest(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** The app route for a target, or null when there is nowhere to go. */
export function notificationPath(target: NotificationTarget | null): string | null {
  if (!target) return null;
  const workspace = `/workspaces/${target.workspaceId}`;
  if (!target.projectId) return workspace;
  const project = `${workspace}/projects/${target.projectId}`;
  return target.taskId ? `${project}/tasks/${target.taskId}` : project;
}

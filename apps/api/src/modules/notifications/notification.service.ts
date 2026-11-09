import { BadRequestError, NotFoundError } from '../../core/errors/app-error.js';
import type { NotificationCursor, NotificationView } from './notification.model.js';
import type { NotificationRepository } from './notification.repository.js';

const PREFIX = 'n2:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH_MS = /^(0|[1-9][0-9]{0,15})$/;

/**
 * Opaque cursor bound to its user and to the unread-only flag: someone else's
 * cursor, or one from the other list, is rejected (400).
 */
export function encodeNotificationCursor(
  userId: string,
  unreadOnly: boolean,
  { createdAt, id }: NotificationCursor,
) {
  const raw = `${PREFIX}${userId}|${unreadOnly ? 'u' : 'a'}|${createdAt.getTime()}|${id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeNotificationCursor(
  cursor: string,
  userId: string,
  unreadOnly: boolean,
): NotificationCursor {
  const decoded = /^[A-Za-z0-9_-]+$/.test(cursor)
    ? Buffer.from(cursor, 'base64url').toString('utf8')
    : '';
  const [forUser = '', list = '', ms = '', id = '', ...rest] = decoded.startsWith(PREFIX)
    ? decoded.slice(PREFIX.length).split('|')
    : [];
  const createdAt = new Date(EPOCH_MS.test(ms) ? Number(ms) : Number.NaN);
  if (
    rest.length > 0 ||
    forUser !== userId ||
    list !== (unreadOnly ? 'u' : 'a') ||
    !UUID.test(id) ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new BadRequestError('Invalid pagination cursor', [
      { location: 'query', path: 'cursor', message: 'Invalid cursor' },
    ]);
  }
  return { createdAt, id };
}

const NOT_FOUND = 'Notification not found';

/**
 * The signed-in user's in-app notifications. The recipient is always the
 * session user; another user's notification is a 404, like a missing one.
 */
export class NotificationService {
  constructor(private readonly notifications: NotificationRepository) {}

  async list(userId: string, { limit, cursor, unreadOnly }: ListInput) {
    const rows = await this.notifications.listForUser(userId, {
      take: limit + 1, // one extra row tells whether another page exists
      unreadOnly,
      after:
        cursor === undefined ? undefined : decodeNotificationCursor(cursor, userId, unreadOnly),
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last ? encodeNotificationCursor(userId, unreadOnly, last) : null,
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.notifications.countUnread(userId);
  }

  async markRead(userId: string, id: string): Promise<NotificationView> {
    const notification = await this.notifications.markRead(userId, id);
    if (!notification) throw new NotFoundError(NOT_FOUND);
    return notification;
  }

  markAllRead(userId: string): Promise<number> {
    return this.notifications.markAllRead(userId);
  }

  async delete(userId: string, id: string): Promise<void> {
    if (!(await this.notifications.delete(userId, id))) throw new NotFoundError(NOT_FOUND);
  }
}

interface ListInput {
  limit: number;
  cursor?: string | undefined;
  unreadOnly: boolean;
}

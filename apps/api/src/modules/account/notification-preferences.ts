import type { Prisma } from '../../generated/prisma/client.js';
import { NotificationType } from '../../generated/prisma/enums.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';

/** The settings column behind each notification type. */
const COLUMN = {
  [NotificationType.TASK_ASSIGNED]: 'notifyTaskAssigned',
  [NotificationType.TASK_COMMENTED]: 'notifyTaskCommented',
  [NotificationType.TASK_REMINDER]: 'notifyTaskReminder',
} as const;

type Client = Pick<DatabaseClient | Prisma.TransactionClient, 'userSettings'>;

/**
 * The notification types each of `userIds` has turned off. Users without a
 * settings row (or with everything on) are absent: every type is on by default.
 * One query however many users.
 */
export async function mutedNotificationTypes(
  db: Client,
  userIds: string[],
): Promise<Map<string, Set<NotificationType>>> {
  const muted = new Map<string, Set<NotificationType>>();
  if (userIds.length === 0) return muted;
  const rows = await db.userSettings.findMany({
    where: {
      userId: { in: userIds },
      OR: [
        { notifyTaskAssigned: false },
        { notifyTaskCommented: false },
        { notifyTaskReminder: false },
      ],
    },
    select: {
      userId: true,
      notifyTaskAssigned: true,
      notifyTaskCommented: true,
      notifyTaskReminder: true,
    },
  });
  for (const row of rows) {
    const off = (Object.keys(COLUMN) as NotificationType[]).filter((type) => !row[COLUMN[type]]);
    muted.set(row.userId, new Set(off));
  }
  return muted;
}

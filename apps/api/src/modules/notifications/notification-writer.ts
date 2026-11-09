import type { Prisma } from '../../generated/prisma/client.js';
import { mutedNotificationTypes } from '../account/index.js';
import {
  NOTIFICATION_MESSAGE_MAX,
  NOTIFICATION_TITLE_MAX,
  type NotificationInput,
} from './notification.model.js';

/**
 * Creates notifications **inside the caller's transaction**, so they commit
 * only if the operation they describe commits (a failed or rolled-back
 * operation never notifies anyone). Rules applied here, for every caller:
 * - never about the actor's own action (`recipientId === actorId` is dropped);
 * - one per recipient and event (duplicates in `inputs` are merged, and the
 *   unique index on (recipient_id, event_key) skips any that already exist,
 *   e.g. a retried reminder);
 * - only to current members of the workspace;
 * - only types the recipient has not turned off in their settings.
 * Returns how many were created.
 */
export async function createNotifications(
  tx: Prisma.TransactionClient,
  context: { workspaceId: string; actorId: string | null },
  inputs: NotificationInput[],
): Promise<number> {
  const unique = new Map<string, NotificationInput>();
  for (const input of inputs) {
    if (input.recipientId === context.actorId) continue;
    const key = `${input.recipientId}|${input.eventKey}`;
    if (!unique.has(key)) unique.set(key, input);
  }
  if (unique.size === 0) return 0;

  const recipients = [...new Set([...unique.values()].map((n) => n.recipientId))];
  const members = await tx.workspaceMember.findMany({
    where: { workspaceId: context.workspaceId, userId: { in: recipients } },
    select: { userId: true },
  });
  const allowed = new Set(members.map((m) => m.userId));
  const muted = await mutedNotificationTypes(tx, [...allowed]);
  const data = [...unique.values()]
    .filter((n) => allowed.has(n.recipientId) && !muted.get(n.recipientId)?.has(n.type))
    .map((n) => ({
      recipientId: n.recipientId,
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      type: n.type,
      title: n.title.slice(0, NOTIFICATION_TITLE_MAX),
      message: n.message.slice(0, NOTIFICATION_MESSAGE_MAX),
      resourceType: n.resourceType,
      resourceId: n.resourceId,
      eventKey: n.eventKey,
    }));
  if (data.length === 0) return 0;
  const { count } = await tx.notification.createMany({ data, skipDuplicates: true });
  return count;
}

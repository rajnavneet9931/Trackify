import type { Prisma } from '../../generated/prisma/client.js';
import { validatedMetadata, type ActivityInput } from './activity.model.js';

/**
 * Activity timestamps strictly increase within this process (at least 1 ms
 * apart), so several entries recorded by one operation keep the order in
 * which they were recorded instead of tying on the transaction's start time.
 * Across processes, equal timestamps are ordered by id.
 */
let lastActivityMs = 0;
function nextActivityTime(): Date {
  lastActivityMs = Math.max(Date.now(), lastActivityMs + 1);
  return new Date(lastActivityMs);
}

/**
 * Records one activity entry **inside the caller's transaction**, so it
 * commits or rolls back together with the operation it describes. The actor
 * is always the authenticated requester passed in by the server, never a
 * client value. Metadata is validated first; a mismatch throws and rolls the
 * whole operation back.
 */
export async function recordTaskActivity(
  tx: Prisma.TransactionClient,
  taskId: string,
  actorId: string,
  input: ActivityInput,
): Promise<void> {
  await tx.taskActivity.create({
    data: {
      taskId,
      userId: actorId,
      type: input.type,
      metadata: validatedMetadata(input) as Prisma.InputJsonValue,
      createdAt: nextActivityTime(),
    },
    select: { id: true },
  });
}

/**
 * Records several activities by one actor in a single statement, inside the
 * caller's transaction (e.g. every task unassigned by a member removal).
 * Each entry's metadata is validated first.
 */
export async function recordTaskActivities(
  tx: Prisma.TransactionClient,
  actorId: string,
  entries: { taskId: string; activity: ActivityInput }[],
): Promise<void> {
  if (entries.length === 0) return;
  await tx.taskActivity.createMany({
    data: entries.map(({ taskId, activity }) => ({
      taskId,
      userId: actorId,
      type: activity.type,
      metadata: validatedMetadata(activity) as Prisma.InputJsonValue,
      createdAt: nextActivityTime(),
    })),
  });
}

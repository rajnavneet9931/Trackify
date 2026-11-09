import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { createNotifications, taskReminder } from '../notifications/index.js';

/** A due reminder claimed for delivery, with its resolved recipient. */
export interface ClaimedReminder {
  id: string;
  taskId: string;
  remindAt: Date;
  /** The assignee if still a member, else the creator if still a member, else null. */
  recipientId: string | null;
}

export type DeliveryOutcome = 'SENT' | 'FAILED' | 'CANCELLED';

/** Thrown when delivery of a claimed reminder failed; its transaction was rolled back. */
export class ReminderDeliveryError extends Error {
  constructor(
    readonly reminderId: string,
    override readonly cause: unknown,
  ) {
    super('Reminder delivery failed');
    this.name = 'ReminderDeliveryError';
  }
}

export interface ReminderRepository {
  /**
   * Claims the oldest due PENDING reminder not in `skip` with
   * `FOR UPDATE SKIP LOCKED` and settles it in the same transaction: CANCELLED
   * (project archived), FAILED (no eligible recipient) or SENT, after the
   * recipient's in-app notification is created and `deliver` succeeds. Returns null when nothing is due. Other instances skip
   * the locked row, so a reminder is never processed twice; if anything
   * throws, the transaction rolls back and the reminder stays PENDING.
   */
  processNext(
    now: Date,
    skip: string[],
    deliver: (reminder: ClaimedReminder) => Promise<void>,
  ): Promise<{ id: string; outcome: DeliveryOutcome } | null>;
  /**
   * Records a failed delivery attempt; after `maxAttempts` the reminder is
   * marked FAILED, otherwise it stays PENDING for a later run.
   */
  recordFailure(id: string, message: string, maxAttempts: number): Promise<void>;
}

const LOCK_TIMEOUT = '5s';

export class PrismaReminderRepository implements ReminderRepository {
  constructor(private readonly db: DatabaseClient) {}

  async processNext(
    now: Date,
    skip: string[],
    deliver: (reminder: ClaimedReminder) => Promise<void>,
  ) {
    let claimed: string | null = null;
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        // Served by the partial index task_reminders_pending_due_idx.
        const [row] = await tx.$queryRaw<{ id: string; task_id: string; remind_at: Date }[]>`
          SELECT id, task_id, remind_at FROM task_reminders
          WHERE status = 'PENDING'::reminder_status
            AND remind_at <= ${now.toISOString()}::timestamptz
            AND NOT (id = ANY(${skip}::uuid[]))
          ORDER BY remind_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        if (!row) return null;
        claimed = row.id;

        const [task] = await tx.$queryRaw<
          {
            archived: boolean;
            assignee_id: string | null;
            assignee_member: boolean;
            created_by_id: string;
            creator_member: boolean;
            workspace_id: string;
            title: string;
            due_date: Date | null;
          }[]
        >`
          SELECT p.status = 'ARCHIVED'::project_status AS archived,
                 p.workspace_id, t.title, t.due_date,
                 t.assignee_id,
                 EXISTS (SELECT 1 FROM workspace_members m
                         WHERE m.workspace_id = p.workspace_id AND m.user_id = t.assignee_id) AS assignee_member,
                 t.created_by_id,
                 EXISTS (SELECT 1 FROM workspace_members m
                         WHERE m.workspace_id = p.workspace_id AND m.user_id = t.created_by_id) AS creator_member
          FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ${row.task_id}::uuid`;

        const settle = async (outcome: DeliveryOutcome, extra: Record<string, unknown> = {}) => {
          await tx.taskReminder.update({
            where: { id: row.id },
            data: { status: outcome, ...extra },
            select: { id: true },
          });
          return { id: row.id, outcome };
        };

        if (!task || task.archived) {
          return settle('CANCELLED', { lastError: 'Project archived' });
        }
        const recipientId = task.assignee_member
          ? task.assignee_id
          : task.creator_member
            ? task.created_by_id
            : null;
        if (!recipientId) {
          return settle('FAILED', { lastError: 'No eligible recipient' });
        }

        // The in-app notification, in this same transaction: it exists exactly
        // when the reminder is SENT. Its event key is the reminder ID, so even a
        // retried delivery can never create a second one.
        await createNotifications(tx, { workspaceId: task.workspace_id, actorId: null }, [
          taskReminder({
            recipientId,
            taskId: row.task_id,
            taskTitle: task.title,
            dueDate: task.due_date,
            reminderId: row.id,
          }),
        ]);
        await deliver({ id: row.id, taskId: row.task_id, remindAt: row.remind_at, recipientId });
        return settle('SENT', { recipientId, sentAt: new Date(), lastError: null });
      });
    } catch (error) {
      if (claimed) throw new ReminderDeliveryError(claimed, error);
      throw error;
    }
  }

  async recordFailure(id: string, message: string, maxAttempts: number) {
    await this.db.$executeRaw`
      UPDATE task_reminders
      SET attempts = attempts + 1,
          last_error = ${message.slice(0, 500)},
          status = CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'FAILED'::reminder_status
                        ELSE status END,
          updated_at = now()
      WHERE id = ${id}::uuid AND status = 'PENDING'::reminder_status`;
  }
}

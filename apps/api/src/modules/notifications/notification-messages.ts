import {
  NotificationResourceType,
  NotificationType,
  type NotificationInput,
} from './notification.model.js';

/**
 * The wording of every notification, in one place. Messages may quote a task
 * title (visible to every member anyway) but never comment text, task
 * descriptions, emails or anything else sensitive. The actor is not part of
 * the text: it is returned separately, and only while they are a member.
 */

const quote = (title: string) => `“${title}”`;

/** "2026-11-04 17:00 UTC": unambiguous for everyone; the web app also shows local times. */
export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const task = (taskId: string) => ({
  resourceType: NotificationResourceType.TASK,
  resourceId: taskId,
});

/** The new assignee of a task. One event per assignment change (the task's new updated_at). */
export function taskAssigned(input: {
  recipientId: string;
  taskId: string;
  taskTitle: string;
  reassigned: boolean;
  changedAt: Date;
}): NotificationInput {
  return {
    recipientId: input.recipientId,
    type: NotificationType.TASK_ASSIGNED,
    title: input.reassigned ? 'Task reassigned to you' : 'Task assigned to you',
    message: `You are now the assignee of ${quote(input.taskTitle)}.`,
    ...task(input.taskId),
    eventKey: `assigned:${input.taskId}:${input.changedAt.getTime()}`,
  };
}

/** Someone else commented: the assignee and the creator (once each). */
export function taskCommented(input: {
  recipientId: string;
  taskId: string;
  taskTitle: string;
  commentId: string;
  as: 'assignee' | 'creator';
}): NotificationInput {
  return {
    recipientId: input.recipientId,
    type: NotificationType.TASK_COMMENTED,
    title: 'New comment',
    message:
      input.as === 'assignee'
        ? `New comment on ${quote(input.taskTitle)}, which is assigned to you.`
        : `New comment on ${quote(input.taskTitle)}, which you created.`,
    ...task(input.taskId),
    eventKey: `comment:${input.commentId}`,
  };
}

/** A scheduled reminder came due. One per reminder row. */
export function taskReminder(input: {
  recipientId: string;
  taskId: string;
  taskTitle: string;
  dueDate: Date | null;
  reminderId: string;
}): NotificationInput {
  return {
    recipientId: input.recipientId,
    type: NotificationType.TASK_REMINDER,
    title: 'Task due soon',
    message: input.dueDate
      ? `${quote(input.taskTitle)} is due ${formatUtc(input.dueDate)}.`
      : `Reminder for ${quote(input.taskTitle)}.`,
    ...task(input.taskId),
    eventKey: `reminder:${input.reminderId}`,
  };
}

import { PRIORITY_LABELS, STATUS_LABELS } from '../tasks/labels';
import type { PersonRef, TaskActivity } from './activity.api';

/**
 * Who did it: "You" for the viewer, the email of a current member, "A former
 * member" for someone who left, "A deleted user" once their account is gone.
 */
export function actorName(activity: TaskActivity, currentUserId: string): string {
  if (activity.actorId === null) return 'A deleted user';
  if (activity.actorId === currentUserId) return 'You';
  return activity.actor?.email ?? 'A former member';
}

function personName(person: PersonRef, currentUserId: string): string {
  if (person.id === currentUserId) return 'you';
  return person.email ?? 'a former member';
}

/** A readable sentence for one entry, e.g. "Alex changed status from To do to In progress." */
export function describeActivity(activity: TaskActivity, currentUserId: string): string {
  const who = actorName(activity, currentUserId);
  const d = activity.details;
  if ('unavailable' in d) return `${who} changed this task.`;

  switch (d.type) {
    case 'TASK_CREATED':
      return `${who} created this task.`;
    case 'TASK_UPDATED': {
      const renamed = d.title ? `renamed this task from “${d.title.from}” to “${d.title.to}”` : '';
      const described = d.changedFields.includes('description') ? 'updated the description' : '';
      return `${who} ${[renamed, described].filter(Boolean).join(' and ')}.`;
    }
    case 'STATUS_CHANGED':
      return `${who} changed status from ${STATUS_LABELS[d.from]} to ${STATUS_LABELS[d.to]}.`;
    case 'PRIORITY_CHANGED':
      return `${who} changed priority from ${PRIORITY_LABELS[d.from]} to ${PRIORITY_LABELS[d.to]}.`;
    case 'ASSIGNEE_CHANGED':
      if (d.to === null) {
        return d.reason === 'MEMBER_REMOVED' && d.from
          ? `${who} removed ${personName(d.from, currentUserId)} from the workspace, which removed the task assignment.`
          : `${who} removed the task assignment.`;
      }
      return d.from === null
        ? `${who} assigned this task to ${personName(d.to, currentUserId)}.`
        : `${who} reassigned this task from ${personName(d.from, currentUserId)} to ${personName(d.to, currentUserId)}.`;
    case 'COMMENT_ADDED':
      return `${who} added a comment.`;
    case 'COMMENT_EDITED':
      return `${who} edited a comment.`;
    case 'COMMENT_DELETED':
      return `${who} deleted a comment.`;
    default:
      return `${who} changed this task.`;
  }
}

import { Link } from 'react-router';

import type { DashboardActivity } from './dashboard.api';
import { useDateTime } from '../account/preferences-context';

const VERBS: Record<string, string> = {
  TASK_CREATED: 'created',
  TASK_UPDATED: 'updated',
  STATUS_CHANGED: 'changed the status of',
  PRIORITY_CHANGED: 'changed the priority of',
  ASSIGNEE_CHANGED: 'changed the assignee of',
  COMMENT_ADDED: 'commented on',
  COMMENT_EDITED: 'edited a comment on',
  COMMENT_DELETED: 'deleted a comment on',
};

/** Same wording as the task timeline: "You", a member's email, or who they were. */
function actorName(activity: DashboardActivity, currentUserId: string) {
  if (activity.actorId === null) return 'A deleted user';
  if (activity.actorId === currentUserId) return 'You';
  return activity.actor?.email ?? 'A former member';
}

const link =
  'font-medium text-slate-900 hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';

/** The latest workspace activity, each entry linking to its task and project. */
export function RecentActivity({
  workspaceId,
  activities,
  currentUserId,
}: {
  workspaceId: string;
  activities: DashboardActivity[];
  currentUserId: string;
}) {
  const dt = useDateTime();
  if (activities.length === 0) {
    return <p className="mt-4 text-sm text-slate-500">No activity yet.</p>;
  }
  return (
    <ol aria-label="Recent activity" className="mt-4 divide-y divide-slate-100">
      {activities.map((a) => {
        const projectPath = `/workspaces/${workspaceId}/projects/${a.project.id}`;
        return (
          <li key={a.id} className="py-3 text-sm first:pt-0 last:pb-0">
            <p className="break-words text-slate-700">
              {actorName(a, currentUserId)} {VERBS[a.type] ?? 'changed'}{' '}
              <Link to={`${projectPath}/tasks/${a.task.id}`} className={link}>
                {a.task.title}
              </Link>{' '}
              in{' '}
              <Link to={projectPath} className={link}>
                {a.project.name}
              </Link>
            </p>
            <time dateTime={a.createdAt} className="mt-0.5 block text-xs text-slate-500">
              {dt.format(a.createdAt)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

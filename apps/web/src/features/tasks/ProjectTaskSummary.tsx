import { useEffect, useState } from 'react';

import { StatTile } from '../../components/ui/Panel';
import { useDateTime } from '../account/preferences-context';
import { queryFromView } from './task-view';
import { DEFAULT_VIEW } from './task-view';
import { listTasks, type TaskListQuery } from './tasks.api';

type Counts = {
  total: number | null;
  done: number | null;
  inProgress: number | null;
  overdue: number | null;
};

/**
 * The project's task counts, from the task list API itself (`meta.total` of
 * one-row queries with the matching filter), so they are always real and
 * agree with what the list shows. Reloaded when `version` changes (a task was
 * created or its status changed).
 */
export function ProjectTaskSummary({
  workspaceId,
  projectId,
  version,
}: {
  workspaceId: string;
  projectId: string;
  version: number;
}) {
  const { timeZone } = useDateTime();
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const base = queryFromView(DEFAULT_VIEW, new Date(), timeZone);
    const count = (extra: Partial<TaskListQuery>) =>
      listTasks(
        workspaceId,
        projectId,
        { limit: 1, query: { ...base, ...extra } },
        controller.signal,
      )
        .then((page) => page.total)
        .catch(() => null);
    void Promise.all([
      count({}),
      count({ status: 'DONE' }),
      count({ status: 'IN_PROGRESS' }),
      count({ overdue: true }),
    ]).then(([total, done, inProgress, overdue]) => {
      if (!controller.signal.aborted) setCounts({ total, done, inProgress, overdue });
    });
    return () => controller.abort();
  }, [workspaceId, projectId, version, timeZone]);

  const show = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n);
  const percent =
    counts?.total && counts.done !== null ? Math.floor((counts.done * 100) / counts.total) : null;

  return (
    <dl aria-label="Task summary" className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Total tasks" value={show(counts?.total)} icon="list" tone="brand" />
      <StatTile
        label="Completed"
        value={show(counts?.done)}
        hint={percent !== null ? `${percent}% of all tasks` : undefined}
        icon="checkCircle"
        tone="success"
      />
      <StatTile label="In progress" value={show(counts?.inProgress)} icon="progress" tone="info" />
      <StatTile
        label="Overdue"
        value={show(counts?.overdue)}
        icon="alert"
        tone={counts?.overdue ? 'danger' : 'neutral'}
      />
    </dl>
  );
}

import { useEffect, useState } from 'react';

import { getDashboard, type MyTask } from '../dashboard/dashboard.api';
import type { WorkspaceListItem } from '../workspaces/workspaces.api';

/** How many workspaces the Home page asks for "my work" (one request each, in parallel). */
export const MY_WORK_WORKSPACES = 6;

export interface MyWorkTask extends MyTask {
  workspace: { id: string; name: string };
}

export type MyWorkState =
  | { status: 'loading' }
  | {
      status: 'ready';
      pending: number;
      overdue: number;
      upcoming: number;
      /** Open tasks assigned to me (each workspace's soonest five), soonest due first. */
      tasks: MyWorkTask[];
      /** Workspaces whose numbers are included. */
      included: number;
      /** Workspaces that couldn't be read (left out of the totals). */
      failed: number;
    };

/**
 * The signed-in user's work across workspaces, from each workspace's
 * dashboard (`myWork`): real counts and their soonest open tasks. There is no
 * cross-workspace endpoint, so this covers the first `MY_WORK_WORKSPACES`
 * workspaces given (most recently opened first) and says so.
 */
export function useMyWork(workspaces: WorkspaceListItem[] | null): MyWorkState {
  const key = workspaces ? workspaces.map((w) => w.id).join(',') : null;
  const [state, setState] = useState<{ key: string | null; value: MyWorkState }>({
    key: null,
    value: { status: 'loading' },
  });

  useEffect(() => {
    if (!workspaces) return;
    const controller = new AbortController();
    const picked = workspaces.slice(0, MY_WORK_WORKSPACES);
    void Promise.all(
      picked.map((w) =>
        getDashboard(w.id, controller.signal)
          .then((d) => ({ w, d }))
          .catch(() => null),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
      const tasks = ok
        .flatMap(({ w, d }) =>
          d.myWork.tasks.map((t) => ({ ...t, workspace: { id: w.id, name: w.name } })),
        )
        .sort((a, b) => {
          if (!a.dueDate) return b.dueDate ? 1 : 0;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });
      setState({
        key,
        value: {
          status: 'ready',
          pending: ok.reduce((n, { d }) => n + d.myWork.pending, 0),
          overdue: ok.reduce((n, { d }) => n + d.myWork.overdue, 0),
          upcoming: ok.reduce((n, { d }) => n + d.myWork.upcoming, 0),
          tasks,
          included: ok.length,
          failed: results.length - ok.length,
        },
      });
    });
    return () => controller.abort();
    // `key` identifies the workspace list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state.key === key ? state.value : { status: 'loading' };
}

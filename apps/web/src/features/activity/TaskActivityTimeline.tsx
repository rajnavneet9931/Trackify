import { useCallback } from 'react';

import { usePaginatedList } from '../../lib/usePaginatedList';
import { listActivities, type TaskActivity } from './activity.api';
import { describeActivity } from './describe';
import { useDateTime } from '../account/preferences-context';
import { buttonClass } from '../../components/ui/styles';

const secondaryButton = buttonClass('secondary');

const getKey = (activity: TaskActivity) => activity.id;

/**
 * A task's activity history, oldest first, read-only (also in archived
 * projects). New entries appear at the end; "Refresh" reloads after changes
 * made on this page. Mount with `key={taskId}` so another task never shows it.
 */
export function TaskActivityTimeline({
  target,
  currentUserId,
}: {
  target: { workspaceId: string; projectId: string; taskId: string };
  currentUserId: string;
}) {
  const dt = useDateTime();
  const { workspaceId, projectId, taskId } = target;
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal?: AbortSignal) => {
      const page = await listActivities({ workspaceId, projectId, taskId }, { cursor }, signal);
      return { items: page.activities, nextCursor: page.nextCursor };
    },
    [workspaceId, projectId, taskId],
  );
  const { state, retry, loadMore } = usePaginatedList({
    fetchPage,
    getKey,
    errorMessage: 'We couldn’t load the activity history. Please try again.',
  });

  return (
    <section aria-labelledby="activity-heading" className="mt-8">
      <div className="flex items-center justify-between gap-2">
        <h2 id="activity-heading" className="text-base font-semibold">
          Activity
        </h2>
        {state.status === 'ready' && (
          <button
            type="button"
            onClick={retry}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            Refresh
          </button>
        )}
      </div>

      {state.status === 'loading' && (
        <p role="status" className="mt-4 text-sm text-slate-500">
          Loading activity…
        </p>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          <p>{state.message}</p>
          <button type="button" onClick={retry} className={`mt-3 ${secondaryButton}`}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && state.items.length === 0 && (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
          No activity yet.
        </p>
      )}

      {state.status === 'ready' && state.items.length > 0 && (
        <>
          <ol aria-label="Activity" className="mt-4 space-y-3 border-l-2 border-slate-200 pl-4">
            {state.items.map((activity) => (
              <li key={activity.id} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 -left-[1.4rem] h-2.5 w-2.5 rounded-full bg-slate-300"
                />
                <p className="text-sm break-words text-slate-800">
                  {describeActivity(activity, currentUserId)}
                </p>
                <p className="text-xs text-slate-500">
                  <time dateTime={activity.createdAt}>{dt.format(activity.createdAt)}</time>
                </p>
              </li>
            ))}
          </ol>

          {state.loadMoreError && (
            <p role="alert" className="mt-4 text-sm text-rose-700">
              {state.loadMoreError}
            </p>
          )}

          {state.nextCursor && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={state.loadingMore}
                className={secondaryButton}
              >
                {state.loadingMore ? 'Loading…' : 'Load more activity'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

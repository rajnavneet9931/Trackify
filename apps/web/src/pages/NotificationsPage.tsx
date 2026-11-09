import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

import { useAuth } from '../features/auth/auth-context';
import { NotificationItem } from '../features/notifications/NotificationItem';
import {
  listNotifications,
  type AppNotification,
} from '../features/notifications/notifications.api';
import { useNotifications } from '../features/notifications/notifications-context';
import { useNotificationActions } from '../features/notifications/useNotificationActions';
import { usePaginatedList } from '../lib/usePaginatedList';
import { buttonClass } from '../components/ui/styles';

const secondaryButton = buttonClass('secondary');

const tabClass = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
    active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:text-slate-900'
  }`;

const getKey = (n: AppNotification) => n.id;

/**
 * The signed-in user's notification center: all or unread only (kept in the
 * URL as `?unread=1`), newest first, with Load more. Times are local.
 */
export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get('unread') === '1';
  const { unreadCount } = useNotifications();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
      <p className="mt-1 text-sm text-slate-600">
        Assignments, comments on your tasks and due-date reminders.
      </p>

      <div role="group" aria-label="Show" className="mt-6 flex gap-1">
        <button
          type="button"
          aria-pressed={!unreadOnly}
          onClick={() => setParams({}, { replace: true })}
          className={tabClass(!unreadOnly)}
        >
          All
        </button>
        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={() => setParams({ unread: '1' }, { replace: true })}
          className={tabClass(unreadOnly)}
        >
          Unread{unreadCount ? ` (${unreadCount})` : ''}
        </button>
      </div>

      {/* Remounted per filter: switching restarts pagination. */}
      <NotificationList key={unreadOnly ? 'unread' : 'all'} unreadOnly={unreadOnly} />
    </div>
  );
}

function NotificationList({ unreadOnly }: { unreadOnly: boolean }) {
  const { session } = useAuth();
  const { unreadCount } = useNotifications();
  const currentUserId = session.status === 'authenticated' ? session.user.id : '';
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal?: AbortSignal) => {
      const page = await listNotifications({ cursor, unreadOnly }, signal);
      return { items: page.notifications, nextCursor: page.nextCursor };
    },
    [unreadOnly],
  );
  const { state, retry, loadMore, update, remove } = usePaginatedList({
    fetchPage,
    getKey,
    errorMessage: 'We couldn’t load your notifications. Please try again.',
  });
  const actions = useNotificationActions({
    onUpdated: useCallback((n: AppNotification) => update(n.id, () => n), [update]),
    onRemoved: remove,
    onAllRead: useCallback(() => {
      if (state.status !== 'ready') return;
      const readAt = new Date().toISOString();
      for (const n of state.items) {
        if (!n.isRead) update(n.id, (item) => ({ ...item, isRead: true, readAt }));
      }
    }, [state, update]),
  });

  return (
    <>
      {actions.error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {actions.error}
        </p>
      )}

      {state.status === 'loading' && (
        <p role="status" className="mt-6 text-sm text-slate-500">
          Loading notifications…
        </p>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          <p>{state.message}</p>
          <button type="button" onClick={retry} className={`mt-3 ${secondaryButton}`}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && state.items.length === 0 && (
        <p className="mt-6 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
          {unreadOnly ? 'No unread notifications.' : 'No notifications yet.'}
        </p>
      )}

      {state.status === 'ready' && state.items.length > 0 && (
        <>
          {(unreadCount ?? 0) > 0 && (
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => void actions.markAllRead()}
                disabled={actions.isBusy('read-all')}
                className={secondaryButton}
              >
                Mark all as read
              </button>
            </div>
          )}
          <ul
            aria-label="Notifications"
            className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-panel"
          >
            {state.items.map((n) => (
              <NotificationItem
                key={n.id}
                notification={n}
                currentUserId={currentUserId}
                onOpen={(item) => void actions.markRead(item)}
                onMarkRead={(item) => void actions.markRead(item)}
                onDelete={(item) => void actions.remove(item)}
                busy={actions.isBusy}
              />
            ))}
          </ul>

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
                {state.loadingMore ? 'Loading…' : 'Load more notifications'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

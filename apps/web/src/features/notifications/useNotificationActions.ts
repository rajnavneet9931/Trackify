import { useCallback, useRef, useState } from 'react';

import { useToast } from '../../components/ui/toast-context';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import {
  deleteNotification,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification,
} from './notifications.api';
import { useNotifications } from './notifications-context';

const GONE = 'This notification is no longer available.';

/**
 * Read / delete actions shared by the bell and the notifications page. One
 * request per notification at a time (repeated clicks are ignored), the list
 * is updated only from the server's answer, and the unread count is re-read
 * afterwards. A 401 ends the session; a 404 means the notification is gone
 * (deleted elsewhere, or its workspace left), so it is removed from the list.
 */
export function useNotificationActions({
  onUpdated,
  onRemoved,
  onAllRead,
}: {
  onUpdated: (notification: AppNotification) => void;
  onRemoved: (id: string) => void;
  onAllRead: () => void;
}) {
  const { invalidateSession } = useAuth();
  const { refreshUnreadCount } = useNotifications();
  const { notify } = useToast();
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();

  const run = useCallback(
    async (key: string, action: () => Promise<void>, failure: string, id?: string) => {
      if (pending.current.has(key)) return;
      pending.current.add(key);
      setBusy(new Set(pending.current));
      setError(undefined);
      try {
        await action();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          invalidateSession();
          return;
        }
        if (err instanceof ApiError && err.status === 404 && id) {
          onRemoved(id);
          setError(GONE);
        } else {
          setError(failure);
        }
      } finally {
        pending.current.delete(key);
        setBusy(new Set(pending.current));
        refreshUnreadCount();
      }
    },
    [invalidateSession, onRemoved, refreshUnreadCount],
  );

  const markRead = useCallback(
    (n: AppNotification) =>
      n.isRead
        ? Promise.resolve()
        : run(
            `read:${n.id}`,
            async () => onUpdated(await markNotificationRead(n.id)),
            'Couldn’t mark the notification as read. Please try again.',
            n.id,
          ),
    [run, onUpdated],
  );

  const remove = useCallback(
    (n: AppNotification) =>
      run(
        `delete:${n.id}`,
        async () => {
          await deleteNotification(n.id);
          onRemoved(n.id);
          notify('Notification deleted.');
        },
        'Couldn’t delete the notification. Please try again.',
        n.id,
      ),
    [run, onRemoved, notify],
  );

  const markAllRead = useCallback(
    () =>
      run(
        'read-all',
        async () => {
          await markAllNotificationsRead();
          onAllRead();
          notify('All notifications marked as read.');
        },
        'Couldn’t mark all notifications as read. Please try again.',
      ),
    [run, onAllRead, notify],
  );

  return {
    markRead,
    remove,
    markAllRead,
    isBusy: (key: string) => busy.has(key),
    error,
    setError,
  };
}

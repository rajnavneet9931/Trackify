import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { getUnreadCount } from './notifications.api';
import { NotificationsContext } from './notifications-context';

/** How often the unread count is re-read while the tab is visible. */
export const UNREAD_POLL_MS = 60_000;

/**
 * Keeps the signed-in user's unread notification count. No WebSockets or
 * other infrastructure: the count is fetched on sign-in, every minute while
 * the tab is visible, when the window regains focus, and after every
 * notification action. A failed refresh keeps the last known count.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { session, invalidateSession } = useAuth();
  const userId = session.status === 'authenticated' ? session.user.id : null;
  const [state, setState] = useState<{ userId: string | null; count: number | null }>({
    userId: null,
    count: null,
  });
  const [tick, setTick] = useState(0);

  const refreshUnreadCount = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    getUnreadCount(controller.signal)
      .then((count) => setState({ userId, count }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) invalidateSession();
      });
    return () => controller.abort();
  }, [userId, tick, invalidateSession]);

  useEffect(() => {
    if (!userId) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') refreshUnreadCount();
    };
    const timer = setInterval(refreshIfVisible, UNREAD_POLL_MS);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [userId, refreshUnreadCount]);

  // Never show one user's count to another (sign-out, then sign-in as someone else).
  const unreadCount = userId && state.userId === userId ? state.count : null;
  const value = useMemo(
    () => ({ unreadCount, refreshUnreadCount }),
    [unreadCount, refreshUnreadCount],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

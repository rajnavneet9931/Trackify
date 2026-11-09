import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { NotificationItem } from './NotificationItem';
import { listNotifications, type AppNotification } from './notifications.api';
import { useNotifications } from './notifications-context';
import { useNotificationActions } from './useNotificationActions';

/** How many of the newest notifications the dropdown shows. */
export const BELL_PREVIEW_SIZE = 5;

type Preview =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: AppNotification[] };

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0m6 0H9"
      />
    </svg>
  );
}

/**
 * The navigation's bell: unread count badge and a dropdown with the newest
 * notifications (loaded each time it opens). Closes on Escape, on a click
 * outside, and on navigation.
 */
export function NotificationBell() {
  const { session, invalidateSession } = useAuth();
  const { unreadCount, refreshUnreadCount } = useNotifications();
  const currentUserId = session.status === 'authenticated' ? session.user.id : '';
  const location = useLocation();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [openedAt, setOpenedAt] = useState(location.key);

  // Navigating (e.g. by opening a notification) closes the panel.
  if (open && openedAt !== location.key) setOpen(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    listNotifications({ limit: BELL_PREVIEW_SIZE }, controller.signal)
      .then(({ notifications }) => setPreview({ status: 'ready', items: notifications }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) invalidateSession();
        else setPreview({ status: 'error' });
      });
    return () => controller.abort();
  }, [open, attempt, invalidateSession]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const setItems = useCallback(
    (fn: (items: AppNotification[]) => AppNotification[]) =>
      setPreview((p) => (p.status === 'ready' ? { status: 'ready', items: fn(p.items) } : p)),
    [],
  );
  const actions = useNotificationActions({
    onUpdated: useCallback(
      (updated: AppNotification) =>
        setItems((items) => items.map((n) => (n.id === updated.id ? updated : n))),
      [setItems],
    ),
    onRemoved: useCallback(
      (id: string) => setItems((items) => items.filter((n) => n.id !== id)),
      [setItems],
    ),
    onAllRead: useCallback(
      () =>
        setItems((items) =>
          items.map((n) =>
            n.isRead ? n : { ...n, isRead: true, readAt: new Date().toISOString() },
          ),
        ),
      [setItems],
    ),
  });

  const toggle = () => {
    if (!open) {
      setPreview({ status: 'loading' });
      setOpenedAt(location.key);
      actions.setError(undefined);
      refreshUnreadCount();
    }
    setOpen(!open);
  };

  const count = unreadCount ?? 0;
  const label = count > 0 ? `Notifications, ${count} unread` : 'Notifications';

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <BellIcon />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-rose-600 px-1 text-center text-[11px] leading-5 font-semibold text-white tabular-nums"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Notifications"
          className="absolute right-0 z-20 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Notifications</h2>
            {count > 0 && (
              <button
                type="button"
                onClick={() => void actions.markAllRead()}
                disabled={actions.isBusy('read-all')}
                className="rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
              >
                Mark all as read
              </button>
            )}
          </div>

          {actions.error && (
            <p
              role="alert"
              className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-800"
            >
              {actions.error}
            </p>
          )}

          <div className="max-h-[min(28rem,70vh)] overflow-y-auto">
            {preview.status === 'loading' && (
              <p role="status" className="px-4 py-6 text-center text-sm text-slate-500">
                Loading notifications…
              </p>
            )}
            {preview.status === 'error' && (
              <div role="alert" className="px-4 py-6 text-center text-sm text-rose-800">
                <p>We couldn’t load your notifications.</p>
                <button
                  type="button"
                  onClick={() => {
                    setPreview({ status: 'loading' });
                    setAttempt((n) => n + 1);
                  }}
                  className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Try again
                </button>
              </div>
            )}
            {preview.status === 'ready' && preview.items.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                You’re all caught up. No notifications.
              </p>
            )}
            {preview.status === 'ready' && preview.items.length > 0 && (
              <ul aria-label="Latest notifications" className="divide-y divide-slate-100">
                {preview.items.map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    currentUserId={currentUserId}
                    onOpen={(item) => void actions.markRead(item)}
                    onMarkRead={(item) => void actions.markRead(item)}
                    onDelete={(item) => void actions.remove(item)}
                    busy={actions.isBusy}
                    compact
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-slate-100 px-4 py-2.5 text-center">
            <Link
              to="/notifications"
              className="text-sm font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

import { Link } from 'react-router';

import { notificationPath, type AppNotification } from './notifications.api';
import { useDateTime } from '../account/preferences-context';

const actionClass =
  'rounded-md px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60';

function source(n: AppNotification, currentUserId: string): string {
  if (n.actorId === null) return 'Trackify';
  if (n.actorId === currentUserId) return 'You';
  return n.actor?.email ?? 'A former member';
}

/**
 * One notification: unread marker, title, message, who and when. Opening it
 * marks it as read and goes to the task or project; when that no longer
 * exists there is no link, just a note.
 */
export function NotificationItem({
  notification: n,
  currentUserId,
  onOpen,
  onMarkRead,
  onDelete,
  busy,
  compact = false,
}: {
  notification: AppNotification;
  currentUserId: string;
  onOpen: (n: AppNotification) => void;
  onMarkRead: (n: AppNotification) => void;
  onDelete: (n: AppNotification) => void;
  busy: (key: string) => boolean;
  compact?: boolean;
}) {
  const dt = useDateTime();
  const path = notificationPath(n.target);
  return (
    <li
      className={`flex gap-3 ${compact ? 'px-4 py-3' : 'px-5 py-4'} ${n.isRead ? '' : 'bg-brand-50/60'}`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 size-2 shrink-0 rounded-full ${n.isRead ? 'bg-transparent' : 'bg-brand-600'}`}
      />
      <div className="min-w-0 flex-1">
        <p className={`text-sm break-words text-slate-900 ${n.isRead ? '' : 'font-semibold'}`}>
          {!n.isRead && <span className="sr-only">Unread: </span>}
          {path ? (
            <Link
              to={path}
              onClick={() => onOpen(n)}
              className="hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              {n.title}
            </Link>
          ) : (
            n.title
          )}
        </p>
        <p className="mt-0.5 text-sm break-words text-slate-600">{n.message}</p>
        <p className="mt-1 text-xs text-slate-500">
          {source(n, currentUserId)} · <time dateTime={n.createdAt}>{dt.format(n.createdAt)}</time>
          {!path && ' · No longer available'}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {!n.isRead && (
            <button
              type="button"
              onClick={() => onMarkRead(n)}
              disabled={busy(`read:${n.id}`)}
              aria-label={`Mark as read: ${n.message}`}
              className={`${actionClass} text-brand-700 hover:bg-brand-50`}
            >
              Mark as read
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(n)}
            disabled={busy(`delete:${n.id}`)}
            aria-label={`Delete: ${n.message}`}
            className={`${actionClass} text-slate-600 hover:bg-slate-100`}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

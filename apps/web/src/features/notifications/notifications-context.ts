import { createContext, useContext } from 'react';

export interface NotificationsContextValue {
  /** The signed-in user's unread count; null while unknown (signed out, loading or failed). */
  unreadCount: number | null;
  /**
   * Re-reads the count from the server (the source of truth). Call after any
   * notification action instead of adjusting the number locally, so repeated
   * or overlapping actions can never make it drift.
   */
  refreshUnreadCount: () => void;
}

export const NotificationsContext = createContext<NotificationsContextValue>({
  unreadCount: null,
  refreshUnreadCount: () => undefined,
});

export function useNotifications(): NotificationsContextValue {
  return useContext(NotificationsContext);
}

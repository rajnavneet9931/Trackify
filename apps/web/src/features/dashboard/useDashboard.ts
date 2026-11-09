import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { getDashboard, type Dashboard } from './dashboard.api';

export type DashboardState =
  | { status: 'loading' }
  | { status: 'ready'; dashboard: Dashboard }
  /** 404 (unknown workspace or not a member) or a malformed ID. */
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * Loads a workspace's dashboard. Same contract as useWorkspaceDetail: 401
 * ends the session, 400/404 are "not found", anything else is retryable.
 * Keyed by workspace, so switching workspaces never shows stale numbers.
 */
export function useDashboard(workspaceId: string) {
  const { invalidateSession } = useAuth();
  const [state, setState] = useState<{ id: string; value: DashboardState }>({
    id: workspaceId,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const settle = (value: DashboardState) => setState({ id: workspaceId, value });

    getDashboard(workspaceId, controller.signal)
      .then((dashboard) => settle({ status: 'ready', dashboard }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          invalidateSession();
        } else if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
          settle({ status: 'not-found' });
        } else {
          settle({
            status: 'error',
            message: 'We couldn’t load the dashboard. Please try again.',
          });
        }
      });
    return () => controller.abort();
  }, [workspaceId, attempt, invalidateSession]);

  const retry = useCallback(() => {
    setState({ id: workspaceId, value: { status: 'loading' } });
    setAttempt((n) => n + 1);
  }, [workspaceId]);

  const value: DashboardState = state.id === workspaceId ? state.value : { status: 'loading' };
  return { state: value, retry };
}

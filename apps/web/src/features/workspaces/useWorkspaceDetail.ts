import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { getWorkspace, type WorkspaceDetail } from './workspaces.api';

export type WorkspaceDetailState =
  | { status: 'loading' }
  | { status: 'ready'; detail: WorkspaceDetail }
  /** 404 (unknown or not a member: the API deliberately does not distinguish) or a malformed ID. */
  | { status: 'not-found' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string };

/**
 * Loads one workspace. Follows the API contract: 401 ends the session (the
 * route guard then redirects to sign-in and back), 400/404 are "not found",
 * 403 is "no access", anything else (503, network) is retryable.
 */
export function useWorkspaceDetail(workspaceId: string) {
  const { invalidateSession } = useAuth();
  const [state, setState] = useState<{ id: string; value: WorkspaceDetailState }>({
    id: workspaceId,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const settle = (value: WorkspaceDetailState) => setState({ id: workspaceId, value });

    getWorkspace(workspaceId, controller.signal)
      .then((detail) => settle({ status: 'ready', detail }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (!(error instanceof ApiError)) {
          settle({ status: 'error', message: 'Something went wrong. Please try again.' });
        } else if (error.status === 401) {
          invalidateSession();
        } else if (error.status === 404 || error.status === 400) {
          settle({ status: 'not-found' });
        } else if (error.status === 403) {
          settle({ status: 'forbidden' });
        } else {
          settle({
            status: 'error',
            message: 'We couldn’t load this workspace. Please try again.',
          });
        }
      });
    return () => controller.abort();
  }, [workspaceId, attempt, invalidateSession]);

  const retry = useCallback(() => {
    setState({ id: workspaceId, value: { status: 'loading' } });
    setAttempt((n) => n + 1);
  }, [workspaceId]);

  // Navigating to another workspace shows "loading" until its own data arrives.
  const value: WorkspaceDetailState =
    state.id === workspaceId ? state.value : { status: 'loading' };
  return { state: value, retry };
}

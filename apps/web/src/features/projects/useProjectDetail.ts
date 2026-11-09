import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { getProject, type Project, type ProjectDetail } from './projects.api';

export type ProjectDetailState =
  | { status: 'loading' }
  | { status: 'ready'; detail: ProjectDetail }
  /** 404 (unknown project, other workspace, or not a member) or a malformed ID. */
  | { status: 'not-found' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string };

/**
 * Loads one project. Same contract as useWorkspaceDetail: 401 ends the
 * session, 400/404 are "not found", 403 "no access", anything else is
 * retryable. State is keyed by workspace + project, so opening another project
 * shows "loading", never the previous project's details.
 */
export function useProjectDetail(workspaceId: string, projectId: string) {
  const { invalidateSession } = useAuth();
  const key = `${workspaceId}/${projectId}`;
  const [state, setState] = useState<{ key: string; value: ProjectDetailState }>({
    key,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const settle = (value: ProjectDetailState) => setState({ key, value });

    getProject(workspaceId, projectId, controller.signal)
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
          settle({ status: 'error', message: 'We couldn’t load this project. Please try again.' });
        }
      });
    return () => controller.abort();
  }, [key, workspaceId, projectId, attempt, invalidateSession]);

  const retry = useCallback(() => {
    setState({ key, value: { status: 'loading' } });
    setAttempt((n) => n + 1);
  }, [key]);

  /** Shows the server's latest version after a successful mutation. */
  const replaceProject = useCallback(
    (project: Project) => {
      setState((current) =>
        current.key === key && current.value.status === 'ready'
          ? {
              key,
              value: { status: 'ready', detail: { ...current.value.detail, project } },
            }
          : current,
      );
    },
    [key],
  );

  const value: ProjectDetailState = state.key === key ? state.value : { status: 'loading' };
  return { state: value, retry, replaceProject };
}

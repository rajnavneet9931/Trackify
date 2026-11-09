import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { getTask, type Task, type TaskDetail } from './tasks.api';

export type TaskDetailState =
  | { status: 'loading' }
  | { status: 'ready'; detail: TaskDetail }
  /** 404 (unknown task, other project or workspace, or not a member) or a malformed ID. */
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * Loads one task. Same contract as the other detail hooks: 401 ends the
 * session, 400/404 are "not found", anything else is retryable. Keyed by
 * workspace + project + task, so another task never shows stale details.
 */
export function useTaskDetail(workspaceId: string, projectId: string, taskId: string) {
  const { invalidateSession } = useAuth();
  const key = `${workspaceId}/${projectId}/${taskId}`;
  const [state, setState] = useState<{ key: string; value: TaskDetailState }>({
    key,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const settle = (value: TaskDetailState) => setState({ key, value });

    getTask(workspaceId, projectId, taskId, controller.signal)
      .then((detail) => settle({ status: 'ready', detail }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (!(error instanceof ApiError)) {
          settle({ status: 'error', message: 'Something went wrong. Please try again.' });
        } else if (error.status === 401) {
          invalidateSession();
        } else if (error.status === 404 || error.status === 400) {
          settle({ status: 'not-found' });
        } else {
          settle({ status: 'error', message: 'We couldn’t load this task. Please try again.' });
        }
      });
    return () => controller.abort();
  }, [key, workspaceId, projectId, taskId, attempt, invalidateSession]);

  const retry = useCallback(() => {
    setState({ key, value: { status: 'loading' } });
    setAttempt((n) => n + 1);
  }, [key]);

  /** Shows the server's latest version after a successful update. */
  const replaceTask = useCallback(
    (task: Task) => {
      setState((current) =>
        current.key === key && current.value.status === 'ready'
          ? { key, value: { status: 'ready', detail: { ...current.value.detail, task } } }
          : current,
      );
    },
    [key],
  );

  const value: TaskDetailState = state.key === key ? state.value : { status: 'loading' };
  return { state: value, retry, replaceTask };
}

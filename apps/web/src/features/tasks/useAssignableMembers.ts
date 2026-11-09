import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { listMembers, type WorkspaceMember } from '../workspaces/workspaces.api';

/** The members endpoint allows 100 per page; stop after this many pages. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export type AssignableMembersState =
  | { status: 'loading' }
  | { status: 'ready'; members: WorkspaceMember[]; truncated: boolean }
  | { status: 'error' };

/**
 * Members of the current workspace, the only people a task can be assigned to
 * (the API enforces the same rule). Loads every page, up to a bound. A 401
 * ends the session; any other failure is retryable.
 */
export function useAssignableMembers(workspaceId: string) {
  const { invalidateSession } = useAuth();
  const [state, setState] = useState<{ id: string; value: AssignableMembersState }>({
    id: workspaceId,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const members: WorkspaceMember[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listMembers(
          workspaceId,
          { cursor, limit: PAGE_SIZE },
          controller.signal,
        );
        members.push(...page.members);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < MAX_PAGES);
      return { members, truncated: Boolean(cursor) };
    })()
      .then(({ members, truncated }) =>
        setState({ id: workspaceId, value: { status: 'ready', members, truncated } }),
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          invalidateSession();
          return;
        }
        setState({ id: workspaceId, value: { status: 'error' } });
      });
    return () => controller.abort();
  }, [workspaceId, attempt, invalidateSession]);

  const retry = useCallback(() => {
    setState({ id: workspaceId, value: { status: 'loading' } });
    setAttempt((n) => n + 1);
  }, [workspaceId]);

  const value: AssignableMembersState =
    state.id === workspaceId ? state.value : { status: 'loading' };
  return { state: value, retry };
}

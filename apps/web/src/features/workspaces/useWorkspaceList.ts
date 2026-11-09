import { useCallback } from 'react';

import { usePaginatedList, type PaginatedState } from '../../lib/usePaginatedList';
import { listWorkspaces, type WorkspaceListItem } from './workspaces.api';

export type WorkspaceListState = PaginatedState<WorkspaceListItem>;

const getKey = (workspace: WorkspaceListItem) => workspace.id;

/** The signed-in user's workspaces, page by page (newest membership first). */
export function useWorkspaceList() {
  const fetchPage = useCallback(async (cursor: string | undefined, signal?: AbortSignal) => {
    const page = await listWorkspaces({ cursor }, signal);
    return { items: page.workspaces, nextCursor: page.nextCursor };
  }, []);

  return usePaginatedList({
    fetchPage,
    getKey,
    errorMessage: 'We couldn’t load your workspaces. Please try again.',
  });
}

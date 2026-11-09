import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '../features/auth/auth-context';
import { ApiError } from './api-client';

export interface PageResult<T> {
  items: T[];
  /** Opaque token for the next page; null on the last page. */
  nextCursor: string | null;
}

export type PaginatedState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; error: unknown }
  | {
      status: 'ready';
      items: T[];
      nextCursor: string | null;
      loadingMore: boolean;
      loadMoreError?: string;
    };

interface Options<T> {
  /** Must be stable (useCallback) — a new function reloads from the first page. */
  fetchPage: (cursor: string | undefined, signal?: AbortSignal) => Promise<PageResult<T>>;
  getKey: (item: T) => string;
  /** Shown for any failure other than 401. */
  errorMessage: string;
}

/**
 * Cursor-paginated list for the API's `{ data, meta.nextCursor }` endpoints.
 * Displays only what the server returns (authorization is the API's job).
 * A 401 means the session ended and is handed to the auth provider, which
 * redirects to sign-in; any other failure is reported with a retry.
 */
export function usePaginatedList<T>({ fetchPage, getKey, errorMessage }: Options<T>) {
  const { invalidateSession } = useAuth();
  const [state, setState] = useState<PaginatedState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loadingMore = useRef(false);

  const isSessionEnd = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        invalidateSession();
        return true;
      }
      return false;
    },
    [invalidateSession],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchPage(undefined, controller.signal)
      .then(({ items, nextCursor }) =>
        setState({ status: 'ready', items, nextCursor, loadingMore: false }),
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted || isSessionEnd(error)) return;
        setState({ status: 'error', message: errorMessage, error });
      });
    return () => controller.abort();
  }, [attempt, fetchPage, isSessionEnd, errorMessage]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const loadMore = useCallback(async () => {
    if (state.status !== 'ready' || !state.nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    const cursor = state.nextCursor;
    setState({ ...state, loadingMore: true, loadMoreError: undefined } as PaginatedState<T>);

    try {
      const page = await fetchPage(cursor);
      setState((current) => {
        if (current.status !== 'ready') return current;
        const known = new Set(current.items.map(getKey));
        return {
          status: 'ready',
          items: [...current.items, ...page.items.filter((item) => !known.has(getKey(item)))],
          nextCursor: page.nextCursor,
          loadingMore: false,
        };
      });
    } catch (error) {
      const sessionEnded = isSessionEnd(error);
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              loadingMore: false,
              ...(!sessionEnded && { loadMoreError: errorMessage }),
            }
          : current,
      );
    } finally {
      loadingMore.current = false;
    }
  }, [state, fetchPage, getKey, isSessionEnd, errorMessage]);

  /** Inserts an item at the top (e.g. one the user just created). */
  const prepend = useCallback(
    (item: T) => {
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              items: [item, ...current.items.filter((i) => getKey(i) !== getKey(item))],
            }
          : current,
      );
    },
    [getKey],
  );

  /**
   * Adds an item at the end, for oldest-first lists (e.g. a new comment). Only
   * once every page is loaded: otherwise it belongs to a later page and will
   * arrive with "Load more". Returns whether it was added.
   */
  const append = useCallback(
    (item: T): boolean => {
      if (state.status !== 'ready' || state.nextCursor !== null) return false;
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              items: [...current.items.filter((i) => getKey(i) !== getKey(item)), item],
            }
          : current,
      );
      return true;
    },
    [state, getKey],
  );

  /** Drops an item from the loaded pages (e.g. after the server deleted it). */
  const remove = useCallback(
    (key: string) => {
      setState((current) =>
        current.status === 'ready'
          ? { ...current, items: current.items.filter((item) => getKey(item) !== key) }
          : current,
      );
    },
    [getKey],
  );

  /** Replaces one loaded item (e.g. after the server changed it). */
  const update = useCallback(
    (key: string, change: (item: T) => T) => {
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              items: current.items.map((item) => (getKey(item) === key ? change(item) : item)),
            }
          : current,
      );
    },
    [getKey],
  );

  return { state, retry, loadMore, prepend, append, remove, update };
}

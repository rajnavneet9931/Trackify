import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { LoadingState } from '../../components/ui/States';
import { buttonClass, linkClass } from '../../components/ui/styles';
import type { WorkspaceDetail } from './workspaces.api';
import { useWorkspaceDetail } from './useWorkspaceDetail';

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="mt-2 text-slate-600">{children}</div>
      <div className="mt-6">
        <Link to="/workspaces" className={linkClass}>
          ← All workspaces
        </Link>
      </div>
    </div>
  );
}

/**
 * Loads a workspace for a workspace page and renders the shared states
 * (skeleton while loading; the same "not found" for unknown workspaces and
 * non-members; "no access"; retryable error), then the page itself.
 */
export function WorkspaceGate({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: (detail: WorkspaceDetail) => ReactNode;
}) {
  const { state, retry } = useWorkspaceDetail(workspaceId);

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-5xl">
        <div aria-hidden="true" className="h-4 w-48 animate-pulse rounded bg-slate-200" />
        <div aria-hidden="true" className="mt-4 h-8 w-72 animate-pulse rounded bg-slate-200" />
        <LoadingState label="Loading workspace…" rows={3} />
      </div>
    );
  }
  if (state.status === 'not-found') {
    return (
      <Notice title="Workspace not found">
        <p>This workspace doesn’t exist, or you don’t have access to it.</p>
      </Notice>
    );
  }
  if (state.status === 'forbidden') {
    return (
      <Notice title="No access">
        <p>You don’t have permission to view this workspace.</p>
      </Notice>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Can’t load this workspace</h1>
        <p className="mt-2 text-slate-600">{state.message}</p>
        <button type="button" onClick={retry} className={`mt-6 ${buttonClass('primary')}`}>
          Try again
        </button>
        <div className="mt-4">
          <Link to="/workspaces" className={linkClass}>
            ← All workspaces
          </Link>
        </div>
      </div>
    );
  }
  return <>{children(state.detail)}</>;
}

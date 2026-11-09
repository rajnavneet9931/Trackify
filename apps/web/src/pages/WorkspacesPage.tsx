import { useRef } from 'react';
import { Link, useLocation } from 'react-router';

import { CreateWorkspaceForm } from '../features/workspaces/CreateWorkspaceForm';
import { RoleBadge } from '../features/workspaces/RoleBadge';
import { useWorkspaceList } from '../features/workspaces/useWorkspaceList';
import { useDateTime } from '../features/account/preferences-context';
import { buttonClass } from '../components/ui/styles';

const secondaryButton = buttonClass('secondary');

/** The signed-in user's workspaces (only reachable through <RequireAuth>). */
export function WorkspacesPage() {
  const dt = useDateTime();
  const { state, retry, loadMore, prepend } = useWorkspaceList();
  const nameInput = useRef<HTMLInputElement>(null);
  const deleted = (useLocation().state as { deletedWorkspace?: unknown } | null)?.deletedWorkspace;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Workspaces</h1>
      <p className="mt-1 text-slate-600">Workspaces you own or belong to.</p>
      {typeof deleted === 'string' && (
        <p
          role="status"
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {deleted} was permanently deleted.
        </p>
      )}

      <section
        aria-labelledby="new-workspace-heading"
        className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-panel"
      >
        <h2 id="new-workspace-heading" className="text-base font-semibold">
          New workspace
        </h2>
        <div className="mt-4">
          <CreateWorkspaceForm inputRef={nameInput} onCreated={prepend} />
        </div>
      </section>

      <section aria-labelledby="your-workspaces-heading" className="mt-8">
        <h2 id="your-workspaces-heading" className="text-base font-semibold">
          Your workspaces
        </h2>

        {state.status === 'loading' && (
          <p role="status" className="mt-4 text-sm text-slate-500">
            Loading workspaces…
          </p>
        )}

        {state.status === 'error' && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
          >
            <p>{state.message}</p>
            <button type="button" onClick={retry} className={`mt-3 ${secondaryButton}`}>
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && state.items.length === 0 && (
          <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
            <p className="font-medium text-slate-900">You’re not in any workspaces yet</p>
            <p className="mt-1 text-sm text-slate-600">
              Create your first workspace to start organizing your team’s work.
            </p>
            <button
              type="button"
              onClick={() => nameInput.current?.focus()}
              className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              Create a workspace
            </button>
          </div>
        )}

        {state.status === 'ready' && state.items.length > 0 && (
          <>
            <ul className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-panel">
              {state.items.map((workspace) => (
                <li
                  key={workspace.id}
                  // "Stretched link": the whole row is clickable, but it is one tab stop.
                  className="relative flex flex-col gap-1 px-5 py-4 focus-within:bg-slate-50 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <Link
                      to={`/workspaces/${workspace.id}`}
                      className="block truncate font-medium text-slate-900 after:absolute after:inset-0 focus-visible:outline-none"
                    >
                      {workspace.name}
                    </Link>
                    <p className="text-sm text-slate-500">
                      Created{' '}
                      <time dateTime={workspace.createdAt}>
                        {dt.format(workspace.createdAt, 'date')}
                      </time>
                    </p>
                  </div>
                  <RoleBadge role={workspace.role} prefix="Your role: " />
                </li>
              ))}
            </ul>

            <p role="status" className="sr-only">
              Showing {state.items.length} workspace{state.items.length === 1 ? '' : 's'}
            </p>

            {state.loadMoreError && (
              <p role="alert" className="mt-4 text-sm text-rose-700">
                {state.loadMoreError}
              </p>
            )}

            {state.nextCursor && (
              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={state.loadingMore}
                  className={secondaryButton}
                >
                  {state.loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

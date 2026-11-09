import { useCallback } from 'react';
import { Link } from 'react-router';

import { usePaginatedList } from '../../lib/usePaginatedList';
import { CreateProjectForm } from './CreateProjectForm';
import { ProjectStatusBadge } from './ProjectStatusBadge';
import { listProjects, type Project } from './projects.api';
import { useDateTime } from '../account/preferences-context';
import { Icon } from '../../components/ui/Icon';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { buttonClass, cardClass } from '../../components/ui/styles';

const getKey = (project: Project) => project.id;

/**
 * Paginated project list of one workspace (newest first), shown to every
 * member. Owners also get the create form; a new project appears at the top.
 * The API decides who may see and create projects.
 */
export function WorkspaceProjects({
  workspaceId,
  canCreate,
}: {
  workspaceId: string;
  /** True for owners. UX only: the API independently refuses everyone else. */
  canCreate: boolean;
}) {
  const dt = useDateTime();
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal?: AbortSignal) => {
      const page = await listProjects(workspaceId, { cursor }, signal);
      return { items: page.projects, nextCursor: page.nextCursor };
    },
    [workspaceId],
  );
  const { state, retry, loadMore, prepend } = usePaginatedList({
    fetchPage,
    getKey,
    errorMessage: 'We couldn’t load the projects of this workspace. Please try again.',
  });

  const COLUMNS = 'md:grid md:grid-cols-[minmax(0,1fr)_7rem_9rem_2rem] md:items-center md:gap-4';

  const list = (
    <section aria-labelledby="projects-heading" className="min-w-0">
      <h2 id="projects-heading" className="sr-only">
        Projects
      </h2>

      {state.status === 'loading' && <LoadingState label="Loading projects…" rows={3} />}

      {state.status === 'error' && <ErrorState message={state.message} onRetry={retry} />}

      {state.status === 'ready' && state.items.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <Icon name="folder" className="mx-auto size-6 text-slate-400" />
          <p className="mt-2 text-sm font-medium text-slate-900">No projects yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            {canCreate ? 'Create the first one with the form.' : 'An owner can create one.'}
          </p>
        </div>
      )}

      {state.status === 'ready' && state.items.length > 0 && (
        <>
          <div className={`${cardClass} overflow-hidden`}>
            <div
              aria-hidden="true"
              className={`hidden border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-xs font-medium text-slate-500 ${COLUMNS}`}
            >
              <span>Project</span>
              <span>Status</span>
              <span>Last updated</span>
              <span />
            </div>
            <ul aria-labelledby="projects-heading" className="divide-y divide-slate-100">
              {state.items.map((project) => (
                <li
                  key={project.id}
                  className={`relative px-4 py-3 transition-colors hover:bg-slate-50 focus-within:bg-slate-50 ${COLUMNS}`}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500"
                    >
                      <Icon name="folder" className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium text-slate-900">
                        {/* The link covers the whole row (::after), so any click opens the project. */}
                        <Link
                          to={`/workspaces/${workspaceId}/projects/${project.id}`}
                          className="after:absolute after:inset-0 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                        >
                          {project.name}
                        </Link>
                      </h3>
                      {project.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs break-words text-slate-500">
                          {project.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 pl-11 md:contents">
                    <div>
                      <ProjectStatusBadge status={project.status} />
                    </div>
                    <div className="text-xs text-slate-500">
                      <span className="sr-only">Created </span>
                      <time dateTime={project.createdAt}>
                        {dt.format(project.createdAt, 'date')}
                      </time>
                      {project.updatedAt !== project.createdAt && (
                        <span className="block text-slate-400">
                          Updated{' '}
                          <time dateTime={project.updatedAt}>
                            {dt.format(project.updatedAt, 'date')}
                          </time>
                        </span>
                      )}
                    </div>
                    <span
                      aria-hidden="true"
                      className="ml-auto text-slate-400 md:ml-0 md:text-right"
                    >
                      <Icon name="chevronRight" className="inline size-4" />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <p role="status" className="sr-only">
            Showing {state.items.length} project{state.items.length === 1 ? '' : 's'}
          </p>

          {state.loadMoreError && (
            <p role="alert" className="mt-3 text-sm text-rose-700">
              {state.loadMoreError}
            </p>
          )}

          {state.nextCursor && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={state.loadingMore}
                className={buttonClass('secondary', 'sm')}
              >
                {state.loadingMore ? 'Loading…' : 'Load more projects'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );

  // Owners: the list with the create form beside it (below it on small screens).
  return canCreate ? (
    <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      {list}
      <div className="lg:sticky lg:top-20 [&>section]:mt-0">
        <CreateProjectForm workspaceId={workspaceId} onCreated={prepend} />
      </div>
    </div>
  ) : (
    <div className="mt-5">{list}</div>
  );
}

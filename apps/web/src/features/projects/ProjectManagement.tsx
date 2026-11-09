import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { archiveProject, deleteProject, restoreProject, type Project } from './projects.api';
import { buttonClass } from '../../components/ui/styles';

type Action = 'archive' | 'restore' | 'delete';

const secondaryButton = buttonClass('secondary');
const primaryButton = buttonClass('primary');
const dangerButton = buttonClass('danger');

function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (error.status) {
    case 403:
      return 'Only workspace owners can manage projects. If your role just changed, refresh the page.';
    case 404:
      return 'This project no longer exists.';
    case 409:
      // API wording, e.g. "This project still has tasks, so it cannot be deleted. …"
      return error.message;
    case 0:
    case 503:
      return 'Trackify is temporarily unavailable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * Owner-only lifecycle controls (the API enforces the role independently):
 * Edit and Archive for active projects, Restore for archived ones, and a
 * separate danger zone for permanent deletion that requires typing the name.
 * One request at a time; on failure the page keeps its state and shows a
 * safe message.
 */
export function ProjectManagement({
  workspaceId,
  project,
  onEdit,
  onChanged,
  onDeleted,
}: {
  workspaceId: string;
  project: Project;
  /** Shows an Edit project button here when given (the project page puts it in its header). */
  onEdit?: (() => void) | undefined;
  onChanged: (project: Project, message: string) => void;
  onDeleted: () => void;
}) {
  const { invalidateSession } = useAuth();
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [typedName, setTypedName] = useState('');
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteInputRef = useRef<HTMLInputElement>(null);
  const deleteInputId = useId();

  // Safer default focus when a confirmation opens.
  useEffect(() => {
    if (confirming === 'delete') deleteInputRef.current?.focus();
    else if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const open = (action: Action) => {
    setError(undefined);
    setTypedName('');
    setConfirming(action);
  };

  async function run(action: Action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (action === 'delete') {
        await deleteProject(workspaceId, project.id);
        onDeleted();
        return;
      }
      const result =
        action === 'archive'
          ? await archiveProject(workspaceId, project.id)
          : await restoreProject(workspaceId, project.id);
      setConfirming(null);
      onChanged(
        result.project,
        action === 'archive'
          ? 'Project archived. It is now read-only; you can restore it at any time.'
          : 'Project restored. It is active and can be edited again.',
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      setError(describeError(err));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const archived = project.status === 'ARCHIVED';
  const nameMatches = typedName.trim() === project.name;

  return (
    <section aria-label="Manage project" className="mt-6 space-y-4">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      )}

      {!confirming && (
        <div className="flex flex-wrap gap-2">
          {!archived && (
            <>
              {onEdit && (
                <button type="button" onClick={onEdit} disabled={pending} className={primaryButton}>
                  Edit project
                </button>
              )}
              <button
                type="button"
                onClick={() => open('archive')}
                disabled={pending}
                className={secondaryButton}
              >
                Archive
              </button>
            </>
          )}
          {archived && (
            <button
              type="button"
              onClick={() => open('restore')}
              disabled={pending}
              className={primaryButton}
            >
              Restore
            </button>
          )}
        </div>
      )}

      {(confirming === 'archive' || confirming === 'restore') && (
        <div
          role="group"
          aria-label={confirming === 'archive' ? 'Confirm archiving' : 'Confirm restoring'}
          className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
        >
          <p>
            {confirming === 'archive' ? (
              <>
                Archive <strong>{project.name}</strong>? It stays visible to the workspace but
                becomes read-only. Archiving is reversible: you can restore it at any time.
              </>
            ) : (
              <>
                Restore <strong>{project.name}</strong>? It becomes active and editable again.
              </>
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void run(confirming)}
              disabled={pending}
              className={primaryButton}
            >
              {pending
                ? confirming === 'archive'
                  ? 'Archiving…'
                  : 'Restoring…'
                : confirming === 'archive'
                  ? 'Archive project'
                  : 'Restore project'}
            </button>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => setConfirming(null)}
              disabled={pending}
              className={secondaryButton}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-rose-200 p-4">
        <h2 className="text-sm font-semibold text-rose-800">Danger zone</h2>
        {confirming !== 'delete' ? (
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600">
              Permanently delete this project. This cannot be undone.
            </p>
            <button
              type="button"
              onClick={() => open('delete')}
              disabled={pending || confirming !== null}
              className="shrink-0 rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Delete permanently
            </button>
          </div>
        ) : (
          <form
            aria-label="Confirm permanent deletion"
            onSubmit={(event) => {
              event.preventDefault();
              if (nameMatches) void run('delete');
            }}
            className="mt-2 space-y-3 text-sm text-rose-900"
          >
            <p>
              <strong>This permanently deletes {project.name}.</strong> It cannot be undone and the
              project cannot be restored. To keep the project but make it read-only, archive it
              instead.
            </p>
            <div>
              <label htmlFor={deleteInputId} className="block font-medium">
                Type the project name to confirm
              </label>
              <input
                ref={deleteInputRef}
                id={deleteInputId}
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                readOnly={pending}
                autoComplete="off"
                className="mt-1 block w-full rounded-md border border-rose-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-rose-500 focus:ring-2 focus:ring-rose-200 focus:outline-none"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={pending || !nameMatches} className={dangerButton}>
                {pending ? 'Deleting…' : 'Delete this project permanently'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={pending}
                className={secondaryButton}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

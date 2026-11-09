import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { deleteWorkspace } from './workspaces.api';
import { buttonClass } from '../../components/ui/styles';

const dangerButton = buttonClass('danger');
const secondaryButton = buttonClass('secondary');

/**
 * Owner-only permanent deletion. Requires typing the workspace's exact name
 * before the button enables; on success, goes to the workspace list. (UX
 * only: the API independently refuses anyone who isn't an owner.)
 */
export function DeleteWorkspace({ workspaceId, name }: { workspaceId: string; name: string }) {
  const { invalidateSession } = useAuth();
  const navigate = useNavigate();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (confirming) input.current?.focus();
  }, [confirming]);

  const matches = typed.trim() === name;

  async function confirm() {
    if (!matches || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await deleteWorkspace(workspaceId);
      navigate('/workspaces', { replace: true, state: { deletedWorkspace: name } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Only owners can delete this workspace.'
          : err instanceof ApiError && err.status === 404
            ? 'This workspace no longer exists.'
            : 'We couldn’t delete the workspace. Please try again.',
      );
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="danger-heading"
      className="mt-6 rounded-lg border border-rose-200 bg-white p-5 shadow-panel"
    >
      <h2 id="danger-heading" className="text-base font-semibold text-rose-800">
        Delete workspace
      </h2>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      )}
      {!confirming ? (
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-600">
            Permanently delete this workspace with all its projects, tasks, comments, history,
            invitations and notifications. This cannot be undone.
          </p>
          <button
            type="button"
            onClick={() => {
              setTyped('');
              setConfirming(true);
            }}
            className="shrink-0 rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
          >
            Delete workspace
          </button>
        </div>
      ) : (
        <form
          role="alertdialog"
          aria-labelledby="danger-confirm-title"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
          className="mt-3 space-y-3 text-sm text-rose-900"
        >
          <p id="danger-confirm-title">
            <strong>This permanently deletes {name}</strong> for every member: all projects, tasks,
            comments, activity history, pending invitations and notifications in it. Members keep
            their accounts and other workspaces. It cannot be undone.
          </p>
          <div>
            <label htmlFor={inputId} className="block font-medium">
              Type the workspace name to confirm
            </label>
            <input
              ref={input}
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              readOnly={pending}
              autoComplete="off"
              className="mt-1 block w-full rounded-md border border-rose-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-rose-500 focus:ring-2 focus:ring-rose-200 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending || !matches} className={dangerButton}>
              {pending ? 'Deleting…' : 'Delete this workspace permanently'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className={secondaryButton}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { usePaginatedList } from '../../lib/usePaginatedList';
import { useAuth } from '../auth/auth-context';
import { RoleBadge } from './RoleBadge';
import {
  changeMemberRole,
  listMembers,
  removeMember,
  type WorkspaceMember,
  type WorkspaceRole,
} from './workspaces.api';
import { useDateTime } from '../account/preferences-context';
import { buttonClass } from '../../components/ui/styles';

const secondaryButton = buttonClass('secondary');
const smallButton =
  'rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

const getKey = (member: WorkspaceMember) => member.userId;

type Action = 'remove' | 'promote' | 'demote';

function describeError(error: unknown, action: Action): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (error.status) {
    case 403:
      return action === 'remove'
        ? 'Only workspace owners can remove members.'
        : 'Only workspace owners can change roles. If your role just changed, refresh the page.';
    case 404:
      return 'This person is no longer a member of the workspace. Refresh the page to update the list.';
    case 409:
      // API wording, e.g. "A workspace must have at least one owner."
      return error.message;
    case 0:
    case 503:
      return 'Trackify is temporarily unavailable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

type Notice = { tone: 'success' | 'error'; text: string };

/**
 * Paginated member list of one workspace (oldest member first). Owners can
 * change other people's roles (OWNER ↔ MEMBER) and remove regular members;
 * nobody gets controls on their own row. The API enforces every rule —
 * including "at least one owner" — independently.
 */
export function WorkspaceMembers({
  workspaceId,
  workspaceName,
  currentUserId,
  canManageMembers,
}: {
  workspaceId: string;
  workspaceName: string;
  currentUserId: string;
  /** True for owners. UX only: the API independently refuses everyone else. */
  canManageMembers: boolean;
}) {
  const dt = useDateTime();
  const { invalidateSession } = useAuth();
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal?: AbortSignal) => {
      const page = await listMembers(workspaceId, { cursor }, signal);
      return { items: page.members, nextCursor: page.nextCursor };
    },
    [workspaceId],
  );
  const { state, retry, loadMore, remove, update } = usePaginatedList({
    fetchPage,
    getKey,
    errorMessage: 'We couldn’t load the members of this workspace. Please try again.',
  });

  const [confirming, setConfirming] = useState<{ userId: string; action: Action } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Safer default: focus "Cancel" when a confirmation opens.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  // Never on your own row: no accidental self-demotion or self-removal from here.
  const manageable = (member: WorkspaceMember) =>
    canManageMembers && member.userId !== currentUserId;

  async function confirm(member: WorkspaceMember, action: Action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(member.userId);
    setNotice(undefined);
    try {
      if (action === 'remove') {
        await removeMember(workspaceId, member.userId);
        remove(member.userId);
        setNotice({ tone: 'success', text: `${member.email} was removed from ${workspaceName}.` });
      } else {
        const role: WorkspaceRole = action === 'promote' ? 'OWNER' : 'MEMBER';
        const result = await changeMemberRole(workspaceId, member.userId, role);
        update(member.userId, (m) => ({ ...m, role: result.member.role }));
        const label = result.member.role === 'OWNER' ? 'an owner' : 'a member';
        setNotice({
          tone: 'success',
          text: result.changed
            ? `${member.email} is now ${label} of ${workspaceName}.`
            : `${member.email} is already ${label}.`,
        });
      }
      setConfirming(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        invalidateSession(); // session ended: the route guard sends the user to sign in
        return;
      }
      setConfirming(null);
      setNotice({ tone: 'error', text: describeError(error, action) }); // list unchanged
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function confirmation(member: WorkspaceMember, action: Action) {
    const busy = pending !== null;
    const copy = {
      remove: {
        label: `Confirm removing ${member.email}`,
        confirm: 'Remove member',
        busy: 'Removing…',
        body: (
          <>
            Remove <strong>{member.email}</strong> from <strong>{workspaceName}</strong>? They will
            lose access to this workspace. Their account is not affected.
          </>
        ),
      },
      promote: {
        label: `Confirm role change for ${member.email}`,
        confirm: 'Make owner',
        busy: 'Saving…',
        body: (
          <>
            Make <strong>{member.email}</strong> an owner of <strong>{workspaceName}</strong>?
            Owners can invite and remove members and change anyone’s role, including yours.
          </>
        ),
      },
      demote: {
        label: `Confirm role change for ${member.email}`,
        confirm: 'Make member',
        busy: 'Saving…',
        body: (
          <>
            Make <strong>{member.email}</strong> a regular member of{' '}
            <strong>{workspaceName}</strong>? They will lose owner permissions. A workspace must
            always keep at least one owner.
          </>
        ),
      },
    }[action];
    const danger = action !== 'promote';

    return (
      <div
        role="group"
        aria-label={copy.label}
        className={`mt-3 rounded-md border p-3 text-sm ${
          danger
            ? 'border-rose-200 bg-rose-50 text-rose-900'
            : 'border-brand-100 bg-brand-50 text-slate-900'
        }`}
      >
        <p>{copy.body}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void confirm(member, action)}
            disabled={busy}
            className={`${smallButton} text-white ${
              danger
                ? 'bg-rose-600 hover:bg-rose-700 focus-visible:outline-rose-600'
                : 'bg-brand-600 hover:bg-brand-700 focus-visible:outline-brand-600'
            }`}
          >
            {pending === member.userId ? copy.busy : copy.confirm}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={() => setConfirming(null)}
            disabled={busy}
            className={`${smallButton} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:outline-brand-600`}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const open = (member: WorkspaceMember, action: Action) => {
    setNotice(undefined);
    setConfirming({ userId: member.userId, action });
  };

  return (
    <section aria-labelledby="members-heading" className="mt-8">
      <h2 id="members-heading" className="text-base font-semibold">
        Members
      </h2>
      {canManageMembers && (
        <p className="mt-1 text-sm text-slate-600">
          As an owner you can change roles and remove members. A workspace must always keep at least
          one owner.
        </p>
      )}

      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            notice.tone === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {notice.text}
        </p>
      )}

      {state.status === 'loading' && (
        <p role="status" className="mt-4 text-sm text-slate-500">
          Loading members…
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
        <p className="mt-4 text-sm text-slate-600">No members to show.</p>
      )}

      {state.status === 'ready' && state.items.length > 0 && (
        <>
          <ul
            aria-labelledby="members-heading"
            className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-panel"
          >
            {state.items.map((member) => {
              const isConfirming = confirming?.userId === member.userId;
              return (
                <li key={member.userId} className="px-5 py-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">
                        {member.name ?? member.email}
                        {member.userId === currentUserId && (
                          <span className="ml-2 text-sm font-normal text-slate-500">(you)</span>
                        )}
                      </p>
                      {member.name && (
                        <p className="truncate text-sm text-slate-600">{member.email}</p>
                      )}
                      <p className="text-sm text-slate-500">
                        Joined{' '}
                        <time dateTime={member.joinedAt}>{dt.format(member.joinedAt, 'date')}</time>
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <RoleBadge role={member.role} />
                      {manageable(member) && !isConfirming && (
                        <>
                          {member.role === 'MEMBER' ? (
                            <button
                              type="button"
                              onClick={() => open(member, 'promote')}
                              disabled={pending !== null}
                              aria-label={`Make ${member.email} an owner`}
                              className={`${smallButton} text-brand-700 hover:bg-brand-50 focus-visible:outline-brand-600`}
                            >
                              Make owner
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => open(member, 'demote')}
                              disabled={pending !== null}
                              aria-label={`Make ${member.email} a member`}
                              className={`${smallButton} text-slate-700 hover:bg-slate-100 focus-visible:outline-brand-600`}
                            >
                              Make member
                            </button>
                          )}
                          {member.role === 'MEMBER' && (
                            <button
                              type="button"
                              onClick={() => open(member, 'remove')}
                              disabled={pending !== null}
                              aria-label={`Remove ${member.email}`}
                              className={`${smallButton} text-rose-700 hover:bg-rose-50 focus-visible:outline-rose-600`}
                            >
                              Remove
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {manageable(member) && isConfirming && confirmation(member, confirming.action)}
                </li>
              );
            })}
          </ul>

          <p role="status" className="sr-only">
            Showing {state.items.length} member{state.items.length === 1 ? '' : 's'}
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
                {state.loadingMore ? 'Loading…' : 'Load more members'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

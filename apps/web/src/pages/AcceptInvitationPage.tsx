import { useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { FormAlert } from '../components/form/FormAlert';
import { useAuth } from '../features/auth/auth-context';
import { acceptInvitation, declineInvitation } from '../features/invitations/invitations.api';
import { ApiError } from '../lib/api-client';
import { buttonClass } from '../components/ui/styles';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The token arrives in the URL fragment (`#token=…`), which browsers never send to servers. */
function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (error.status) {
    case 403:
      return 'This invitation was sent to a different email address. Sign out and sign in with the invited account to accept it.';
    case 404:
    case 400:
      return 'This invitation link is invalid.';
    case 409:
    case 410:
      return error.message; // "no longer valid" / "expired" / "already a member" (API wording)
    case 0:
    case 503:
      return 'Trackify is temporarily unavailable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

const primaryButton = buttonClass('primary');
const secondaryButton = buttonClass('secondary');

/** /invitations/accept#token=… (only reachable through <RequireAuth>). */
export function AcceptInvitationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { invalidateSession } = useAuth();
  // Derived on every render: follows the current link even if the page stays mounted.
  const token = tokenFromHash(location.hash);
  const [pending, setPending] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string>();
  const [declined, setDeclined] = useState(false);
  const inFlight = useRef(false);

  async function respond(action: 'accept' | 'decline') {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setPending(action);
    setError(undefined);
    try {
      if (action === 'accept') {
        const { workspace } = await acceptInvitation(token);
        // Replace: the token-bearing URL should not stay in history.
        navigate(`/workspaces/${workspace.id}`, { replace: true });
        return;
      }
      await declineInvitation(token);
      setDeclined(true);
      navigate(location.pathname, { replace: true }); // drop the token from the address bar
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession(); // back to sign-in, then here again (the link is preserved)
        return;
      }
      setError(describe(err));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  if (declined) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Invitation declined</h1>
        <p className="mt-2 text-slate-600">You won’t be added to the workspace.</p>
        <Link to="/workspaces" className="mt-6 inline-block text-sm font-medium text-brand-600">
          Go to your workspaces
        </Link>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Invalid invitation link</h1>
        <p className="mt-2 text-slate-600">
          This link is incomplete or malformed. Ask the workspace owner for a new invitation.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-12">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-panel sm:p-8">
        <h1 className="text-2xl font-bold tracking-tight">Workspace invitation</h1>
        <p className="mt-2 text-slate-600">
          You’ve been invited to join a Trackify workspace as a member.
        </p>
        {error && (
          <div className="mt-4">
            <FormAlert>{error}</FormAlert>
          </div>
        )}
        <div className="mt-6 flex flex-wrap gap-3" aria-busy={pending !== null}>
          <button
            type="button"
            className={primaryButton}
            disabled={pending !== null}
            onClick={() => void respond('accept')}
          >
            {pending === 'accept' ? 'Accepting…' : 'Accept invitation'}
          </button>
          <button
            type="button"
            className={secondaryButton}
            disabled={pending !== null}
            onClick={() => void respond('decline')}
          >
            {pending === 'decline' ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
    </div>
  );
}

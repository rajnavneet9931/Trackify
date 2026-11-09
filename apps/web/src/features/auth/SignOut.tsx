import { useAuth } from './auth-context';

/**
 * Starts logout (POST + CSRF via the API client). Local state is cleared only
 * once the server confirmed it (200) or the session was already gone (401);
 * protected pages then redirect to /login. The button cannot navigate itself:
 * it unmounts as soon as the session is cleared.
 */
export function SignOutButton({ className }: { className?: string }) {
  const { signOut, logoutState } = useAuth();
  const pending = logoutState.status === 'pending';

  return (
    <button
      type="button"
      onClick={() => {
        if (!pending) void signOut();
      }}
      disabled={pending}
      className={className}
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

/** Explains a logout that could not be confirmed (403, 503, network) and offers a retry. */
export function LogoutFailureBanner() {
  const { logoutState, signOut, dismissLogoutError } = useAuth();
  if (logoutState.status !== 'failed') return null;

  return (
    <div role="alert" className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-amber-900">
        <p>{logoutState.message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
          >
            Try signing out again
          </button>
          <button
            type="button"
            onClick={dismissLogoutError}
            className="rounded-md px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-100"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

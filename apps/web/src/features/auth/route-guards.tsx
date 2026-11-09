import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from './auth-context';
import { postLoginPath, type LoginLocationState } from './redirect';

function SessionCheck() {
  return (
    <p role="status" className="py-16 text-center text-sm text-slate-500">
      Checking your session…
    </p>
  );
}

function SessionUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">Can’t verify your session</h1>
      <p className="mt-2 text-slate-600">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Renders child routes only for an authenticated session. This is a UX
 * convenience: the API enforces authentication on every request regardless.
 */
export function RequireAuth() {
  const { session, retrySession } = useAuth();
  const location = useLocation();

  switch (session.status) {
    case 'loading':
      return <SessionCheck />;
    case 'unavailable':
      // Not a sign-out: keep the user here and let them retry.
      return <SessionUnavailable message={session.message} onRetry={retrySession} />;
    case 'unauthenticated': {
      // After an explicit sign-out, don't send the user back here on next sign-in.
      const state: LoginLocationState = session.reason
        ? { notice: session.reason }
        : { from: { pathname: location.pathname, search: location.search, hash: location.hash } };
      return <Navigate to="/login" replace state={state} />;
    }
    case 'authenticated':
      return <Outlet />;
  }
}

/** Login/registration pages: send already signed-in users on to where they were going. */
export function GuestOnly() {
  const { session } = useAuth();
  const location = useLocation();

  if (session.status === 'loading') return <SessionCheck />;
  if (session.status === 'authenticated') {
    return <Navigate to={postLoginPath(location.state)} replace />;
  }
  return <Outlet />;
}

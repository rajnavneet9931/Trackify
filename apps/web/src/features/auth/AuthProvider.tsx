import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ApiError, setCsrfToken } from '../../lib/api-client';
import * as authApi from './auth.api';
import {
  AuthContext,
  type AuthContextValue,
  type LogoutState,
  type SessionState,
  type SignedOutReason,
} from './auth-context';

const RESTORE_UNAVAILABLE =
  'We couldn’t verify your session because Trackify is temporarily unreachable.';

function logoutFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'Sign-out was blocked by a security check. Please try again.';
  }
  return 'We couldn’t reach Trackify to sign you out. You are still signed in. Please try again.';
}

/**
 * Single source of truth for authentication in the SPA. Holds only the safe
 * user fields in React state and the CSRF token in API-client memory; the
 * session itself lives in the browser-managed HttpOnly cookie.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [logoutState, setLogoutState] = useState<LogoutState>({ status: 'idle' });

  /** Shared in-flight restore, so concurrent callers (and StrictMode) issue one /me request. */
  const restoreInFlight = useRef<Promise<void> | null>(null);
  /** Bumped by sign-in/sign-out so a slower, older /me response cannot overwrite newer state. */
  const epoch = useRef(0);

  /** Definitive signed-out state: no session, so no pending logout problem either. */
  const applySignedOut = useCallback((reason?: SignedOutReason) => {
    setCsrfToken(null);
    setSession(reason ? { status: 'unauthenticated', reason } : { status: 'unauthenticated' });
    setLogoutState({ status: 'idle' });
  }, []);

  /** GET /auth/me. Only updates state asynchronously, from the response. */
  const runRestore = useCallback(
    ({ reportUnavailable = true }: { reportUnavailable?: boolean } = {}): Promise<void> => {
      if (restoreInFlight.current) return restoreInFlight.current;

      const startedAt = epoch.current;
      const request = authApi
        .fetchSession()
        .then(({ user, csrfToken }) => {
          if (epoch.current !== startedAt) return;
          setCsrfToken(csrfToken);
          setSession({ status: 'authenticated', user });
        })
        .catch((error: unknown) => {
          if (epoch.current !== startedAt) return;
          if (error instanceof ApiError && error.status === 401) {
            applySignedOut();
          } else if (reportUnavailable) {
            // Network failure, timeout, 503…: unknown, not "signed out".
            setSession({ status: 'unavailable', message: RESTORE_UNAVAILABLE });
          }
        })
        .finally(() => {
          restoreInFlight.current = null;
        });

      restoreInFlight.current = request;
      return request;
    },
    [applySignedOut],
  );

  // Initial state is already 'loading'.
  useEffect(() => {
    void runRestore();
  }, [runRestore]);

  const retrySession = useCallback(() => {
    if (restoreInFlight.current) return;
    setSession({ status: 'loading' });
    void runRestore();
  }, [runRestore]);

  const invalidateSession = useCallback(
    (reason?: 'password-changed') => {
      epoch.current++;
      applySignedOut(reason);
    },
    [applySignedOut],
  );

  const signIn = useCallback(async (credentials: authApi.Credentials) => {
    const { user, csrfToken } = await authApi.login(credentials);
    epoch.current++;
    setCsrfToken(csrfToken);
    setLogoutState({ status: 'idle' });
    setSession({ status: 'authenticated', user });
    return user;
  }, []);

  const signOut = useCallback(async () => {
    setLogoutState({ status: 'pending' });
    try {
      await authApi.logout();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setLogoutState({ status: 'failed', message: logoutFailureMessage(error) });
        // A 403 usually means a stale CSRF token (e.g. another tab signed in
        // again); refresh it so the retry can succeed.
        if (error instanceof ApiError && error.status === 403) {
          void runRestore({ reportUnavailable: false });
        }
        return false;
      }
      // 401: the session had already expired or been revoked, so we are signed out.
    }
    epoch.current++;
    applySignedOut('signed-out');
    return true;
  }, [applySignedOut, runRestore]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      logoutState,
      signIn,
      signOut,
      retrySession,
      invalidateSession,
      dismissLogoutError: () => setLogoutState({ status: 'idle' }),
    }),
    [session, logoutState, signIn, signOut, retrySession, invalidateSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

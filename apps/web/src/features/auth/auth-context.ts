import { createContext, useContext } from 'react';

import type { AuthUser, Credentials } from './auth.api';

/**
 * - `loading`: restoring the session via GET /auth/me.
 * - `unavailable`: the restore failed for a reason other than 401 (network, 503…).
 *   The user may well still be signed in, so this is not treated as signed out.
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; user: AuthUser }
  /**
   * reason 'signed-out': the user just signed out here (vs. never signed in / expired);
   * 'password-changed': they changed their password, which ended every session.
   */
  | { status: 'unauthenticated'; reason?: SignedOutReason }
  | { status: 'unavailable'; message: string };

export type SignedOutReason = 'signed-out' | 'password-changed';

export type LogoutState =
  { status: 'idle' } | { status: 'pending' } | { status: 'failed'; message: string };

export interface AuthContextValue {
  session: SessionState;
  logoutState: LogoutState;
  /** Resolves with the user, or rejects with the ApiError for the form to display. */
  signIn: (credentials: Credentials) => Promise<AuthUser>;
  /**
   * Resolves true once signed out (200 or 401); false if logout could not be confirmed.
   * Protected pages then redirect to /login with a "signed out" notice.
   */
  signOut: () => Promise<boolean>;
  /**
   * Call when any API request answers 401: the session expired or was revoked.
   * Protected pages then redirect to /login and return here after sign-in.
   */
  invalidateSession: (reason?: 'password-changed') => void;
  /** Re-runs session restoration (e.g. after an `unavailable` result). */
  retrySession: () => void;
  dismissLogoutError: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

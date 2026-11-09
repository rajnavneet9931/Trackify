import type { Location } from 'react-router';

export const DEFAULT_SIGNED_IN_PATH = '/account';

/** Navigation state passed to /login by the route guard and other pages. */
export interface LoginLocationState {
  from?: Pick<Location, 'pathname' | 'search' | 'hash'>;
  notice?: 'registered' | 'signed-out' | 'password-changed';
  email?: string;
}

/**
 * Where to go after signing in. Only same-app paths are allowed, so a crafted
 * link cannot turn the login page into an open redirect.
 */
export function postLoginPath(state: unknown): string {
  const from = (state as LoginLocationState | null)?.from;
  if (!from || typeof from.pathname !== 'string') return DEFAULT_SIGNED_IN_PATH;

  const path = `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`;
  const isInternal = path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
  if (!isInternal || from.pathname === '/login' || from.pathname === '/register') {
    return DEFAULT_SIGNED_IN_PATH;
  }
  return path;
}

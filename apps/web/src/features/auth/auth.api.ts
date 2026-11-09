import { apiRequest } from '../../lib/api-client';

/** Safe public user fields returned by the API. */
export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
}

/** Returned by login and /me. The session token itself stays in the HttpOnly cookie. */
export interface SessionInfo {
  user: AuthUser;
  csrfToken: string;
  expiresAt: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export function registerAccount(credentials: Credentials): Promise<{ user: AuthUser }> {
  return apiRequest('/auth/register', { method: 'POST', body: credentials });
}

export function login(credentials: Credentials): Promise<SessionInfo> {
  return apiRequest('/auth/login', { method: 'POST', body: credentials });
}

export function fetchSession(): Promise<SessionInfo> {
  return apiRequest('/auth/me');
}

/** POST only; the API client attaches the in-memory CSRF token. */
export function logout(): Promise<{ loggedOut: true }> {
  return apiRequest('/auth/logout', { method: 'POST' });
}

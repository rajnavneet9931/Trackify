import { parseCookie } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';

import type { SessionConfig } from '../../config/env.js';

type CookieConfig = SessionConfig['cookie'];

function baseOptions(cookie: CookieConfig): CookieOptions {
  // Host-only (no Domain attribute): never shared with sibling subdomains.
  return { httpOnly: true, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path };
}

export function readSessionCookie(req: Request, cookie: CookieConfig): string | undefined {
  const header = req.headers.cookie;
  return header ? parseCookie(header)[cookie.name] : undefined;
}

export function setSessionCookie(
  res: Response,
  cookie: CookieConfig,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(cookie.name, token, {
    ...baseOptions(cookie),
    // Express emits both Max-Age and Expires, matching the server-side expiry.
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
}

export function clearSessionCookie(res: Response, cookie: CookieConfig): void {
  res.clearCookie(cookie.name, baseOptions(cookie));
}

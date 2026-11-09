import { z } from 'zod';

import { emailSchema } from '../users/index.js';

const uuid = (field: string) =>
  z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: `${field} must be a valid UUID` }));

/**
 * `POST /workspaces/:workspaceId/invitations`. Only the invitee's email is
 * accepted: inviter, role, status, token and expiry are always decided by the
 * server, so any such field is rejected.
 */
export const createInvitationBodySchema = z.strictObject({ email: emailSchema });

export const workspaceInvitationsParamsSchema = z.strictObject({
  workspaceId: uuid('workspaceId'),
});

export const invitationParamsSchema = z.strictObject({
  workspaceId: uuid('workspaceId'),
  invitationId: uuid('invitationId'),
});

/**
 * Accept/decline body. The token travels in the body (never the URL), so it
 * does not end up in access logs, browser history or Referer headers.
 */
export const invitationTokenBodySchema = z.strictObject({
  token: z
    .string({ error: 'token is required' })
    .regex(/^[A-Za-z0-9_-]{43}$/, { error: 'Invalid invitation token' }),
});

export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;
export type WorkspaceInvitationsParams = z.infer<typeof workspaceInvitationsParamsSchema>;
export type InvitationParams = z.infer<typeof invitationParamsSchema>;
export type InvitationTokenBody = z.infer<typeof invitationTokenBodySchema>;

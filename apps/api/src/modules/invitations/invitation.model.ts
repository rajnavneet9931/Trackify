import { InvitationStatus } from '../../generated/prisma/enums.js';

export { InvitationStatus };

/** What the API returns about an invitation. Never includes the token or its hash. */
export interface InvitationView {
  id: string;
  workspaceId: string;
  email: string;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
}

export const invitationViewSelect = {
  id: true,
  workspaceId: true,
  email: true,
  status: true,
  expiresAt: true,
  createdAt: true,
} as const;

/**
 * Status as callers should see it: a PENDING invitation past its expiry is
 * EXPIRED even before the row has been updated (expiry is applied lazily).
 */
export function effectiveStatus(
  invitation: Pick<InvitationView, 'status' | 'expiresAt'>,
  now: Date,
): InvitationStatus {
  return invitation.status === InvitationStatus.PENDING && invitation.expiresAt <= now
    ? InvitationStatus.EXPIRED
    : invitation.status;
}

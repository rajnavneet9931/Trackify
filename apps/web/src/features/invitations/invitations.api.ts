import { apiRequest } from '../../lib/api-client';
import type { WorkspaceRole } from '../workspaces/workspaces.api';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'REVOKED';

export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedInvitation {
  invitation: Invitation;
  delivery: {
    /** Always false for now: no email provider is configured. */
    emailSent: boolean;
    /** Development only: `/invitations/accept#token=…`. Absent in production. */
    devAcceptPath?: string;
  };
}

/** POST (owner only); the API client attaches the CSRF token. */
export function createInvitation(workspaceId: string, email: string): Promise<CreatedInvitation> {
  return apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/invitations`, {
    method: 'POST',
    body: { email },
  });
}

/** The token is sent in the request body, never in a URL. */
export function acceptInvitation(token: string): Promise<{
  workspace: { id: string; name: string; createdAt: string };
  membership: { role: WorkspaceRole };
}> {
  return apiRequest('/invitations/accept', { method: 'POST', body: { token } });
}

export function declineInvitation(token: string): Promise<{ declined: true }> {
  return apiRequest('/invitations/decline', { method: 'POST', body: { token } });
}

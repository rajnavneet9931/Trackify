import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import { getAuth } from '../sessions/index.js';
import type { InvitationView } from './invitation.model.js';
import type { InvitationService } from './invitation.service.js';
import type {
  CreateInvitationBody,
  InvitationParams,
  InvitationTokenBody,
  WorkspaceInvitationsParams,
} from './invitation.validators.js';

/** Response shape for an invitation. Built field by field: no token, no hash, no inviter. */
function toInvitationResponse(invitation: InvitationView) {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
  };
}

export class InvitationController {
  constructor(
    private readonly service: InvitationService,
    /** Development only (config.invitations.exposeDevLinks); false in production. */
    private readonly exposeDevLinks: boolean,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceInvitationsParams;
    const { email } = req.body as CreateInvitationBody;
    const { invitation, token } = await this.service.create(
      workspaceId,
      getAuth(req).user.id,
      email,
    );

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(
      res,
      {
        invitation: toInvitationResponse(invitation),
        // No email provider is configured: say so explicitly, never imply delivery.
        delivery: {
          emailSent: false,
          // The token goes in the URL fragment, which browsers never send to servers.
          ...(this.exposeDevLinks && { devAcceptPath: `/invitations/accept#token=${token}` }),
        },
      },
      201,
    );
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, invitationId } = req.params as InvitationParams;
    const invitation = await this.service.get(workspaceId, invitationId, getAuth(req).user.id);

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { invitation: toInvitationResponse(invitation) });
  };

  revoke = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, invitationId } = req.params as InvitationParams;
    const invitation = await this.service.revoke(workspaceId, invitationId, getAuth(req).user.id);
    sendSuccess(res, { invitation: toInvitationResponse(invitation) });
  };

  accept = async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body as InvitationTokenBody;
    const { user } = getAuth(req);
    const { workspace, role } = await this.service.accept(token, {
      id: user.id,
      email: user.email,
    });

    sendSuccess(res, {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt.toISOString(),
      },
      membership: { role },
    });
  };

  decline = async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body as InvitationTokenBody;
    const { user } = getAuth(req);
    await this.service.decline(token, { id: user.id, email: user.email });
    sendSuccess(res, { declined: true });
  };
}

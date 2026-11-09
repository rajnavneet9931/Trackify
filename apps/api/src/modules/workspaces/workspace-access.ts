import { ForbiddenError, NotFoundError } from '../../core/errors/app-error.js';
import { WorkspaceRole, type Membership } from './workspace.model.js';
import type { WorkspaceRepository } from './workspace.repository.js';

/** Roles allowed for an action. Default: any member. */
export type RequiredRoles = readonly WorkspaceRole[];

const ANY_MEMBER: RequiredRoles = [WorkspaceRole.OWNER, WorkspaceRole.MEMBER];

/**
 * Authorization for workspace-scoped operations, for future endpoints such as
 * GET/PATCH /workspaces/:id. Deny by default:
 * - no membership (or an unknown workspace) → 404, so callers cannot probe
 *   which workspace IDs exist;
 * - member with an insufficient role → 403.
 */
export class WorkspaceAccess {
  constructor(private readonly workspaces: Pick<WorkspaceRepository, 'findMembership'>) {}

  async requireMembership(
    workspaceId: string,
    userId: string,
    roles: RequiredRoles = ANY_MEMBER,
  ): Promise<Membership> {
    const membership = await this.workspaces.findMembership(workspaceId, userId);
    return authorizeMembership(membership, roles);
  }
}

/** Pure policy, separated for unit testing. */
export function authorizeMembership(
  membership: Membership | null,
  roles: RequiredRoles,
): Membership {
  if (!membership) throw new NotFoundError('Workspace not found');
  if (!roles.includes(membership.role)) {
    throw new ForbiddenError('You do not have permission to perform this action');
  }
  return membership;
}

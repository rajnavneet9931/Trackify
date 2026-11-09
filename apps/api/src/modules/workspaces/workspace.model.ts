import { WorkspaceRole } from '../../generated/prisma/enums.js';

export { WorkspaceRole };

export const WORKSPACE_NAME_MAX_LENGTH = 100;
export const WORKSPACE_DESCRIPTION_MAX_LENGTH = 2000;

/** Fields returned by the API for a workspace. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: Date;
}

/** The caller's relationship to a workspace. */
export interface Membership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export const workspaceSummarySelect = { id: true, name: true, createdAt: true } as const;

/** A workspace's settings, readable by every member and editable by owners. */
export interface WorkspaceSettings extends WorkspaceSummary {
  description: string | null;
  /** The optimistic-concurrency token for edits (`expectedUpdatedAt`). */
  updatedAt: Date;
}

export const workspaceSettingsSelect = {
  ...workspaceSummarySelect,
  description: true,
  updatedAt: true,
} as const;

export interface WorkspaceSettingsChanges {
  name?: string | undefined;
  /** null clears it. */
  description?: string | null | undefined;
}

/** A workspace as seen by one member: public fields plus that member's role. */
export interface WorkspaceListItem extends WorkspaceSummary {
  role: WorkspaceRole;
}

export const WORKSPACE_PAGE_SIZE_DEFAULT = 20;
export const WORKSPACE_PAGE_SIZE_MAX = 100;

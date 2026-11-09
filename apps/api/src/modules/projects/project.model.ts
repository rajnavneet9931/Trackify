import { ProjectStatus } from '../../generated/prisma/enums.js';

export { ProjectStatus };

export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2000;
export const PROJECT_PAGE_SIZE_DEFAULT = 20;
export const PROJECT_PAGE_SIZE_MAX = 50;

/** Fields returned by the API for a project. */
export interface ProjectView {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal creator info for the details view; null once they left the workspace. */
export interface ProjectCreator {
  id: string;
  email: string;
}

export interface ProjectDetail extends ProjectView {
  creator: ProjectCreator | null;
}

export const projectViewSelect = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  status: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

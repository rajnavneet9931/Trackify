import { z } from 'zod';

import {
  WORKSPACE_DESCRIPTION_MAX_LENGTH,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_PAGE_SIZE_DEFAULT,
  WORKSPACE_PAGE_SIZE_MAX,
} from './workspace.model.js';

// Control characters (tabs, newlines, NUL, …) have no place in a display name.
const CONTROL_CHARACTERS = /\p{Cc}/u;

const workspaceName = z
  .string({
    error: (issue) => (issue.input === undefined ? 'Name is required' : 'Name must be a string'),
  })
  .max(WORKSPACE_NAME_MAX_LENGTH * 4, { error: 'Name is too long' }) // cheap pre-check
  .transform((name) => name.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, { error: 'Name is required' })
      .max(WORKSPACE_NAME_MAX_LENGTH, {
        error: `Name must be at most ${WORKSPACE_NAME_MAX_LENGTH} characters`,
      })
      .refine((name) => !CONTROL_CHARACTERS.test(name), {
        error: 'Name must not contain control characters',
      }),
  );

/**
 * `POST /workspaces` body. Strict: ownership is derived from the session, so
 * fields such as `ownerId`, `userId` or `role` are rejected, not ignored.
 */
export const createWorkspaceBodySchema = z.strictObject({ name: workspaceName });

export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBodySchema>;

// Line breaks and tabs are fine in a description; other control characters are not.
const CONTROL_EXCEPT_WHITESPACE = /[^\P{Cc}\t\n\r]/u;

/** `null` or empty/whitespace-only mean "no description" (stored as NULL). */
const workspaceDescription = z
  .string({ error: 'Description must be a string' })
  .max(WORKSPACE_DESCRIPTION_MAX_LENGTH * 4, { error: 'Description is too long' })
  .transform((text) => text.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .max(WORKSPACE_DESCRIPTION_MAX_LENGTH, {
        error: `Description must be at most ${WORKSPACE_DESCRIPTION_MAX_LENGTH} characters`,
      })
      .refine((text) => !CONTROL_EXCEPT_WHITESPACE.test(text), {
        error: 'Description must not contain control characters',
      }),
  )
  .transform((text) => (text === '' ? null : text))
  .nullable();

/**
 * `PATCH /workspaces/:id/settings` (owners). Strict: only `name` and
 * `description`, at least one, plus `expectedUpdatedAt`, the `updatedAt` the
 * client last saw (409 if the settings changed since, so nobody silently
 * overwrites another owner's edit).
 */
export const updateSettingsBodySchema = z
  .strictObject({
    name: workspaceName.optional(),
    description: workspaceDescription.optional(),
    expectedUpdatedAt: z.iso
      .datetime({ error: 'expectedUpdatedAt must be an ISO 8601 UTC timestamp' })
      .transform((value) => new Date(value)),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    error: 'Provide a name or a description to update',
  });

export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;

/**
 * Cursor-pagination query shared by `GET /workspaces` and
 * `GET /workspaces/:id/members`. Strict like request bodies: unknown parameters
 * are rejected. Repeated parameters (`?limit=1&limit=2`) arrive as arrays and fail.
 */
export const pageQuerySchema = z.strictObject({
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be an integer' })
    .min(1, { error: 'limit must be at least 1' })
    .max(WORKSPACE_PAGE_SIZE_MAX, { error: `limit must be at most ${WORKSPACE_PAGE_SIZE_MAX}` })
    .default(WORKSPACE_PAGE_SIZE_DEFAULT),
  cursor: z.string({ error: 'cursor must be a string' }).min(1).max(200).optional(),
});

export const listWorkspacesQuerySchema = pageQuerySchema;
export const listMembersQuerySchema = pageQuerySchema;
export type ListWorkspacesQuery = z.infer<typeof pageQuerySchema>;
export type ListMembersQuery = z.infer<typeof pageQuerySchema>;

/** A UUID route parameter, compared in lower case. */
const uuidParam = (field: string) =>
  z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: `${field} must be a valid UUID` }));

/** `:workspaceId` route parameter. */
export const workspaceParamsSchema = z.strictObject({ workspaceId: uuidParam('workspaceId') });

/** `:workspaceId/members/:userId` route parameters. */
export const memberParamsSchema = z.strictObject({
  workspaceId: uuidParam('workspaceId'),
  userId: uuidParam('userId'),
});

export type WorkspaceParams = z.infer<typeof workspaceParamsSchema>;
export type MemberParams = z.infer<typeof memberParamsSchema>;

/** For endpoints whose only input is the URL path: no query parameters, no body fields. */
export const noInputSchema = z.strictObject({});

/**
 * `PATCH …/members/:userId/role` body. Only the requested role; who may change
 * it is decided by the server from the session.
 */
export const changeRoleBodySchema = z.strictObject({
  role: z.enum(['OWNER', 'MEMBER'], { error: 'role must be OWNER or MEMBER' }),
});

export type ChangeRoleBody = z.infer<typeof changeRoleBodySchema>;

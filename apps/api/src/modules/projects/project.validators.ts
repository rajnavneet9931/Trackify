import { z } from 'zod';

import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_PAGE_SIZE_DEFAULT,
  PROJECT_PAGE_SIZE_MAX,
} from './project.model.js';

// Same rule as workspace names: no control characters in a one-line name.
const CONTROL_CHARACTERS = /\p{Cc}/u;
// Descriptions are multi-line: allow tab, line feed and carriage return only.
const CONTROL_EXCEPT_WHITESPACE = /[^\P{Cc}\t\n\r]/u;

const projectName = z
  .string({
    error: (issue) => (issue.input === undefined ? 'Name is required' : 'Name must be a string'),
  })
  .max(PROJECT_NAME_MAX_LENGTH * 4, { error: 'Name is too long' }) // cheap pre-check
  .transform((name) => name.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, { error: 'Name is required' })
      .max(PROJECT_NAME_MAX_LENGTH, {
        error: `Name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`,
      })
      .refine((name) => !CONTROL_CHARACTERS.test(name), {
        error: 'Name must not contain control characters',
      }),
  );

/** A description value: `null` or empty/whitespace-only mean "no description" (stored as NULL). */
const descriptionValue = z
  .string({ error: 'Description must be a string' })
  .max(PROJECT_DESCRIPTION_MAX_LENGTH * 4, { error: 'Description is too long' })
  .transform((text) => text.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .max(PROJECT_DESCRIPTION_MAX_LENGTH, {
        error: `Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`,
      })
      .refine((text) => !CONTROL_EXCEPT_WHITESPACE.test(text), {
        error: 'Description must not contain control characters',
      }),
  )
  .transform((text) => (text === '' ? null : text))
  .nullable();

/** On create, omitted also means "no description". */
const projectDescription = descriptionValue.optional().transform((value) => value ?? null);

/**
 * `POST /workspaces/:workspaceId/projects`. Strict: `id`, `workspaceId`,
 * `createdById`, `status` (and anything else) are rejected — the server decides
 * them from the route and the session.
 */
export const createProjectBodySchema = z.strictObject({
  name: projectName,
  description: projectDescription,
});

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

/**
 * `GET /workspaces/:workspaceId/projects` query. Strict like the other lists:
 * unknown or repeated parameters are rejected. The cursor's contents are
 * checked when it is decoded (project-cursor.ts).
 */
export const listProjectsQuerySchema = z.strictObject({
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be an integer' })
    .min(1, { error: 'limit must be at least 1' })
    .max(PROJECT_PAGE_SIZE_MAX, { error: `limit must be at most ${PROJECT_PAGE_SIZE_MAX}` })
    .default(PROJECT_PAGE_SIZE_DEFAULT),
  cursor: z.string({ error: 'cursor must be a string' }).min(1).max(200).optional(),
});

export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

/** A UUID route parameter, compared in lower case (same rule as the workspace routes). */
const uuidParam = (field: string) =>
  z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: `${field} must be a valid UUID` }));

/** `:workspaceId/projects/:projectId` route parameters. */
export const projectParamsSchema = z.strictObject({
  workspaceId: uuidParam('workspaceId'),
  projectId: uuidParam('projectId'),
});

export type ProjectParams = z.infer<typeof projectParamsSchema>;

/** For endpoints whose only input is the URL path: no query parameters, no body fields. */
export const noInputSchema = z.strictObject({});

/**
 * `PATCH /workspaces/:workspaceId/projects/:projectId`. Strict: only `name` and
 * `description` can change; `id`, `workspaceId`, `createdById`, `status`,
 * `createdAt` and `updatedAt` are rejected. At least one of the two is required.
 *
 * `expectedUpdatedAt` is the optimistic-concurrency precondition: the
 * `updatedAt` the client last saw. The update applies only if the project
 * still has exactly that value; otherwise the client gets 409 and must reload,
 * so nobody silently overwrites a newer change.
 */
export const updateProjectBodySchema = z
  .strictObject({
    name: projectName.optional(),
    description: descriptionValue.optional(), // omitted = unchanged; null/'' = clear
    expectedUpdatedAt: z.iso
      .datetime({ error: 'expectedUpdatedAt must be an ISO 8601 UTC timestamp' })
      .transform((value) => new Date(value)),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    error: 'Provide a name or a description to update',
  });

export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;

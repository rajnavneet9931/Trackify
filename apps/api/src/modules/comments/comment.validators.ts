import { z } from 'zod';

import {
  COMMENT_CONTENT_MAX_LENGTH,
  COMMENT_PAGE_SIZE_DEFAULT,
  COMMENT_PAGE_SIZE_MAX,
} from './comment.model.js';

// Multi-line text: allow tab, line feed and carriage return only.
const CONTROL_EXCEPT_WHITESPACE = /[^\P{Cc}\t\n\r]/u;

const commentContent = z
  .string({
    error: (issue) =>
      issue.input === undefined ? 'Comment is required' : 'Comment must be a string',
  })
  .max(COMMENT_CONTENT_MAX_LENGTH * 4, { error: 'Comment is too long' }) // cheap pre-check
  .transform((text) => text.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, { error: 'Comment is required' })
      .max(COMMENT_CONTENT_MAX_LENGTH, {
        error: `Comment must be at most ${COMMENT_CONTENT_MAX_LENGTH} characters`,
      })
      .refine((text) => !CONTROL_EXCEPT_WHITESPACE.test(text), {
        error: 'Comment must not contain control characters',
      }),
  );

/**
 * `POST …/comments`. Strict: exactly `{ content }`. The author comes from the
 * session and the task from the URL, so `userId`, `authorId`, `taskId` and any
 * other field are rejected.
 */
export const createCommentBodySchema = z.strictObject({ content: commentContent });

export type CreateCommentBody = z.infer<typeof createCommentBodySchema>;

/**
 * `PATCH …/comments/:commentId`. Strict: the new `content` plus
 * `expectedUpdatedAt`, the `updatedAt` the client last saw. The edit applies
 * only if the comment still has exactly that value; otherwise 409.
 */
export const updateCommentBodySchema = z.strictObject({
  content: commentContent,
  expectedUpdatedAt: z.iso
    .datetime({ error: 'expectedUpdatedAt must be an ISO 8601 UTC timestamp' })
    .transform((value) => new Date(value)),
});

export type UpdateCommentBody = z.infer<typeof updateCommentBodySchema>;

/** List query. Strict like the other lists: unknown or repeated parameters are rejected. */
export const listCommentsQuerySchema = z.strictObject({
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be an integer' })
    .min(1, { error: 'limit must be at least 1' })
    .max(COMMENT_PAGE_SIZE_MAX, { error: `limit must be at most ${COMMENT_PAGE_SIZE_MAX}` })
    .default(COMMENT_PAGE_SIZE_DEFAULT),
  cursor: z.string({ error: 'cursor must be a string' }).min(1).max(300).optional(),
});

export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;

/** A UUID route parameter, compared in lower case (same rule as the other routes). */
const uuidParam = (field: string) =>
  z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: `${field} must be a valid UUID` }));

/** `…/projects/:projectId/tasks/:taskId/comments` route parameters. */
export const taskCommentsParamsSchema = z.strictObject({
  workspaceId: uuidParam('workspaceId'),
  projectId: uuidParam('projectId'),
  taskId: uuidParam('taskId'),
});

/** `…/comments/:commentId` route parameters. */
export const commentParamsSchema = z.strictObject({
  workspaceId: uuidParam('workspaceId'),
  projectId: uuidParam('projectId'),
  taskId: uuidParam('taskId'),
  commentId: uuidParam('commentId'),
});

export type TaskCommentsParams = z.infer<typeof taskCommentsParamsSchema>;
export type CommentParams = z.infer<typeof commentParamsSchema>;

export const noInputSchema = z.strictObject({});

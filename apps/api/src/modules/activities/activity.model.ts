import { z } from 'zod';

import { TaskActivityType, TaskPriority, TaskStatus } from '../../generated/prisma/enums.js';

export { TaskActivityType };

export const ACTIVITY_PAGE_SIZE_DEFAULT = 20;
export const ACTIVITY_PAGE_SIZE_MAX = 50;

const uuid = z.uuid();
const status = z.enum(TaskStatus);
const priority = z.enum(TaskPriority);
const commentRef = z.strictObject({ commentId: uuid });
/** A UTC timestamp change: ISO strings, null meaning "not set". */
const isoOrNull = z.iso.datetime().nullable();
const timestampChange = z.strictObject({ from: isoOrNull, to: isoOrNull });

/**
 * The only metadata each activity type may carry: small, typed values
 * (previous/new values, user and comment IDs). Never comment text, task
 * descriptions or anything credential-like. Validated before every write and
 * re-validated on every read, so a malformed row can never leak through.
 */
export const activityMetadataSchemas = {
  [TaskActivityType.TASK_CREATED]: z.strictObject({
    priority,
    /** Only when the task didn't start as TODO. */
    status: status.optional(),
    dueDate: z.iso.datetime().optional(),
  }),
  [TaskActivityType.TASK_UPDATED]: z.strictObject({
    changedFields: z.array(z.enum(['title', 'description', 'dueDate', 'reminderAt'])).min(1),
    /** Only when the title changed. Titles are visible to every member anyway. */
    title: z.strictObject({ from: z.string(), to: z.string() }).optional(),
    /** Only when the due date changed. */
    dueDate: timestampChange.optional(),
    /** Only when the reminder changed. */
    reminderAt: timestampChange.optional(),
  }),
  [TaskActivityType.STATUS_CHANGED]: z.strictObject({ from: status, to: status }),
  [TaskActivityType.PRIORITY_CHANGED]: z.strictObject({ from: priority, to: priority }),
  [TaskActivityType.ASSIGNEE_CHANGED]: z.strictObject({
    from: uuid.nullable(),
    to: uuid.nullable(),
    /** Set when the unassignment came from removing the assignee from the workspace. */
    reason: z.literal('MEMBER_REMOVED').optional(),
  }),
  [TaskActivityType.COMMENT_ADDED]: commentRef,
  [TaskActivityType.COMMENT_EDITED]: commentRef,
  [TaskActivityType.COMMENT_DELETED]: commentRef,
} as const;

type Schemas = typeof activityMetadataSchemas;

/** An activity to record: its type and that type's metadata. */
export type ActivityInput = {
  [T in TaskActivityType]: { type: T; metadata: z.infer<Schemas[T]> };
}[TaskActivityType];

/** A stored activity as read back (metadata already re-validated). */
export interface ActivityRecord {
  id: string;
  taskId: string;
  /** The actor; null once their account was deleted. */
  actorId: string | null;
  type: TaskActivityType;
  /** Validated metadata, or null if the stored value does not match its schema. */
  metadata: ActivityInput['metadata'] | null;
  createdAt: Date;
}

/** Validates metadata for a write; throws (rolling back the operation) if invalid. */
export function validatedMetadata(input: ActivityInput) {
  return activityMetadataSchemas[input.type].parse(input.metadata);
}

/** Re-validates stored metadata for a read; null if it doesn't match. */
export function parseStoredMetadata(type: TaskActivityType, value: unknown) {
  const result = activityMetadataSchemas[type].safeParse(value);
  return result.success ? (result.data as ActivityInput['metadata']) : null;
}

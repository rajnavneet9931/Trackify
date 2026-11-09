import { z } from 'zod';

import {
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_PAGE_SIZE_DEFAULT,
  TASK_PAGE_SIZE_MAX,
  TASK_TITLE_MAX_LENGTH,
  TaskPriority,
  TaskStatus,
} from './task.model.js';
import { DEFAULT_TASK_SORT, TASK_SORT_FIELDS } from './task-query.js';

// Same rules as project names/descriptions: no control characters in a
// one-line title; descriptions may contain tabs and line breaks only.
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTROL_EXCEPT_WHITESPACE = /[^\P{Cc}\t\n\r]/u;

const taskTitle = z
  .string({
    error: (issue) => (issue.input === undefined ? 'Title is required' : 'Title must be a string'),
  })
  .max(TASK_TITLE_MAX_LENGTH * 4, { error: 'Title is too long' }) // cheap pre-check
  .transform((title) => title.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, { error: 'Title is required' })
      .max(TASK_TITLE_MAX_LENGTH, {
        error: `Title must be at most ${TASK_TITLE_MAX_LENGTH} characters`,
      })
      .refine((title) => !CONTROL_CHARACTERS.test(title), {
        error: 'Title must not contain control characters',
      }),
  );

/** A description value: `null` or empty/whitespace-only mean "no description" (stored as NULL). */
const descriptionValue = z
  .string({ error: 'Description must be a string' })
  .max(TASK_DESCRIPTION_MAX_LENGTH * 4, { error: 'Description is too long' })
  .transform((text) => text.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .max(TASK_DESCRIPTION_MAX_LENGTH, {
        error: `Description must be at most ${TASK_DESCRIPTION_MAX_LENGTH} characters`,
      })
      .refine((text) => !CONTROL_EXCEPT_WHITESPACE.test(text), {
        error: 'Description must not contain control characters',
      }),
  )
  .transform((text) => (text === '' ? null : text))
  .nullable();

const PRIORITIES = Object.values(TaskPriority);
const STATUSES = Object.values(TaskStatus);

const taskPriority = z.enum(TaskPriority, {
  error: `Priority must be one of ${PRIORITIES.join(', ')}`,
});
const taskStatus = z.enum(TaskStatus, {
  error: `Status must be one of ${STATUSES.join(', ')}`,
});

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T/;
/** Accepted range: protects against typos like year 20266 or 0026. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * An ISO 8601 timestamp **with** a timezone (`Z` or `±hh:mm`), a real calendar
 * date (no 30 February) and a year in 2000–2100. Normalized to a UTC `Date`;
 * the API stores and compares only UTC. `null` clears the value.
 */
const instant = (field: string) =>
  z.iso
    .datetime({ offset: true, error: `${field} must be an ISO 8601 timestamp with a timezone` })
    .refine(
      (value) => {
        // Zod 4 still runs this after a failed format check; that error is
        // already reported, so only judge well-formed values here.
        const match = ISO_DATETIME.exec(value);
        if (!match) return true;
        const [, y, m, d] = match.map(Number);
        const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
        return y! >= MIN_YEAR && y! <= MAX_YEAR && d! >= 1 && d! <= daysInMonth;
      },
      { error: `${field} must be a valid date between ${MIN_YEAR} and ${MAX_YEAR}` },
    )
    .transform((value) => new Date(value));

const timestamp = (field: string) => instant(field).nullable();

/** Messages shared by the create schema and the service's merged-state check. */
export const SCHEDULE_MESSAGES = {
  reminderNeedsDueDate: 'A reminder requires a due date',
  reminderAfterDueDate: 'The reminder cannot be after the due date',
} as const;

/** Returns the rule broken by a due date / reminder pair, if any. */
export function scheduleProblem(dueDate: Date | null, reminderAt: Date | null) {
  if (reminderAt && !dueDate) return SCHEDULE_MESSAGES.reminderNeedsDueDate;
  if (reminderAt && dueDate && reminderAt.getTime() > dueDate.getTime()) {
    return SCHEDULE_MESSAGES.reminderAfterDueDate;
  }
  return undefined;
}

/**
 * `POST …/projects/:projectId/tasks`. Strict: `id`, `projectId`, `createdById`,
 * `status` (always TODO) and anything else are rejected. Optional `dueDate`
 * and `reminderAt` (a reminder requires a due date and can't be after it).
 */
export const createTaskBodySchema = z
  .strictObject({
    title: taskTitle,
    description: descriptionValue.optional().transform((value) => value ?? null),
    priority: taskPriority.default(TaskPriority.MEDIUM),
    /** Optional; omitted means "To do". */
    status: taskStatus.default(TaskStatus.TODO),
    /** Optional; a member of the workspace (checked in the transaction) or null. */
    assigneeId: z
      .string({ error: 'assigneeId must be a user ID or null' })
      .transform((id) => id.toLowerCase())
      .pipe(z.uuid({ error: 'assigneeId must be a valid UUID' }))
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    dueDate: timestamp('dueDate')
      .optional()
      .transform((value) => value ?? null),
    reminderAt: timestamp('reminderAt')
      .optional()
      .transform((value) => value ?? null),
  })
  .superRefine((body, ctx) => {
    const problem = scheduleProblem(body.dueDate, body.reminderAt);
    if (problem) ctx.addIssue({ code: 'custom', path: ['reminderAt'], message: problem });
  });

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

/**
 * `PATCH …/tasks/:taskId`. Strict: only title, description, status, priority,
 * dueDate and reminderAt can change (at least one; `null` clears a date).
 * `expectedUpdatedAt` is the optimistic concurrency precondition, exactly as
 * for projects: the update applies only if the task still has the
 * `updatedAt` the client saw, otherwise 409. The due date / reminder rules
 * are checked by the service against the task's resulting values.
 */
export const updateTaskBodySchema = z
  .strictObject({
    title: taskTitle.optional(),
    description: descriptionValue.optional(), // omitted = unchanged; null/'' = clear
    status: taskStatus.optional(),
    priority: taskPriority.optional(),
    dueDate: timestamp('dueDate').optional(), // omitted = unchanged; null = clear
    reminderAt: timestamp('reminderAt').optional(),
    expectedUpdatedAt: z.iso
      .datetime({ error: 'expectedUpdatedAt must be an ISO 8601 UTC timestamp' })
      .transform((value) => new Date(value)),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.status !== undefined ||
      body.priority !== undefined ||
      body.dueDate !== undefined ||
      body.reminderAt !== undefined,
    {
      error: 'Provide at least one of title, description, status, priority, dueDate or reminderAt',
    },
  );

export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;

/** List query. Strict like the other lists: unknown or repeated parameters are rejected. */
/** A UUID route parameter, compared in lower case (same rule as the other routes). */
const uuidParam = (field: string) =>
  z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: `${field} must be a valid UUID` }));

const booleanFlag = (field: string) =>
  z
    .enum(['true', 'false'], { error: `${field} must be true or false` })
    .transform((value) => value === 'true');

/**
 * Task list query: search, filters, sorting and keyset pagination. Strict
 * like the other lists: unknown or repeated parameters, invalid values and
 * unsupported sort fields are rejected (400).
 */
export const listTasksQuerySchema = z
  .strictObject({
    limit: z.coerce
      .number({ error: 'limit must be a number' })
      .int({ error: 'limit must be an integer' })
      .min(1, { error: 'limit must be at least 1' })
      .max(TASK_PAGE_SIZE_MAX, { error: `limit must be at most ${TASK_PAGE_SIZE_MAX}` })
      .default(TASK_PAGE_SIZE_DEFAULT),
    cursor: z.string({ error: 'cursor must be a string' }).min(1).max(600).optional(),
    /** Case-insensitive, in title or description; blank means no search. */
    search: z
      .string({ error: 'search must be a string' })
      .max(200, { error: 'search must be at most 200 characters' })
      .transform((value) => value.normalize('NFC').trim() || undefined)
      .optional(),
    status: taskStatus.optional(),
    priority: taskPriority.optional(),
    assigneeId: uuidParam('assigneeId').optional(),
    unassigned: booleanFlag('unassigned').optional(),
    dueDate: z.enum(['any', 'none'], { error: 'dueDate must be any or none' }).optional(),
    dueAfter: instant('dueAfter').optional(),
    dueBefore: instant('dueBefore').optional(),
    overdue: booleanFlag('overdue').optional(),
    createdById: uuidParam('createdById').optional(),
    sortBy: z
      .enum(TASK_SORT_FIELDS, { error: `sortBy must be one of ${TASK_SORT_FIELDS.join(', ')}` })
      .default(DEFAULT_TASK_SORT.field),
    sortOrder: z
      .enum(['asc', 'desc'], { error: 'sortOrder must be asc or desc' })
      .default(DEFAULT_TASK_SORT.order),
  })
  .superRefine((q, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (q.unassigned && q.assigneeId) {
      issue('unassigned', 'unassigned=true cannot be combined with assigneeId');
    }
    if (q.dueDate === 'none' && (q.dueAfter || q.dueBefore || q.overdue)) {
      issue('dueDate', 'dueDate=none cannot be combined with dueAfter, dueBefore or overdue');
    }
    if (q.dueAfter && q.dueBefore && q.dueAfter.getTime() >= q.dueBefore.getTime()) {
      issue('dueBefore', 'dueBefore must be after dueAfter');
    }
  });

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

/** `:workspaceId/projects/:projectId/tasks` route parameters. */
export const projectTasksParamsSchema = z.strictObject({
  workspaceId: uuidParam('workspaceId'),
  projectId: uuidParam('projectId'),
});

/** `…/tasks/:taskId` route parameters. */
export const taskParamsSchema = z.strictObject({
  workspaceId: uuidParam('workspaceId'),
  projectId: uuidParam('projectId'),
  taskId: uuidParam('taskId'),
});

export type ProjectTasksParams = z.infer<typeof projectTasksParamsSchema>;
export type TaskParams = z.infer<typeof taskParamsSchema>;

export const noInputSchema = z.strictObject({});

/**
 * `PATCH …/tasks/:taskId/assignee`. Strict: exactly `{ assigneeId }`, a user
 * UUID or `null` to unassign. Workspace, project and task come only from the
 * URL; any other field is rejected.
 */
export const assignTaskBodySchema = z.strictObject({
  assigneeId: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? 'assigneeId is required (a user ID, or null to unassign)'
          : 'assigneeId must be a user ID or null',
    })
    .transform((id) => id.toLowerCase())
    .pipe(z.uuid({ error: 'assigneeId must be a valid UUID' }))
    .nullable(),
});

export type AssignTaskBody = z.infer<typeof assignTaskBodySchema>;

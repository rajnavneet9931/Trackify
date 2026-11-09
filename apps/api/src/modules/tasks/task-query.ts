import { createHash } from 'node:crypto';

import { z } from 'zod';

import { BadRequestError } from '../../core/errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { TaskPriority, TaskStatus, type TaskView } from './task.model.js';

/** Fields the task list can be sorted by. */
export const TASK_SORT_FIELDS = ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title'] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';

export interface TaskSort {
  field: TaskSortField;
  order: SortOrder;
}

/** The existing default: newest first. */
export const DEFAULT_TASK_SORT: TaskSort = { field: 'createdAt', order: 'desc' };

/** Every filter is optional; all given filters must match (AND). */
export interface TaskFilters {
  /** Case-insensitive substring of the title or the description. */
  search?: string | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  assigneeId?: string | undefined;
  /** Only tasks without an assignee. */
  unassigned?: boolean | undefined;
  /** `any`: has a due date; `none`: has none. */
  dueDate?: 'any' | 'none' | undefined;
  /** Due at or after this instant (UTC). */
  dueAfter?: Date | undefined;
  /** Due strictly before this instant (UTC). */
  dueBefore?: Date | undefined;
  /** Due before now and not DONE. */
  overdue?: boolean | undefined;
  createdById?: string | undefined;
}

/** The position after which the next page starts: the sort value and the id. */
export interface TaskPosition {
  /** ISO timestamp, priority or title; null for a task without a due date. */
  value: string | null;
  id: string;
}

/** Priorities in their natural order (also the PostgreSQL enum order). */
const PRIORITY_ORDER: TaskPriority[] = [
  TaskPriority.LOW,
  TaskPriority.MEDIUM,
  TaskPriority.HIGH,
  TaskPriority.URGENT,
];

/** Prisma filter for the task list: always scoped to the project, then every given filter. */
export function taskListWhere(
  projectId: string,
  filters: TaskFilters,
  now: Date,
): Prisma.TaskWhereInput {
  const and: Prisma.TaskWhereInput[] = [];
  if (filters.search) {
    // Prisma's `contains` becomes ILIKE '%…%' without escaping LIKE wildcards
    // (verified against PostgreSQL): escape them so "50%" or "user_" match
    // literally. Backslash is PostgreSQL's default LIKE escape character.
    const literal = filters.search.replace(/[\\%_]/g, (c) => `\\${c}`);
    and.push({
      OR: [
        { title: { contains: literal, mode: 'insensitive' } },
        { description: { contains: literal, mode: 'insensitive' } },
      ],
    });
  }
  if (filters.status) and.push({ status: filters.status });
  if (filters.priority) and.push({ priority: filters.priority });
  if (filters.assigneeId) and.push({ assigneeId: filters.assigneeId });
  if (filters.unassigned) and.push({ assigneeId: null });
  if (filters.createdById) and.push({ createdById: filters.createdById });
  if (filters.dueDate === 'any') and.push({ dueDate: { not: null } });
  if (filters.dueDate === 'none') and.push({ dueDate: null });
  if (filters.dueAfter) and.push({ dueDate: { gte: filters.dueAfter } });
  if (filters.dueBefore) and.push({ dueDate: { lt: filters.dueBefore } });
  if (filters.overdue) {
    and.push({ dueDate: { lt: now }, status: { not: TaskStatus.DONE } });
  }
  return { projectId, AND: and };
}

/** ORDER BY: the sort field (tasks without a due date always last), then id as tie-breaker. */
export function taskListOrderBy({ field, order }: TaskSort): Prisma.TaskOrderByWithRelationInput[] {
  const primary: Prisma.TaskOrderByWithRelationInput =
    field === 'dueDate' ? { dueDate: { sort: order, nulls: 'last' } } : { [field]: order };
  return [primary, { id: order }];
}

/**
 * Keyset condition: rows strictly after `position` in the given order. The
 * id breaks ties in the same direction, so pages never overlap or skip.
 */
export function taskListAfter(
  { field, order }: TaskSort,
  { value, id }: TaskPosition,
): Prisma.TaskWhereInput {
  const op = order === 'asc' ? 'gt' : 'lt';
  const sameValueLaterId = { id: { [op]: id } };

  if (field === 'priority') {
    const rank = PRIORITY_ORDER.indexOf(value as TaskPriority);
    const beyond = PRIORITY_ORDER.filter((_, i) => (order === 'asc' ? i > rank : i < rank));
    return {
      OR: [{ priority: { in: beyond } }, { priority: value as TaskPriority, ...sameValueLaterId }],
    };
  }
  if (field === 'title') {
    return { OR: [{ title: { [op]: value } }, { title: value!, ...sameValueLaterId }] };
  }
  if (field === 'dueDate') {
    if (value === null) return { dueDate: null, ...sameValueLaterId }; // within the "no date" tail
    const at = new Date(value);
    return {
      OR: [
        { dueDate: { [op]: at } },
        { dueDate: at, ...sameValueLaterId },
        { dueDate: null }, // undated tasks come after every dated one
      ],
    };
  }
  const at = new Date(value!);
  return { OR: [{ [field]: { [op]: at } }, { [field]: at, ...sameValueLaterId }] };
}

/** The sort value of a task, as stored in a cursor. */
export function sortValueOf(task: TaskView, field: TaskSortField): string | null {
  switch (field) {
    case 'priority':
      return task.priority;
    case 'title':
      return task.title;
    case 'dueDate':
      return task.dueDate?.toISOString() ?? null;
    default:
      return task[field].toISOString();
  }
}

/** A short fingerprint of the filters, so a cursor can't be reused with other filters. */
function filtersFingerprint(filters: TaskFilters): string {
  const canonical = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url').slice(0, 16);
}

const PREFIX = 't2:';
const cursorShape = z.strictObject({
  p: z.uuid(),
  s: z.enum(TASK_SORT_FIELDS),
  o: z.enum(['asc', 'desc']),
  f: z.string(),
  v: z.string().max(1000).nullable(),
  i: z.uuid(),
});

/**
 * Opaque cursor bound to its project, its sort and its filters: reusing it
 * with another project, sort order or filter set is rejected (400) instead of
 * silently returning a wrong page.
 */
export function encodeTaskListCursor(
  projectId: string,
  sort: TaskSort,
  filters: TaskFilters,
  position: TaskPosition,
): string {
  const payload = {
    p: projectId,
    s: sort.field,
    o: sort.order,
    f: filtersFingerprint(filters),
    v: position.value,
    i: position.id,
  };
  return Buffer.from(PREFIX + JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeTaskListCursor(
  cursor: string,
  projectId: string,
  sort: TaskSort,
  filters: TaskFilters,
): TaskPosition {
  const invalid = () =>
    new BadRequestError('Invalid pagination cursor', [
      { location: 'query', path: 'cursor', message: 'Invalid cursor' },
    ]);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(PREFIX)) throw invalid();
  let parsed: z.infer<typeof cursorShape>;
  try {
    parsed = cursorShape.parse(JSON.parse(decoded.slice(PREFIX.length)));
  } catch {
    throw invalid();
  }
  if (
    parsed.p !== projectId ||
    parsed.s !== sort.field ||
    parsed.o !== sort.order ||
    parsed.f !== filtersFingerprint(filters) ||
    !validSortValue(sort.field, parsed.v)
  ) {
    throw invalid();
  }
  return { value: parsed.v, id: parsed.i };
}

function validSortValue(field: TaskSortField, value: string | null): boolean {
  if (field === 'dueDate') return value === null || !Number.isNaN(Date.parse(value));
  if (value === null) return false;
  if (field === 'priority') return (PRIORITY_ORDER as string[]).includes(value);
  if (field === 'title') return value.length > 0;
  return !Number.isNaN(Date.parse(value));
}

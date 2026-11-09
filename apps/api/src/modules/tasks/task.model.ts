import { TaskPriority, TaskStatus } from '../../generated/prisma/enums.js';

export { TaskPriority, TaskStatus };

export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 5000;
export const TASK_PAGE_SIZE_DEFAULT = 20;
export const TASK_PAGE_SIZE_MAX = 50;

/** Fields returned by the API for a task. */
export interface TaskView {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  createdById: string;
  assigneeId: string | null;
  /**
   * Only id and email. The assignee is always a member of the task's
   * workspace (enforced on assignment and on member removal), so this shows
   * no more than the workspace's member list already does.
   */
  assignee: TaskAssignee | null;
  /** Deadline (UTC), or null. */
  dueDate: Date | null;
  /** When to remind (UTC), or null. Never after dueDate. */
  reminderAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskAssignee {
  id: string;
  email: string;
}

/** Minimal creator info for the details view; null once they left the workspace. */
export interface TaskCreator {
  id: string;
  email: string;
}

/** Delivery state of the task's latest reminder. */
export interface TaskReminderState {
  status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  remindAt: Date;
  sentAt: Date | null;
}

export interface TaskDetail extends TaskView {
  creator: TaskCreator | null;
  /** The latest reminder scheduled for this task, if any. */
  reminder: TaskReminderState | null;
}

export const taskViewSelect = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  createdById: true,
  assigneeId: true,
  // Joined in the same query (no N+1); never password hashes or sessions.
  assignee: { select: { id: true, email: true } },
  dueDate: true,
  reminderAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

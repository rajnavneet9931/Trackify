import { useId, useRef, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useDateTime } from '../account/preferences-context';
import { useAuth } from '../auth/auth-context';
import {
  selectClass,
  taskFieldErrorsFrom as fieldErrorsFrom,
  type TaskFieldErrors as FieldErrors,
} from './form-utils';
import { fromLocalInputValue, scheduleProblem } from './dates';
import { PRIORITY_LABELS, STATUS_LABELS } from './labels';
import { ScheduleFields } from './ScheduleFields';
import {
  createTask,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from './tasks.api';
import {
  normalizeTaskText,
  TASK_DESCRIPTION_MAX_LENGTH,
  validateTaskDescription,
  validateTaskTitle,
} from './validation';

/**
 * Any workspace member creates a task in an active project (the API enforces
 * membership and the archived rule). New tasks always start as "To do".
 */
export function CreateTaskForm({
  workspaceId,
  projectId,
  onCreated,
  members = [],
  currentUserId = '',
}: {
  workspaceId: string;
  projectId: string;
  onCreated: (task: Task) => void;
  /** Workspace members offered as assignees (may be empty while loading). */
  members?: { userId: string; email: string; name?: string | null }[];
  currentUserId?: string;
}) {
  const { timeZone } = useDateTime();
  const { invalidateSession } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [status, setStatus] = useState<TaskStatus>('TODO');
  const [assigneeId, setAssigneeId] = useState('');
  // datetime-local values, in the user's local time ('' = none).
  const [dueDate, setDueDate] = useState('');
  const [reminderAt, setReminderAt] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [createdTitle, setCreatedTitle] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const descriptionId = useId();
  const priorityId = useId();
  const statusId = useId();
  const assigneeFieldId = useId();

  function focusFirstError(next: FieldErrors) {
    if (next.title) titleRef.current?.focus();
    else if (next.description) descriptionRef.current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setFormError(undefined);
    setCreatedTitle(undefined);
    const due = fromLocalInputValue(dueDate, timeZone);
    const remind = fromLocalInputValue(reminderAt, timeZone);
    const next = {
      title: validateTaskTitle(title),
      description: validateTaskDescription(description),
      schedule: scheduleProblem(due, remind),
    };
    setErrors(next);
    if (next.title || next.description || next.schedule) {
      focusFirstError(next);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const normalizedDescription = normalizeTaskText(description);
      const { task } = await createTask(workspaceId, projectId, {
        title: normalizeTaskText(title),
        ...(normalizedDescription && { description: normalizedDescription }),
        priority,
        ...(status !== 'TODO' && { status }),
        ...(assigneeId && { assigneeId }),
        ...(due && { dueDate: due }),
        ...(remind && { reminderAt: remind }),
      });
      setCreatedTitle(task.title);
      setTitle('');
      setDescription('');
      setPriority('MEDIUM');
      setStatus('TODO');
      setAssigneeId('');
      setDueDate('');
      setReminderAt('');
      onCreated(task);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFormError('Something went wrong. Please try again.');
      } else if (err.status === 401) {
        invalidateSession();
      } else if (err.status === 400 && Object.values(fieldErrorsFrom(err.details)).some(Boolean)) {
        const fromServer = fieldErrorsFrom(err.details);
        setErrors(fromServer);
        focusFirstError(fromServer);
      } else if (err.status === 409 || err.status === 422) {
        // e.g. the project was archived, or the assignee left the workspace, meanwhile
        setFormError(err.message);
      } else if (err.status === 404) {
        setFormError('This project is no longer available.');
      } else if (err.status === 0 || err.status === 503) {
        setFormError('Trackify is temporarily unavailable. Please try again in a moment.');
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const descriptionErrorId = errors.description ? `${descriptionId}-error` : undefined;

  return (
    <section
      aria-labelledby="create-task-heading"
      className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-panel"
    >
      <h3 id="create-task-heading" className="text-base font-semibold">
        Create a task
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Only the title is required. New tasks start as “To do” unless you choose otherwise.
      </p>

      <form noValidate onSubmit={handleSubmit} aria-busy={submitting} className="mt-4 space-y-3">
        {formError && <FormAlert>{formError}</FormAlert>}
        {createdTitle && (
          <FormAlert tone="success">
            <p>
              Task <strong>{createdTitle}</strong> created.
            </p>
          </FormAlert>
        )}

        <TextField
          ref={titleRef}
          label="Task title"
          name="title"
          autoComplete="off"
          value={title}
          onValueChange={setTitle}
          error={errors.title}
          readOnly={submitting}
        />

        <div>
          <label htmlFor={descriptionId} className="block text-sm font-medium text-slate-800">
            Description <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <textarea
            ref={descriptionRef}
            id={descriptionId}
            name="description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            readOnly={submitting}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={descriptionErrorId}
            className={`mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:ring-2 focus:outline-none ${
              errors.description
                ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200'
                : 'border-slate-300 focus:border-brand-500 focus:ring-brand-100'
            }`}
          />
          {errors.description ? (
            <p id={descriptionErrorId} className="mt-1 text-sm text-rose-600">
              {errors.description}
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Up to {TASK_DESCRIPTION_MAX_LENGTH} characters.
            </p>
          )}
        </div>

        <ScheduleFields
          dueDate={dueDate}
          reminderAt={reminderAt}
          onDueDateChange={setDueDate}
          onReminderAtChange={setReminderAt}
          error={errors.schedule}
          disabled={submitting}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor={statusId} className="block text-sm font-medium text-slate-800">
              Status
            </label>
            <select
              id={statusId}
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              disabled={submitting}
              className={selectClass}
            >
              {TASK_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={assigneeFieldId} className="block text-sm font-medium text-slate-800">
              Assignee
            </label>
            <select
              id={assigneeFieldId}
              name="assigneeId"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              disabled={submitting}
              className={selectClass}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {(m.name ? `${m.name} (${m.email})` : m.email) +
                    (m.userId === currentUserId ? ' (you)' : '')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={priorityId} className="block text-sm font-medium text-slate-800">
              Priority
            </label>
            <select
              id={priorityId}
              name="priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              disabled={submitting}
              aria-invalid={errors.priority ? true : undefined}
              aria-describedby={errors.priority ? `${priorityId}-error` : undefined}
              className={selectClass}
            >
              {TASK_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {PRIORITY_LABELS[value]}
                </option>
              ))}
            </select>
            {errors.priority && (
              <p id={`${priorityId}-error`} className="mt-1 text-sm text-rose-600">
                {errors.priority}
              </p>
            )}
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Creating task…' : 'Create task'}
        </button>
      </form>
    </section>
  );
}

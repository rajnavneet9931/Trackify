import { useId, useRef, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useDateTime } from '../account/preferences-context';
import { useAuth } from '../auth/auth-context';
import { selectClass, taskFieldErrorsFrom, type TaskFieldErrors } from './form-utils';
import { fromLocalInputValue, scheduleProblem, toLocalInputValue } from './dates';
import { PRIORITY_LABELS, STATUS_LABELS } from './labels';
import { ScheduleFields } from './ScheduleFields';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  updateTask,
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
 * Any workspace member edits a task of an active project: title, description,
 * status and priority. Sends the `updatedAt` the user saw, so a change made
 * meanwhile by someone else is reported (409) instead of overwritten.
 */
export function EditTaskForm({
  workspaceId,
  task,
  onSaved,
  onCancel,
  onReload,
}: {
  workspaceId: string;
  task: Task;
  onSaved: (task: Task) => void;
  onCancel: () => void;
  /** Reloads the task (offered after a conflict). */
  onReload: () => void;
}) {
  const { timeZone } = useDateTime();
  const { invalidateSession } = useAuth();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  // datetime-local values in the user's local time; '' removes the value.
  const [dueDate, setDueDate] = useState(toLocalInputValue(task.dueDate, timeZone));
  const [reminderAt, setReminderAt] = useState(toLocalInputValue(task.reminderAt, timeZone));
  const [errors, setErrors] = useState<TaskFieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const descriptionId = useId();
  const statusId = useId();
  const priorityId = useId();

  function focusFirstError(next: TaskFieldErrors) {
    if (next.title) titleRef.current?.focus();
    else if (next.description) descriptionRef.current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setFormError(undefined);
    setConflict(false);
    const next = {
      title: validateTaskTitle(title),
      description: validateTaskDescription(description),
      schedule: scheduleProblem(
        fromLocalInputValue(dueDate, timeZone),
        fromLocalInputValue(reminderAt, timeZone),
      ),
    };
    setErrors(next);
    if (next.title || next.description || next.schedule) {
      focusFirstError(next);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const { task: saved } = await updateTask(workspaceId, task.projectId, task.id, {
        title: normalizeTaskText(title),
        description: normalizeTaskText(description) || null,
        status,
        priority,
        dueDate: unchangedOr(task.dueDate, dueDate, timeZone),
        reminderAt: unchangedOr(task.reminderAt, reminderAt, timeZone),
        expectedUpdatedAt: task.updatedAt,
      });
      onSaved(saved);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFormError('Something went wrong. Please try again.');
      } else if (err.status === 401) {
        invalidateSession();
      } else if (
        err.status === 400 &&
        Object.values(taskFieldErrorsFrom(err.details)).some(Boolean)
      ) {
        const fromServer = taskFieldErrorsFrom(err.details);
        setErrors(fromServer);
        focusFirstError(fromServer);
      } else if (err.status === 409) {
        // Changed by someone else, or the project was archived: API wording, then reload.
        setFormError(err.message);
        setConflict(true);
      } else if (err.status === 404) {
        setFormError('This task is no longer available.');
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
    <form
      noValidate
      onSubmit={handleSubmit}
      aria-busy={submitting}
      aria-label="Edit task"
      className="mt-6 space-y-3 rounded-lg border border-slate-200 bg-white p-5 shadow-panel"
    >
      {formError && (
        <FormAlert>
          <p>{formError}</p>
          {conflict && (
            <button
              type="button"
              onClick={onReload}
              className="mt-2 text-sm font-medium underline hover:no-underline"
            >
              Reload task
            </button>
          )}
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
          rows={5}
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

      <div className="grid gap-3 sm:grid-cols-2">
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
            aria-invalid={errors.status ? true : undefined}
            aria-describedby={errors.status ? `${statusId}-error` : undefined}
            className={selectClass}
          >
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
          {errors.status && (
            <p id={`${statusId}-error`} className="mt-1 text-sm text-rose-600">
              {errors.status}
            </p>
          )}
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

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The value to send for a date field: the stored UTC value when the input
 * wasn't changed (the input only has minute precision), otherwise the new
 * value converted to UTC, or null when cleared.
 */
function unchangedOr(stored: string | null, input: string, timeZone?: string): string | null {
  return input === toLocalInputValue(stored, timeZone)
    ? stored
    : fromLocalInputValue(input, timeZone);
}

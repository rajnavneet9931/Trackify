import { useId, useState } from 'react';

import { useToast } from '../../components/ui/toast-context';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { selectClass } from './form-utils';
import { PRIORITY_LABELS, STATUS_LABELS } from './labels';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  updateTaskFields,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from './tasks.api';

/**
 * Status and priority, changed in place on the task page: each change is
 * saved immediately (PATCH with the version shown, so a concurrent edit gives
 * a clear 409 instead of being overwritten) and confirmed with a toast.
 */
export function TaskQuickFields({
  workspaceId,
  task,
  onChanged,
  onReload,
}: {
  workspaceId: string;
  task: Task;
  onChanged: (task: Task) => void;
  onReload: () => void;
}) {
  const { invalidateSession } = useAuth();
  const { notify } = useToast();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ text: string; stale?: boolean }>();

  async function save(changes: { status?: TaskStatus; priority?: TaskPriority }, what: string) {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const { task: updated } = await updateTaskFields(
        workspaceId,
        task.projectId,
        task.id,
        changes,
        task.updatedAt,
      );
      onChanged(updated);
      notify(what);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      if (err instanceof ApiError && err.status === 409 && !err.message.includes('archived')) {
        setError({ text: 'This task was changed by someone else.', stale: true });
      } else {
        setError({
          text:
            err instanceof ApiError && (err.status === 409 || err.status === 400)
              ? err.message
              : 'We couldn’t save the change. Please try again.',
        });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3">
      <div>
        <label htmlFor={`${id}-status`} className="block text-xs font-medium text-slate-500">
          Status
        </label>
        <select
          id={`${id}-status`}
          value={task.status}
          disabled={saving}
          onChange={(e) => {
            const status = e.target.value as TaskStatus;
            void save({ status }, `Status changed to ${STATUS_LABELS[status]}.`);
          }}
          className={selectClass}
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-priority`} className="block text-xs font-medium text-slate-500">
          Priority
        </label>
        <select
          id={`${id}-priority`}
          value={task.priority}
          disabled={saving}
          onChange={(e) => {
            const priority = e.target.value as TaskPriority;
            void save({ priority }, `Priority changed to ${PRIORITY_LABELS[priority]}.`);
          }}
          className={selectClass}
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      {saving && (
        <p aria-live="polite" className="text-xs text-slate-500">
          Saving…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-700">
          {error.text}
          {error.stale && (
            <button
              type="button"
              onClick={onReload}
              className="ml-2 font-medium underline hover:no-underline"
            >
              Reload
            </button>
          )}
        </p>
      )}
    </div>
  );
}

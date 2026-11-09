import { useId, useRef, useState } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { Avatar } from '../../components/ui/Avatar';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { selectClass } from './form-utils';
import { setTaskAssignee, type Task } from './tasks.api';
import { useAssignableMembers } from './useAssignableMembers';

const UNASSIGNED = '';

function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (error.status) {
    case 409: // archived meanwhile: API wording
    case 422: // no longer a member: API wording
      return error.message;
    case 404:
      return 'This task is no longer available.';
    case 0:
    case 503:
      return 'Trackify is temporarily unavailable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * Shows who a task is assigned to and, in active projects, lets any member
 * assign it to a member of this workspace, reassign it, or unassign it.
 * Archived projects show the assignee read-only.
 */
export function TaskAssignee({
  workspaceId,
  task,
  readOnly,
  currentUserId,
  onChanged,
}: {
  workspaceId: string;
  task: Task;
  /** UX only: the API independently refuses changes in archived projects. */
  readOnly: boolean;
  currentUserId: string;
  onChanged: (task: Task) => void;
}) {
  const label = (email: string, id: string) => (id === currentUserId ? `${email} (you)` : email);
  const current = task.assignee ? label(task.assignee.email, task.assignee.id) : 'Unassigned';

  return (
    <section aria-labelledby="assignee-heading">
      <h2 id="assignee-heading" className="text-xs font-medium text-slate-500">
        Assignee
      </h2>
      {task.assignee && (
        <p className="mt-1.5 flex items-center gap-2 text-sm text-slate-800">
          <Avatar label={task.assignee.email} seed={task.assignee.id} size="sm" />
          <span className="min-w-0 truncate">{current}</span>
        </p>
      )}
      {readOnly ? (
        !task.assignee && <p className="mt-1 text-sm text-slate-700">{current}</p>
      ) : (
        <AssigneeForm
          key={task.id}
          workspaceId={workspaceId}
          task={task}
          label={label}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

function AssigneeForm({
  workspaceId,
  task,
  label,
  onChanged,
}: {
  workspaceId: string;
  task: Task;
  label: (email: string, id: string) => string;
  onChanged: (task: Task) => void;
}) {
  const { invalidateSession } = useAuth();
  const members = useAssignableMembers(workspaceId);
  const [selected, setSelected] = useState(task.assigneeId ?? UNASSIGNED);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const selectId = useId();

  /** Saves as soon as a different person is picked; no separate Save button. */
  async function save(value: string) {
    if (inFlight.current || value === (task.assigneeId ?? UNASSIGNED)) return;
    setSelected(value);
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const { task: saved } = await setTaskAssignee(
        workspaceId,
        task.projectId,
        task.id,
        value === UNASSIGNED ? null : value,
      );
      setSelected(saved.assigneeId ?? UNASSIGNED);
      setSuccess(
        saved.assignee
          ? `Task assigned to ${label(saved.assignee.email, saved.assignee.id)}.`
          : 'Task unassigned.',
      );
      onChanged(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      setError(describeError(err));
      setSelected(task.assigneeId ?? UNASSIGNED); // back to what is actually stored
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (members.state.status === 'loading') {
    return (
      <p role="status" className="mt-1 text-sm text-slate-500">
        Loading members…
      </p>
    );
  }

  if (members.state.status === 'error') {
    return (
      <div role="alert" className="mt-2 text-sm text-rose-800">
        <p>We couldn’t load the members of this workspace.</p>
        <button
          type="button"
          onClick={members.retry}
          className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Try again
        </button>
      </div>
    );
  }

  const options = members.state.members;
  // Keep the current assignee selectable even if they're beyond the loaded pages.
  const currentMissing =
    task.assignee && !options.some((m) => m.userId === task.assignee!.id) ? task.assignee : null;
  return (
    <div aria-busy={submitting} className="mt-2 space-y-3">
      {error && <FormAlert>{error}</FormAlert>}
      {success && <FormAlert tone="success">{success}</FormAlert>}
      {options.length === 0 && !currentMissing && (
        <p className="text-sm text-slate-600">This workspace has no members to assign yet.</p>
      )}
      <div className="grid gap-2">
        <div>
          <label htmlFor={selectId} className="sr-only">
            Assign to
          </label>
          <select
            id={selectId}
            name="assignee"
            value={selected}
            onChange={(e) => void save(e.target.value)}
            disabled={submitting}
            className={selectClass}
          >
            <option value={UNASSIGNED}>Unassigned</option>
            {currentMissing && (
              <option value={currentMissing.id}>
                {label(currentMissing.email, currentMissing.id)}
              </option>
            )}
            {options.map((member) => (
              <option key={member.userId} value={member.userId}>
                {label(member.email, member.userId)}
              </option>
            ))}
          </select>
        </div>
        {submitting && (
          <p aria-live="polite" className="text-sm text-slate-500">
            Saving…
          </p>
        )}
      </div>
      {members.state.truncated && (
        <p className="text-xs text-slate-500">Showing the first 1,000 members.</p>
      )}
    </div>
  );
}

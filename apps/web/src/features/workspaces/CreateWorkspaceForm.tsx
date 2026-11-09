import { useRef, useState, type FormEvent, type RefObject } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { normalizeWorkspaceName, validateWorkspaceName } from './validation';
import { createWorkspace, type WorkspaceListItem } from './workspaces.api';

function nameErrorFrom(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  const match = details.find((d) => (d as { path?: unknown })?.path === 'name') as
    { message?: unknown } | undefined;
  return typeof match?.message === 'string' ? match.message : undefined;
}

function describeCreateError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Your request was blocked by a security check. Refresh the page and try again.';
    }
    if (error.status === 429) return 'Too many requests. Please wait a moment and try again.';
    if (error.status === 0 || error.status === 503) {
      return 'Trackify is temporarily unavailable. Please try again in a moment.';
    }
  }
  return 'Something went wrong. Please try again.';
}

/** Name-only form for POST /workspaces. Reports the created workspace to the list. */
export function CreateWorkspaceForm({
  inputRef,
  onCreated,
}: {
  /** Owned by the page so its empty-state button can focus this field. */
  inputRef: RefObject<HTMLInputElement | null>;
  onCreated: (workspace: WorkspaceListItem) => void;
}) {
  const { invalidateSession } = useAuth();
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setFormError(undefined);
    setCreated(undefined);
    const error = validateWorkspaceName(name);
    setFieldError(error);
    if (error) {
      inputRef.current?.focus();
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const { workspace, membership } = await createWorkspace(normalizeWorkspaceName(name));
      onCreated({ ...workspace, role: membership.role });
      setName('');
      setCreated(`Workspace “${workspace.name}” created.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession(); // session ended: the route guard sends the user to sign in
        return;
      }
      const serverFieldError =
        err instanceof ApiError && err.status === 400 ? nameErrorFrom(err.details) : undefined;
      if (serverFieldError) {
        setFieldError(serverFieldError);
        inputRef.current?.focus();
      } else {
        setFormError(describeCreateError(err));
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit} aria-busy={submitting} className="space-y-3">
      {formError && <FormAlert>{formError}</FormAlert>}
      {created && <FormAlert tone="success">{created}</FormAlert>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          ref={inputRef}
          className="flex-1"
          label="Workspace name"
          name="name"
          autoComplete="off"
          placeholder="e.g. Platform Team"
          value={name}
          onValueChange={setName}
          error={fieldError}
          readOnly={submitting}
        />
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60 sm:mt-6"
        >
          {submitting ? 'Creating…' : 'Create workspace'}
        </button>
      </div>
    </form>
  );
}

import { useId, useRef, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { updateProject, type Project } from './projects.api';
import {
  normalizeProjectText,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  validateProjectDescription,
  validateProjectName,
} from './validation';

interface FieldErrors {
  name?: string | undefined;
  description?: string | undefined;
}

function fieldErrorsFrom(details: unknown): FieldErrors {
  if (!Array.isArray(details)) return {};
  const messageFor = (field: string) => {
    const match = details.find((d) => (d as { path?: unknown })?.path === field) as
      { message?: unknown } | undefined;
    return typeof match?.message === 'string' ? match.message : undefined;
  };
  return { name: messageFor('name'), description: messageFor('description') };
}

/**
 * Owner-only editing of an ACTIVE project's name and description (the API
 * enforces both rules). Sends the `updatedAt` the user saw, so a change made
 * meanwhile by someone else is reported (409) instead of overwritten.
 */
export function EditProjectForm({
  workspaceId,
  project,
  onSaved,
  onCancel,
  onReload,
}: {
  workspaceId: string;
  project: Project;
  onSaved: (project: Project) => void;
  onCancel: () => void;
  /** Reloads the project (offered after a conflict). */
  onReload: () => void;
}) {
  const { invalidateSession } = useAuth();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const descriptionId = useId();

  function focusFirstError(next: FieldErrors) {
    if (next.name) nameRef.current?.focus();
    else if (next.description) descriptionRef.current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setFormError(undefined);
    setConflict(false);
    const next = {
      name: validateProjectName(name),
      description: validateProjectDescription(description),
    };
    setErrors(next);
    if (next.name || next.description) {
      focusFirstError(next);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const { project: saved } = await updateProject(workspaceId, project.id, {
        name: normalizeProjectText(name),
        description: normalizeProjectText(description) || null,
        expectedUpdatedAt: project.updatedAt,
      });
      onSaved(saved);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFormError('Something went wrong. Please try again.');
      } else if (err.status === 401) {
        invalidateSession();
      } else if (err.status === 400 && Object.values(fieldErrorsFrom(err.details)).some(Boolean)) {
        const fromServer = fieldErrorsFrom(err.details);
        setErrors(fromServer);
        focusFirstError(fromServer);
      } else if (err.status === 409) {
        // Changed by someone else, or archived meanwhile: API wording, then reload.
        setFormError(err.message);
        setConflict(true);
      } else if (err.status === 403) {
        setFormError(
          'Only workspace owners can edit projects. If your role just changed, refresh the page.',
        );
      } else if (err.status === 404) {
        setFormError('This project no longer exists.');
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
      aria-label="Edit project"
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
              Reload project
            </button>
          )}
        </FormAlert>
      )}

      <TextField
        ref={nameRef}
        label="Project name"
        name="name"
        autoComplete="off"
        value={name}
        onValueChange={setName}
        error={errors.name}
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
          rows={4}
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
            Up to {PROJECT_DESCRIPTION_MAX_LENGTH} characters.
          </p>
        )}
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

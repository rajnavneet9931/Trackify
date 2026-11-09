import { useId, useRef, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { createProject, type Project } from './projects.api';
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
 * Owner-only form (the API enforces this; the page only shows it to owners).
 * Success is confirmed with a message and reported through `onCreated`.
 */
export function CreateProjectForm({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  /** Called with the server's project (e.g. to show it at the top of the list). */
  onCreated?: (project: Project) => void;
}) {
  const { invalidateSession } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [createdName, setCreatedName] = useState<string>();
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
    setCreatedName(undefined);
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
      const normalizedDescription = normalizeProjectText(description);
      const { project } = await createProject(workspaceId, {
        name: normalizeProjectText(name),
        ...(normalizedDescription && { description: normalizedDescription }),
      });
      setCreatedName(project.name);
      onCreated?.(project);
      setName('');
      setDescription('');
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFormError('Something went wrong. Please try again.');
      } else if (err.status === 401) {
        invalidateSession();
      } else if (err.status === 400 && Object.values(fieldErrorsFrom(err.details)).some(Boolean)) {
        const fromServer = fieldErrorsFrom(err.details);
        setErrors(fromServer);
        focusFirstError(fromServer);
      } else if (err.status === 403) {
        setFormError('Only workspace owners can create projects.');
      } else if (err.status === 404) {
        setFormError('This workspace is no longer available.');
      } else if (err.status === 429) {
        setFormError('Too many requests. Please wait and try again later.');
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
      aria-labelledby="create-project-heading"
      className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-panel"
    >
      <h2 id="create-project-heading" className="text-base font-semibold">
        Create a project
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Projects organize work in this workspace. Only owners can create them.
      </p>

      <form noValidate onSubmit={handleSubmit} aria-busy={submitting} className="mt-4 space-y-3">
        {formError && <FormAlert>{formError}</FormAlert>}
        {createdName && (
          <FormAlert tone="success">
            <p>
              Project <strong>{createdName}</strong> created.
            </p>
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
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            readOnly={submitting}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={descriptionErrorId}
            className={`mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 ${
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

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Creating project…' : 'Create project'}
        </button>
      </form>
    </section>
  );
}

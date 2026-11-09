import { useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { updateWorkspaceSettings, type WorkspaceSettings } from './workspaces.api';
import { buttonClass } from '../../components/ui/styles';

export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 2000;

const textareaClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none disabled:bg-slate-50';
const primaryButton = buttonClass('primary');

/**
 * Name and description. Owners get an edit form (409 when another owner
 * changed them meanwhile, with a reload); members see them read-only. The
 * API enforces the same rules either way.
 */
export function WorkspaceGeneralSettings({
  workspaceId,
  settings,
  canEdit,
  onSaved,
  onReload,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
  onSaved: (settings: WorkspaceSettings) => void;
  onReload: () => void;
}) {
  const { invalidateSession } = useAuth();
  const [name, setName] = useState(settings.name);
  const [description, setDescription] = useState(settings.description ?? '');
  const [errors, setErrors] = useState<{ name?: string; description?: string }>({});
  const [formError, setFormError] = useState<{ text: string; stale?: boolean }>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    return (
      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-slate-600">Name</dt>
          <dd className="font-medium break-words text-slate-900">{settings.name}</dd>
        </div>
        <div>
          <dt className="text-slate-600">Description</dt>
          <dd className="break-words whitespace-pre-line text-slate-800">
            {settings.description ?? <span className="text-slate-500 italic">No description.</span>}
          </dd>
        </div>
        <p className="text-xs text-slate-500">Only owners can change these settings.</p>
      </dl>
    );
  }

  const trimmedName = name.normalize('NFC').trim();
  const trimmedDescription = description.normalize('NFC').trim();
  const changed =
    trimmedName !== settings.name || (trimmedDescription || null) !== settings.description;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !changed) return;
    const next: typeof errors = {};
    if (!trimmedName) next.name = 'Name is required';
    else if (trimmedName.length > NAME_MAX)
      next.name = `Name must be at most ${NAME_MAX} characters`;
    if (trimmedDescription.length > DESCRIPTION_MAX) {
      next.description = `Description must be at most ${DESCRIPTION_MAX} characters`;
    }
    setErrors(next);
    setFormError(undefined);
    setSaved(false);
    if (next.name || next.description) return;

    setSaving(true);
    try {
      const { settings: updated } = await updateWorkspaceSettings(workspaceId, {
        ...(trimmedName !== settings.name && { name: trimmedName }),
        ...((trimmedDescription || null) !== settings.description && {
          description: trimmedDescription || null,
        }),
        expectedUpdatedAt: settings.updatedAt,
      });
      setName(updated.name);
      setDescription(updated.description ?? '');
      setSaved(true);
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setFormError({
          text: 'Someone else changed these settings. Reload them to see the latest version.',
          stale: true,
        });
      } else if (err instanceof ApiError && err.status === 403) {
        setFormError({ text: 'Only owners can change these settings.' });
      } else if (err instanceof ApiError && err.status === 400) {
        setFormError({ text: err.message });
      } else {
        setFormError({ text: 'We couldn’t save the settings. Please try again.' });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
      {formError && (
        <FormAlert>
          {formError.text}
          {formError.stale && (
            <button
              type="button"
              onClick={onReload}
              className="ml-2 font-medium underline hover:no-underline"
            >
              Reload
            </button>
          )}
        </FormAlert>
      )}
      {saved && <FormAlert tone="success">Settings saved.</FormAlert>}
      <TextField
        label="Workspace name"
        value={name}
        onValueChange={(value) => {
          setName(value);
          setSaved(false);
        }}
        error={errors.name}
        maxLength={NAME_MAX + 20}
        disabled={saving}
      />
      <div>
        <label htmlFor="workspace-description" className="block text-sm font-medium text-slate-800">
          Description
        </label>
        <textarea
          id="workspace-description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setSaved(false);
          }}
          rows={4}
          maxLength={DESCRIPTION_MAX + 200}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? 'workspace-description-error' : undefined}
          disabled={saving}
          className={textareaClass}
        />
        {errors.description && (
          <p id="workspace-description-error" className="mt-1 text-sm text-rose-700">
            {errors.description}
          </p>
        )}
        <p className="mt-1 text-xs text-slate-500">Optional. Visible to every member.</p>
      </div>
      <button type="submit" disabled={saving || !changed} className={primaryButton}>
        {saving ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}

import { useRef, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { validateEmail } from '../auth/validation';
import { createInvitation } from './invitations.api';

interface Result {
  email: string;
  /** Absolute dev-only link, when the API provides one. */
  devLink?: string;
}

function emailErrorFrom(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  const match = details.find((d) => (d as { path?: unknown })?.path === 'email') as
    { message?: unknown } | undefined;
  return typeof match?.message === 'string' ? match.message : undefined;
}

/**
 * Owner-only form (the API enforces this; the page only shows it to owners).
 * There is no email delivery yet, so it never claims an email was sent. In
 * development the API returns an accept link to share manually.
 */
export function InviteMemberForm({ workspaceId }: { workspaceId: string }) {
  const { invalidateSession } = useAuth();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setFormError(undefined);
    setResult(undefined);
    const error = validateEmail(email);
    setFieldError(error);
    if (error) {
      inputRef.current?.focus();
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const { invitation, delivery } = await createInvitation(workspaceId, email.trim());
      setResult({
        email: invitation.email,
        ...(delivery.devAcceptPath && {
          devLink: `${window.location.origin}${delivery.devAcceptPath}`,
        }),
      });
      setEmail('');
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFormError('Something went wrong. Please try again.');
      } else if (err.status === 401) {
        invalidateSession();
      } else if (err.status === 400 && emailErrorFrom(err.details)) {
        setFieldError(emailErrorFrom(err.details));
        inputRef.current?.focus();
      } else if (err.status === 409 || err.status === 422) {
        // Already a member, invitation already pending, or no account: API wording.
        setFieldError(err.message);
        inputRef.current?.focus();
      } else if (err.status === 403) {
        setFormError('Only workspace owners can invite people.');
      } else if (err.status === 404) {
        setFormError('This workspace is no longer available.');
      } else if (err.status === 429) {
        setFormError('You have sent too many invitations. Please wait and try again later.');
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

  return (
    <section
      aria-labelledby="invite-heading"
      className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-panel"
    >
      <h2 id="invite-heading" className="text-base font-semibold">
        Invite a member
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Invite someone who already has a Trackify account. They join as a member.
      </p>

      <form noValidate onSubmit={handleSubmit} aria-busy={submitting} className="mt-4 space-y-3">
        {formError && <FormAlert>{formError}</FormAlert>}
        {result && (
          <FormAlert tone="success">
            <p>
              Invitation created for <strong>{result.email}</strong>. Email delivery isn’t set up
              yet, so no email was sent.
            </p>
          </FormAlert>
        )}
        {result?.devLink && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">Development only</p>
            <p className="mt-1">
              Share this link with the invitee. They must sign in with the invited email address.
            </p>
            <label className="mt-2 block">
              <span className="sr-only">Invitation link</span>
              <input
                readOnly
                value={result.devLink}
                onFocus={(e) => e.currentTarget.select()}
                className="block w-full rounded border border-amber-300 bg-white px-2 py-1 font-mono text-xs"
              />
            </label>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <TextField
            ref={inputRef}
            className="flex-1"
            label="Email address"
            type="email"
            name="email"
            autoComplete="off"
            inputMode="email"
            value={email}
            onValueChange={setEmail}
            error={fieldError}
            readOnly={submitting}
          />
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60 sm:mt-6"
          >
            {submitting ? 'Creating invitation…' : 'Create invitation'}
          </button>
        </div>
      </form>
    </section>
  );
}

import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { FormAlert } from '../components/form/FormAlert';
import { TextField } from '../components/form/TextField';
import { registerAccount } from '../features/auth/auth.api';
import { AuthCard, primaryButtonClass, textLinkClass } from '../features/auth/AuthCard';
import type { LoginLocationState } from '../features/auth/redirect';
import {
  describeAuthError,
  hasErrors,
  PASSWORD_MIN_LENGTH,
  validateRegistration,
  type FieldErrors,
} from '../features/auth/validation';

export function RegisterPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  function focusFirstInvalid(errors: FieldErrors) {
    if (errors.email) emailRef.current?.focus();
    else if (errors.password) passwordRef.current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    const errors = validateRegistration({ email, password });
    setFieldErrors(errors);
    setFormError(undefined);
    if (hasErrors(errors)) {
      focusFirstInvalid(errors);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const { user } = await registerAccount({ email: email.trim(), password });
      // Registration does not start a session; continue to sign-in with the email prefilled.
      // The password is not carried over or kept anywhere.
      const state: LoginLocationState = { notice: 'registered', email: user.email };
      navigate('/login', { replace: true, state });
    } catch (error) {
      const feedback = describeAuthError(error, 'registration');
      setFieldErrors(feedback.fieldErrors);
      setFormError(feedback.formError);
      focusFirstInvalid(feedback.fieldErrors);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Create your Trackify account"
      subtitle="Start planning and tracking work with your team."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className={textLinkClass}>
            Sign in
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={handleSubmit} aria-busy={submitting} className="space-y-5">
        {formError && <FormAlert>{formError}</FormAlert>}

        <TextField
          ref={emailRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onValueChange={setEmail}
          error={fieldErrors.email}
          readOnly={submitting}
        />
        <TextField
          ref={passwordRef}
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`}
          value={password}
          onValueChange={setPassword}
          error={fieldErrors.password}
          readOnly={submitting}
        />

        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  );
}

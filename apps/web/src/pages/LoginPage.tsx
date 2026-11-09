import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { FormAlert } from '../components/form/FormAlert';
import { TextField } from '../components/form/TextField';
import { useAuth } from '../features/auth/auth-context';
import { AuthCard, primaryButtonClass, textLinkClass } from '../features/auth/AuthCard';
import { postLoginPath, type LoginLocationState } from '../features/auth/redirect';
import {
  describeAuthError,
  hasErrors,
  validateLogin,
  type FieldErrors,
} from '../features/auth/validation';

const NOTICES: Record<NonNullable<LoginLocationState['notice']>, string> = {
  registered: 'Your account has been created. Sign in to continue.',
  'signed-out': 'You have been signed out.',
  'password-changed':
    'Your password was changed and you were signed out everywhere. Sign in with your new password.',
};

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LoginLocationState | null;

  const [email, setEmail] = useState(state?.email ?? '');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard: blocks a second submit before React re-renders the disabled button.
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

    const errors = validateLogin({ email, password });
    setFieldErrors(errors);
    setFormError(undefined);
    if (hasErrors(errors)) {
      focusFirstInvalid(errors);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      await signIn({ email: email.trim(), password });
      navigate(postLoginPath(location.state), { replace: true });
    } catch (error) {
      const feedback = describeAuthError(error, 'sign-in');
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
      title="Sign in to Trackify"
      subtitle="Welcome back. Enter your details to continue."
      footer={
        <>
          New to Trackify?{' '}
          <Link to="/register" className={textLinkClass}>
            Create an account
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={handleSubmit} aria-busy={submitting} className="space-y-5">
        {state?.notice && !formError && (
          <FormAlert tone="success">{NOTICES[state.notice]}</FormAlert>
        )}
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
          autoComplete="current-password"
          required
          value={password}
          onValueChange={setPassword}
          error={fieldErrors.password}
          readOnly={submitting}
        />

        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  );
}

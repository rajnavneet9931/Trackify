import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { getCsrfToken } from '../../lib/api-client';
import {
  apiError,
  deferred,
  mockApi,
  renderApp,
  session,
  USER,
  type MockReply,
} from '../../test/mock-api';

const PASSWORD = 'correct horse battery staple';
const unauthorized = apiError(401, 'UNAUTHORIZED', 'Authentication required');
const unavailable = apiError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');
const loggedOut: MockReply = { status: 200, body: { data: { loggedOut: true } } };

async function fillLogin(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
  return user;
}

describe('session restoration (GET /auth/me)', () => {
  it('restores a valid session once on startup, even under StrictMode', async () => {
    const api = mockApi({ 'GET /api/v1/auth/me': session() });
    renderApp('/');

    expect(
      await screen.findByRole('link', { name: /signed in as ada@example\.com/i }),
    ).toBeInTheDocument();
    expect(api.to('GET /api/v1/auth/me')).toHaveLength(1);
    expect(api.to('GET /api/v1/auth/me')[0]!.credentials).toBe('include');
    expect(getCsrfToken()).toBe('csrf-1');
  });

  it('treats 401 as signed out', async () => {
    mockApi({ 'GET /api/v1/auth/me': unauthorized });
    renderApp('/');

    const header = within(screen.getByRole('banner'));
    expect(await header.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(getCsrfToken()).toBeNull();
  });

  it.each([
    ['503', unavailable],
    ['network failure', new TypeError('Failed to fetch')],
  ])('does not treat a %s as signed out, and offers a retry', async (_label, failure) => {
    const api = mockApi({ 'GET /api/v1/auth/me': [failure, session()] });
    const { router } = renderApp('/account');

    expect(
      await screen.findByRole('heading', { name: 'Can’t verify your session' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account'); // not redirected to /login
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(api.to('GET /api/v1/auth/me')).toHaveLength(2);
  });
});

describe('route protection', () => {
  it('redirects unauthenticated users to /login and back after signing in', async () => {
    const api = mockApi({ 'POST /api/v1/auth/login': session('csrf-from-login') });
    const { router } = renderApp('/account');

    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');

    const user = await fillLogin('ada@example.com', PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
    expect(api.unmatched).toEqual([]);
  });

  it('shows a loading state while the session is being checked', async () => {
    const pending = deferred<MockReply>();
    mockApi({ 'GET /api/v1/auth/me': () => pending.promise });
    renderApp('/account');

    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
    pending.resolve(session());
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
  });

  it.each(['/login', '/register'])('sends signed-in users away from %s', async (path) => {
    mockApi({ 'GET /api/v1/auth/me': session() });
    const { router } = renderApp(path);

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
  });
});

describe('login', () => {
  it('validates fields before calling the API and focuses the first invalid one', async () => {
    const api = mockApi();
    renderApp('/login');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Sign in' }));

    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Email is required');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Password is required');
    expect(email).toHaveFocus();
    expect(api.to('POST /api/v1/auth/login')).toHaveLength(0);
  });

  it('signs in, stores the CSRF token in memory, and sends exactly the two fields', async () => {
    const api = mockApi({ 'POST /api/v1/auth/login': session('csrf-from-login') });
    const { router } = renderApp('/login');

    const user = await fillLogin('  Ada@Example.com ', PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
    const [request] = api.to('POST /api/v1/auth/login');
    expect(request!.body).toEqual({ email: 'Ada@Example.com', password: PASSWORD });
    expect(request!.headers.get('content-type')).toBe('application/json');
    expect(request!.credentials).toBe('include');
    expect(getCsrfToken()).toBe('csrf-from-login');
  });

  it('shows the generic invalid-credentials message and stays on the page', async () => {
    mockApi({
      'POST /api/v1/auth/login': apiError(401, 'UNAUTHORIZED', 'Invalid email or password'),
    });
    const { router } = renderApp('/login');

    const user = await fillLogin('ada@example.com', PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(router.state.location.pathname).toBe('/login');
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it('shows server-side field errors', async () => {
    mockApi({
      'POST /api/v1/auth/login': apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [
        { location: 'body', path: 'email', message: 'Must be a valid email address' },
      ]),
    });
    renderApp('/login');

    const user = await fillLogin('ada@localhost.x', PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
        'Must be a valid email address',
      ),
    );
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it.each([
    [429, apiError(429, 'RATE_LIMITED', 'Too many requests'), /Too many sign-in attempts/],
    [503, unavailable, /temporarily unavailable/],
  ])('explains a %s safely', async (_status, reply, message) => {
    mockApi({ 'POST /api/v1/auth/login': reply });
    renderApp('/login');

    const user = await fillLogin('ada@example.com', PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('shows a loading state and prevents duplicate submissions', async () => {
    const pending = deferred<MockReply>();
    const api = mockApi({ 'POST /api/v1/auth/login': () => pending.promise });
    renderApp('/login');

    await fillLogin('ada@example.com', PASSWORD);
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);

    const button = await screen.findByRole('button', { name: 'Signing in…' });
    expect(button).toBeDisabled();
    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(api.to('POST /api/v1/auth/login')).toHaveLength(1);

    pending.resolve(session());
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
  });

  it('only redirects to internal paths after sign-in', async () => {
    mockApi({ 'POST /api/v1/auth/login': session() });
    const { router } = renderApp('/login', { from: { pathname: '//evil.example/x' } });

    const user = await fillLogin('ada@example.com', PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
  });
});

describe('registration', () => {
  it('validates with the API’s rules before submitting', async () => {
    const api = mockApi();
    renderApp('/register');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    const password = screen.getByLabelText('Password');
    expect(password).toHaveAccessibleDescription('Password must be at least 12 characters');
    expect(password).toHaveFocus();
    expect(api.to('POST /api/v1/auth/register')).toHaveLength(0);
  });

  it('registers and continues to sign-in with the email prefilled (password not kept)', async () => {
    const api = mockApi({
      'POST /api/v1/auth/register': { status: 201, body: { data: { user: USER } } },
    });
    const { router } = renderApp('/register');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'Ada@Example.com');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByRole('status')).toHaveTextContent('Your account has been created');
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(api.to('POST /api/v1/auth/register')[0]!.body).toEqual({
      email: 'Ada@Example.com',
      password: PASSWORD,
    });
  });

  it('shows a duplicate email (409) on the email field', async () => {
    mockApi({
      'POST /api/v1/auth/register': apiError(
        409,
        'CONFLICT',
        'An account with this email address already exists',
      ),
    });
    renderApp('/register');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
        'An account with this email address already exists.',
      ),
    );
  });

  it('prevents duplicate submissions while the request is pending', async () => {
    const pending = deferred<MockReply>();
    const api = mockApi({ 'POST /api/v1/auth/register': () => pending.promise });
    renderApp('/register');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    const form = screen.getByRole('button', { name: 'Create account' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole('button', { name: 'Creating account…' })).toBeDisabled();
    expect(api.to('POST /api/v1/auth/register')).toHaveLength(1);
    pending.resolve({ status: 201, body: { data: { user: USER } } });
    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();
  });
});

describe('logout', () => {
  type Handlers = NonNullable<Parameters<typeof mockApi>[0]>;
  async function signedIn(logoutReplies: Handlers[string], me = [session('csrf-1')]) {
    const api = mockApi({ 'GET /api/v1/auth/me': me, 'POST /api/v1/auth/logout': logoutReplies });
    const view = renderApp('/account');
    await screen.findByRole('heading', { name: 'Your account' });
    const main = within(screen.getByRole('main'));
    return {
      api,
      ...view,
      signOutButton: () => main.getByRole('button', { name: /sign out|signing out/i }),
    };
  }

  it('POSTs with the CSRF token, clears state and goes to sign-in (200)', async () => {
    const { api, router, signOutButton } = await signedIn(loggedOut);

    await userEvent.setup().click(signOutButton());

    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You have been signed out.');
    expect(router.state.location.pathname).toBe('/login');
    const [request] = api.to('POST /api/v1/auth/logout');
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(request!.credentials).toBe('include');
    expect(api.requests.some((r) => r.method === 'GET' && r.path.endsWith('/logout'))).toBe(false);
    expect(getCsrfToken()).toBeNull();
  });

  it('treats 401 (session already expired) as signed out', async () => {
    const { router, signOutButton } = await signedIn(unauthorized);

    await userEvent.setup().click(signOutButton());

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(getCsrfToken()).toBeNull();
  });

  it('on 403 stays signed in, explains it, refreshes the CSRF token, and retries with it', async () => {
    const forbidden = apiError(403, 'FORBIDDEN', 'Invalid or missing CSRF token');
    const { api, router } = await signedIn(
      [forbidden, loggedOut],
      [session('stale'), session('fresh')],
    );
    const user = userEvent.setup();

    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign out' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-out was blocked by a security check');
    expect(router.state.location.pathname).toBe('/account');
    expect(screen.getByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    await waitFor(() => expect(getCsrfToken()).toBe('fresh'));

    await user.click(within(alert).getByRole('button', { name: 'Try signing out again' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    const tokens = api.to('POST /api/v1/auth/logout').map((r) => r.headers.get('X-CSRF-Token'));
    expect(tokens).toEqual(['stale', 'fresh']);
  });

  it.each([
    ['503', unavailable],
    ['network failure', new TypeError('Failed to fetch')],
  ])('on %s stays signed in and allows a retry', async (_label, failure) => {
    const { router } = await signedIn([failure, loggedOut]);
    const user = userEvent.setup();

    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign out' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You are still signed in');
    expect(router.state.location.pathname).toBe('/account');
    expect(getCsrfToken()).toBe('csrf-1');

    await user.click(within(alert).getByRole('button', { name: 'Try signing out again' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('shows a pending state and sends only one request for repeated clicks', async () => {
    const pending = deferred<MockReply>();
    const { api, signOutButton } = await signedIn(() => pending.promise);

    fireEvent.click(signOutButton());
    fireEvent.click(signOutButton());

    expect(signOutButton()).toHaveTextContent('Signing out…');
    expect(signOutButton()).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(api.to('POST /api/v1/auth/logout')).toHaveLength(1);

    pending.resolve(loggedOut);
    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();
  });
});

describe('browser storage and logging', () => {
  it('never writes credentials or tokens to storage or the console', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    mockApi({
      'POST /api/v1/auth/login': session('csrf-secret'),
      'POST /api/v1/auth/logout': loggedOut,
    });
    renderApp('/login');

    const user = await fillLogin('ada@example.com', PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Your account' });
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to Trackify' });

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    const logged = JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('csrf-secret');
  });
});

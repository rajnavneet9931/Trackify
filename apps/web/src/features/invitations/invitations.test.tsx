import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  noProjects,
  renderApp,
  session,
  USER,
  type MockReply,
} from '../../test/mock-api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const TOKEN = 'T'.repeat(43);
const DETAIL = `GET /api/v1/workspaces/${WS_ID}`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const PROJECTS = `GET /api/v1/workspaces/${WS_ID}/projects`;
const INVITE = `POST /api/v1/workspaces/${WS_ID}/invitations`;

const detail = (role: 'OWNER' | 'MEMBER'): MockReply => ({
  status: 200,
  body: {
    data: {
      workspace: { id: WS_ID, name: 'Platform Team', createdAt: '2026-10-18T10:00:00.000Z' },
      membership: { role },
    },
  },
});
const members: MockReply = {
  status: 200,
  body: {
    data: {
      members: [
        { userId: USER.id, email: USER.email, role: 'OWNER', joinedAt: '2026-10-18T10:00:00.000Z' },
      ],
    },
    meta: { limit: 20, nextCursor: null },
  },
};
const created = (devAcceptPath?: string): MockReply => ({
  status: 201,
  body: {
    data: {
      invitation: {
        id: 'inv-1',
        workspaceId: WS_ID,
        email: 'grace@example.com',
        status: 'PENDING',
        expiresAt: '2026-10-25T10:00:00.000Z',
        createdAt: '2026-10-18T10:00:00.000Z',
      },
      delivery: { emailSent: false, ...(devAcceptPath && { devAcceptPath }) },
    },
  },
});

function signedInWith(handlers: Parameters<typeof mockApi>[0]) {
  return mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), [PROJECTS]: noProjects, ...handlers });
}

type Handler = NonNullable<Parameters<typeof mockApi>[0]>[string];

async function openDetail(role: 'OWNER' | 'MEMBER', inviteReply?: Handler) {
  const api = signedInWith({
    [DETAIL]: detail(role),
    [MEMBERS]: members,
    ...(inviteReply && { [INVITE]: inviteReply }),
  });
  renderApp(`/workspaces/${WS_ID}/members`);
  await screen.findByRole('heading', { level: 1, name: 'Members' }, { timeout: 5000 });
  return api;
}

async function submitInvite(email: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText('Email address');
  await user.clear(input);
  if (email) await user.type(input, email);
  await user.click(screen.getByRole('button', { name: 'Create invitation' }));
  return input;
}

describe('invite form on the workspace page', () => {
  it('is shown to owners only', async () => {
    await openDetail('MEMBER');
    expect(screen.queryByRole('heading', { name: 'Invite a member' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });

  it('validates the email before calling the API', async () => {
    const api = await openDetail('OWNER', created());
    const input = await submitInvite('not-an-email');

    expect(input).toHaveAccessibleDescription('Must be a valid email address');
    expect(input).toHaveFocus();
    expect(api.to(INVITE)).toHaveLength(0);
  });

  it('creates an invitation with the CSRF token and says no email was sent', async () => {
    const api = await openDetail('OWNER', created());
    await submitInvite('  Grace@Example.com ');

    const status = (await screen.findByText(/Invitation created for/)).closest('[role=status]')!;
    expect(status).toHaveTextContent('Invitation created for grace@example.com');
    expect(status).toHaveTextContent('no email was sent');
    expect(screen.queryByText('Development only')).not.toBeInTheDocument();
    const [request] = api.to(INVITE);
    expect(request!.body).toEqual({ email: 'Grace@Example.com' });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('shows the development-only link, clearly labelled, when the API provides one', async () => {
    await openDetail('OWNER', created(`/invitations/accept#token=${TOKEN}`));
    await submitInvite('grace@example.com');

    expect(await screen.findByText('Development only')).toBeInTheDocument();
    expect(screen.getByLabelText('Invitation link')).toHaveValue(
      `${window.location.origin}/invitations/accept#token=${TOKEN}`,
    );
  });

  it('shows a loading state and prevents duplicate submissions', async () => {
    const pending = deferred<MockReply>();
    const api = await openDetail('OWNER', () => pending.promise);
    await userEvent.setup().type(screen.getByLabelText('Email address'), 'grace@example.com');
    const form = screen.getByRole('button', { name: 'Create invitation' }).closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole('button', { name: 'Creating invitation…' })).toBeDisabled();
    expect(api.to(INVITE)).toHaveLength(1);
    pending.resolve(created());
    expect(await screen.findByText(/Invitation created for/)).toBeInTheDocument();
  });

  it.each([
    [409, 'CONFLICT', 'This person is already a member of the workspace.'],
    [409, 'CONFLICT', 'A pending invitation already exists for this email address.'],
    [
      422,
      'UNPROCESSABLE_ENTITY',
      'Only people who already have a Trackify account can be invited.',
    ],
  ])('shows a %s (%s) on the email field', async (status, code, message) => {
    await openDetail('OWNER', apiError(status, code, message));
    const input = await submitInvite('grace@example.com');

    await waitFor(() => expect(input).toHaveAccessibleDescription(message));
  });

  it.each([
    [apiError(403, 'FORBIDDEN', 'x'), 'Only workspace owners can invite people.'],
    [apiError(429, 'RATE_LIMITED', 'x'), 'You have sent too many invitations'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
  ])('explains other failures safely (%#)', async (reply, message) => {
    await openDetail('OWNER', reply);
    await submitInvite('grace@example.com');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('never logs the invitation link', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    await openDetail('OWNER', created(`/invitations/accept#token=${TOKEN}`));
    await submitInvite('grace@example.com');
    await screen.findByText('Development only');

    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain(TOKEN);
  });
});

describe('accept invitation page', () => {
  const ACCEPT = 'POST /api/v1/invitations/accept';
  const DECLINE = 'POST /api/v1/invitations/decline';
  const path = `/invitations/accept#token=${TOKEN}`;
  const accepted: MockReply = {
    status: 200,
    body: {
      data: {
        workspace: { id: WS_ID, name: 'Platform Team', createdAt: '2026-10-18T10:00:00.000Z' },
        membership: { role: 'MEMBER' },
      },
    },
  };

  function renderAccept(handlers: Parameters<typeof mockApi>[0]) {
    const api = signedInWith(handlers);
    return { api, ...renderApp(path) };
  }

  it('accepts with the token in the body and opens the workspace', async () => {
    const { api, router } = renderAccept({
      [ACCEPT]: accepted,
      [DETAIL]: detail('MEMBER'),
      [MEMBERS]: members,
    });

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform Team' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/workspaces/${WS_ID}`);
    expect(router.state.location.hash).toBe('');
    const [request] = api.to(ACCEPT);
    expect(request!.body).toEqual({ token: TOKEN });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(
      api.requests.some((r) => r.path.includes(TOKEN) || r.query.toString().includes(TOKEN)),
    ).toBe(false);
  });

  it('declines and removes the token from the address bar', async () => {
    const { api, router } = renderAccept({
      [DECLINE]: { status: 200, body: { data: { declined: true } } },
    });

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Decline' }));

    expect(await screen.findByRole('heading', { name: 'Invitation declined' })).toBeInTheDocument();
    expect(router.state.location.hash).toBe('');
    expect(api.to(DECLINE)[0]!.body).toEqual({ token: TOKEN });
  });

  it.each([
    [apiError(403, 'FORBIDDEN', 'x'), 'sent to a different email address'],
    [apiError(404, 'NOT_FOUND', 'Invitation not found'), 'This invitation link is invalid.'],
    [
      apiError(409, 'CONFLICT', 'This invitation is no longer valid.'),
      'This invitation is no longer valid.',
    ],
    [
      apiError(409, 'CONFLICT', 'You are already a member of this workspace.'),
      'You are already a member',
    ],
    [apiError(410, 'GONE', 'This invitation has expired.'), 'This invitation has expired.'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
  ])('explains failures safely (%#) and allows another attempt', async (reply, message) => {
    renderAccept({ [ACCEPT]: reply });

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeEnabled();
  });

  it('prevents duplicate submissions while a request is pending', async () => {
    const pending = deferred<MockReply>();
    const { api } = renderAccept({
      [ACCEPT]: () => pending.promise,
      [DETAIL]: detail('MEMBER'),
      [MEMBERS]: members,
    });

    const button = await screen.findByRole('button', { name: 'Accept invitation' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Accepting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    expect(api.to(ACCEPT)).toHaveLength(1);
    pending.resolve(accepted);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform Team' }),
    ).toBeInTheDocument();
  });

  it('rejects a missing or malformed token without calling the API', async () => {
    const api = signedInWith({});
    renderApp('/invitations/accept#token=short');

    expect(
      await screen.findByRole('heading', { name: 'Invalid invitation link' }),
    ).toBeInTheDocument();
    expect(api.to(ACCEPT)).toHaveLength(0);
  });

  it('sends signed-out users to sign in and back to the same link (token preserved)', async () => {
    let signedIn = false;
    const api = mockApi({
      'GET /api/v1/auth/me': () =>
        signedIn ? session('csrf-2') : apiError(401, 'UNAUTHORIZED', 'Authentication required'),
      'POST /api/v1/auth/login': () => {
        signedIn = true;
        return session('csrf-2');
      },
      [ACCEPT]: accepted,
      [DETAIL]: detail('MEMBER'),
      [PROJECTS]: noProjects,
      [MEMBERS]: members,
    });
    const { router } = renderApp(path);

    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform Team' }),
    ).toBeInTheDocument();
    expect(api.to(ACCEPT)[0]!.body).toEqual({ token: TOKEN });
    expect(within(document.body).queryByText(TOKEN)).not.toBeInTheDocument();
  });
});

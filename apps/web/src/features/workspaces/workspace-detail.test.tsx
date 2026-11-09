import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  noProjects,
  renderApp,
  session,
  USER,
  type MockReply,
  type RecordedRequest,
} from '../../test/mock-api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const DETAIL = `GET /api/v1/workspaces/${WS_ID}`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const PROJECTS = `GET /api/v1/workspaces/${WS_ID}/projects`;
const SETTINGS = `GET /api/v1/workspaces/${WS_ID}/settings`;
const MEMBERS_PAGE = `/workspaces/${WS_ID}/members`;
const settingsReply = (description: string | null = 'Our platform team'): MockReply => ({
  status: 200,
  body: {
    data: {
      settings: {
        id: WS_ID,
        name: 'Platform Team',
        description,
        createdAt: '2026-10-18T10:08:19.107Z',
        updatedAt: '2026-10-18T10:08:19.107Z',
      },
      membership: { role: 'OWNER' },
    },
  },
});

const detail = (role: 'OWNER' | 'MEMBER' = 'OWNER'): MockReply => ({
  status: 200,
  body: {
    data: {
      workspace: { id: WS_ID, name: 'Platform Team', createdAt: '2026-10-18T10:08:19.107Z' },
      membership: { role },
    },
  },
});

const member = (n: number, role: 'OWNER' | 'MEMBER' = 'MEMBER', userId = `user-${n}`) => ({
  userId,
  email: `member${n}@example.com`,
  role,
  joinedAt: '2026-10-18T11:00:00.000Z',
});

const members = (
  items: ReturnType<typeof member>[],
  nextCursor: string | null = null,
): MockReply => ({
  status: 200,
  body: { data: { members: items }, meta: { limit: 20, nextCursor } },
});

const unauthorized = apiError(401, 'UNAUTHORIZED', 'Authentication required');
const notFound = apiError(404, 'NOT_FOUND', 'Workspace not found');
const unavailable = apiError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');

function signedInWith(handlers: Parameters<typeof mockApi>[0]) {
  return mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [PROJECTS]: noProjects,
    [SETTINGS]: settingsReply(),
    // The overview's summary and activity (their failure is shown, not fatal).
    [`GET /api/v1/workspaces/${WS_ID}/dashboard`]: apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    ...handlers,
  });
}

describe('workspace detail page', () => {
  it('opens from the workspace list', async () => {
    signedInWith({
      'GET /api/v1/workspaces': {
        status: 200,
        body: {
          data: {
            workspaces: [
              {
                id: WS_ID,
                name: 'Platform Team',
                createdAt: '2026-10-18T10:08:19.107Z',
                role: 'OWNER',
              },
            ],
          },
          meta: { limit: 20, nextCursor: null },
        },
      },
      [DETAIL]: detail(),
      [MEMBERS]: members([member(1, 'OWNER', USER.id)]),
    });
    const { router } = renderApp('/workspaces');

    // First render of the route tree in this file: allow for a cold start under full-suite load.
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'Platform Team' }, { timeout: 5000 }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform Team' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/workspaces/${WS_ID}`);
  });

  it('shows loading, then a summary: header, description, projects and members', async () => {
    const pending = deferred<MockReply>();
    signedInWith({
      [DETAIL]: () => pending.promise,
      [MEMBERS]: members([member(1, 'OWNER', USER.id), member(2)]),
    });
    renderApp(`/workspaces/${WS_ID}`);

    expect(await screen.findByText('Loading workspace…')).toBeInTheDocument();
    pending.resolve(detail('OWNER'));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Platform Team' });
    const header = heading.closest('header')!;
    expect(header).toHaveTextContent('Your role: Owner');
    expect(header).toHaveTextContent(/Created/);
    expect(within(header).getByText(/2026/).closest('time')).toHaveAttribute(
      'dateTime',
      '2026-10-18T10:08:19.107Z',
    );
    // The description from the workspace settings.
    expect(await screen.findByText('Our platform team')).toBeInTheDocument();
    expect(
      await screen.findByText('No projects yet. Create the first one on the Projects page.'),
    ).toBeInTheDocument();
    const preview = await screen.findByRole('list', { name: 'Members preview' });
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('member1@example.com'),
      expect.stringContaining('member2@example.com'),
    ]);
    expect(screen.getByRole('link', { name: 'Manage →' })).toHaveAttribute('href', MEMBERS_PAGE);
    expect(document.title).toBe('Platform Team · Trackify');
  });

  it('lists the members with roles and join dates on the Members page', async () => {
    const api = signedInWith({
      [DETAIL]: detail('OWNER'),
      [MEMBERS]: members([member(1, 'OWNER', USER.id), member(2)]),
    });
    renderApp(MEMBERS_PAGE);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Members' }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Members' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(/member1@example\.com\s*\(you\).*Joined.*Owner/);
    expect(rows[1]).toHaveTextContent(/member2@example\.com.*Member/);
    expect(rows[1]).not.toHaveTextContent('(you)');
    expect(api.to(MEMBERS).some((r) => r.query.get('limit') === '20')).toBe(true);
  });

  it('says when there is no description, with a link to Settings for owners', async () => {
    signedInWith({
      [DETAIL]: detail('OWNER'),
      [SETTINGS]: settingsReply(null),
      [MEMBERS]: members([member(1, 'OWNER', USER.id)]),
    });
    renderApp(`/workspaces/${WS_ID}`);
    expect(await screen.findByText(/No description yet\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add one in Settings' })).toHaveAttribute(
      'href',
      `/workspaces/${WS_ID}/settings`,
    );
  });

  it('does not offer member management that does not exist', async () => {
    signedInWith({ [DETAIL]: detail(), [MEMBERS]: members([member(1, 'OWNER', USER.id)]) });
    renderApp(MEMBERS_PAGE);

    await screen.findByRole('list', { name: 'Members' });
    expect(
      screen.queryByRole('button', { name: /invite|add|remove|edit|delete|role/i }),
    ).not.toBeInTheDocument();
  });

  it('pages through members with the cursor', async () => {
    const api = signedInWith({
      [DETAIL]: detail(),
      [MEMBERS]: (request: RecordedRequest) =>
        request.query.get('cursor') === 'm-cursor'
          ? members([member(3)])
          : members([member(1, 'OWNER'), member(2)], 'm-cursor'),
    });
    renderApp(MEMBERS_PAGE);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Load more members' }));

    expect(await screen.findByText('member3@example.com')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem'),
    ).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more members' })).not.toBeInTheDocument();
    expect(screen.getByText('Showing 3 members')).toBeInTheDocument();
    expect(api.to(MEMBERS).map((r) => r.query.get('cursor'))).toContain('m-cursor');
  });

  it('sends one request for repeated load-more clicks', async () => {
    const more = deferred<MockReply>();
    const api = signedInWith({
      [DETAIL]: detail(),
      [MEMBERS]: (request: RecordedRequest) =>
        request.query.get('cursor') ? more.promise : members([member(1)], 'next'),
    });
    renderApp(MEMBERS_PAGE);

    const button = await screen.findByRole('button', { name: 'Load more members' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled();
    expect(api.to(MEMBERS).filter((r) => r.query.get('cursor'))).toHaveLength(1);
    more.resolve(members([member(2)]));
    expect(await screen.findByText('member2@example.com')).toBeInTheDocument();
  });

  it.each([
    ['404 (not a member or unknown)', notFound],
    ['400 (malformed id)', apiError(400, 'VALIDATION_ERROR', 'Request validation failed')],
  ])('shows "not found" for %s without loading members', async (_label, reply) => {
    const api = signedInWith({ [DETAIL]: reply });
    renderApp(`/workspaces/${WS_ID}`);

    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
    expect(
      screen.getByText('This workspace doesn’t exist, or you don’t have access to it.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← All workspaces' })).toHaveAttribute(
      'href',
      '/workspaces',
    );
    expect(api.to(MEMBERS)).toHaveLength(0);
  });

  it('shows "no access" for a 403', async () => {
    signedInWith({ [DETAIL]: apiError(403, 'FORBIDDEN', 'You do not have permission') });
    renderApp(`/workspaces/${WS_ID}`);

    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
  });

  it.each([
    ['503', unavailable],
    ['network failure', new TypeError('Failed to fetch')],
  ])('offers a retry on %s and keeps the user signed in', async (_label, failure) => {
    let healthy = false;
    signedInWith({
      [DETAIL]: () => {
        if (healthy) return detail();
        if (failure instanceof Error) throw failure;
        return failure;
      },
      [MEMBERS]: members([member(1, 'OWNER', USER.id)]),
    });
    const { router } = renderApp(`/workspaces/${WS_ID}`);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load this workspace. Please try again.');
    expect(router.state.location.pathname).toBe(`/workspaces/${WS_ID}`);

    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform Team' }),
    ).toBeInTheDocument();
  });

  it('shows a members error with retry while keeping the workspace visible', async () => {
    let healthy = false;
    signedInWith({
      [DETAIL]: detail(),
      [MEMBERS]: () => (healthy ? members([member(1)]) : unavailable),
    });
    renderApp(MEMBERS_PAGE);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load the members of this workspace.');
    expect(screen.getByRole('heading', { level: 1, name: 'Members' })).toBeInTheDocument();

    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('member1@example.com')).toBeInTheDocument();
  });

  it('redirects to sign-in on 401 and returns to the same workspace afterwards', async () => {
    let signedInAgain = false;
    const api = signedInWith({
      [DETAIL]: () => (signedInAgain ? detail() : unauthorized),
      [MEMBERS]: members([member(1, 'OWNER', USER.id)]),
      'POST /api/v1/auth/login': () => {
        signedInAgain = true;
        return session('csrf-2');
      },
    });
    const { router } = renderApp(`/workspaces/${WS_ID}`);

    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform Team' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workspaces/${WS_ID}`));
    expect(api.unmatched).toEqual([]);
  });

  it('treats a 401 from the member list as session expiry too', async () => {
    signedInWith({ [DETAIL]: detail(), [MEMBERS]: unauthorized });
    const { router } = renderApp(MEMBERS_PAGE);

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  renderApp,
  session,
  type MockReply,
  type RecordedRequest,
} from '../../test/mock-api';

const LIST = 'GET /api/v1/workspaces';
const CREATE = 'POST /api/v1/workspaces';

const ws = (n: number, role: 'OWNER' | 'MEMBER' = 'OWNER') => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  name: `Workspace ${n}`,
  createdAt: '2026-10-18T10:08:19.107Z',
  role,
});

const page = (items: ReturnType<typeof ws>[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { workspaces: items }, meta: { limit: 20, nextCursor } },
});

const unauthorized = apiError(401, 'UNAUTHORIZED', 'Authentication required');
const unavailable = apiError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');

function signedInWith(handlers: Parameters<typeof mockApi>[0]) {
  return mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), ...handlers });
}

const list = () => within(screen.getByRole('list'));

describe('workspaces page', () => {
  it('is only reachable when signed in', async () => {
    const api = mockApi();
    const { router } = renderApp('/workspaces');

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(api.to(LIST)).toHaveLength(0);
  });

  it('shows a loading state, then the workspaces with role and creation date', async () => {
    const pending = deferred<MockReply>();
    const api = signedInWith({ [LIST]: () => pending.promise });
    renderApp('/workspaces');

    expect(await screen.findByText('Loading workspaces…')).toBeInTheDocument();
    pending.resolve(page([ws(2), ws(1, 'MEMBER')]));

    expect(await screen.findByText('Workspace 2')).toBeInTheDocument();
    const items = list().getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/Workspace 2.*Created.*Your role: Owner/);
    expect(items[1]).toHaveTextContent(/Workspace 1.*Your role: Member/);
    expect(within(items[0]!).getByText(/2026/).closest('time')).toHaveAttribute(
      'dateTime',
      '2026-10-18T10:08:19.107Z',
    );

    const [request] = api.to(LIST);
    expect(request!.query.get('limit')).toBe('20');
    expect(request!.query.has('cursor')).toBe(false);
    expect(request!.credentials).toBe('include');
    expect(request!.headers.has('X-CSRF-Token')).toBe(false);
  });

  it('shows an empty state whose action focuses the create form', async () => {
    signedInWith({ [LIST]: page([]) });
    renderApp('/workspaces');

    expect(await screen.findByText('You’re not in any workspaces yet')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create a workspace' }));

    expect(screen.getByLabelText('Workspace name')).toHaveFocus();
  });

  it('loads more pages with the cursor and stops on the last page', async () => {
    const api = signedInWith({
      [LIST]: (request: RecordedRequest) =>
        request.query.get('cursor') === 'cursor-1'
          ? page([ws(1)])
          : page([ws(3), ws(2)], 'cursor-1'),
    });
    renderApp('/workspaces');
    const user = userEvent.setup();

    await screen.findByText('Workspace 3');
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Workspace 1')).toBeInTheDocument();
    expect(
      list()
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Workspace 3'),
      expect.stringContaining('Workspace 2'),
      expect.stringContaining('Workspace 1'),
    ]);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(api.to(LIST).map((r) => r.query.get('cursor'))).toContain('cursor-1');
    expect(screen.getByText('Showing 3 workspaces')).toBeInTheDocument();
  });

  it('sends one request for repeated load-more clicks and shows progress', async () => {
    const more = deferred<MockReply>();
    const api = signedInWith({
      [LIST]: (request: RecordedRequest) =>
        request.query.get('cursor') ? more.promise : page([ws(2)], 'cursor-1'),
    });
    renderApp('/workspaces');

    const button = await screen.findByRole('button', { name: 'Load more' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled();
    expect(api.to(LIST).filter((r) => r.query.get('cursor'))).toHaveLength(1);
    more.resolve(page([ws(1)]));
    expect(await screen.findByText('Workspace 1')).toBeInTheDocument();
  });

  it('keeps loaded items and allows retry when loading more fails', async () => {
    let failMore = true;
    signedInWith({
      [LIST]: (request: RecordedRequest) => {
        if (!request.query.get('cursor')) return page([ws(2)], 'cursor-1');
        if (failMore) {
          failMore = false;
          return unavailable;
        }
        return page([ws(1)]);
      },
    });
    renderApp('/workspaces');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t load your workspaces');
    expect(screen.getByText('Workspace 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Workspace 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['503', unavailable],
    ['network failure', new TypeError('Failed to fetch')],
  ])('shows an error with retry on %s (without signing out)', async (_label, failure) => {
    // State-based, not order-based: StrictMode mounts the page twice in tests.
    let healthy = false;
    const api = signedInWith({
      [LIST]: () => {
        if (healthy) return page([ws(1)]);
        if (failure instanceof Error) throw failure;
        return failure;
      },
    });
    const { router } = renderApp('/workspaces');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load your workspaces. Please try again.');
    expect(router.state.location.pathname).toBe('/workspaces');

    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Workspace 1')).toBeInTheDocument();
    expect(api.to(LIST).length).toBeGreaterThanOrEqual(2);
  });

  it('treats 401 as an expired session: redirects to sign-in and returns here afterwards', async () => {
    let signedInAgain = false;
    const api = signedInWith({
      [LIST]: () => (signedInAgain ? page([ws(1)]) : unauthorized),
      'POST /api/v1/auth/login': () => {
        signedInAgain = true;
        return session('csrf-2');
      },
    });
    const { router } = renderApp('/workspaces');

    expect(await screen.findByRole('heading', { name: 'Sign in to Trackify' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Workspace 1')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/workspaces');
    expect(api.unmatched).toEqual([]);
  });
});

describe('creating a workspace from the page', () => {
  const created = (name: string): MockReply => ({
    status: 201,
    body: {
      data: {
        workspace: {
          id: '00000000-0000-7000-8000-0000000000ff',
          name,
          createdAt: '2026-10-18T11:00:00.000Z',
        },
        membership: { role: 'OWNER' },
      },
    },
  });

  it('creates with the CSRF token and shows the new workspace first', async () => {
    const api = signedInWith({ [LIST]: page([ws(1)]), [CREATE]: created('Platform Team') });
    renderApp('/workspaces');
    const user = userEvent.setup();
    await screen.findByText('Workspace 1');

    await user.type(screen.getByLabelText('Workspace name'), '  Platform Team ');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByText('Workspace “Platform Team” created.')).toBeInTheDocument();
    expect(list().getAllByRole('listitem')[0]).toHaveTextContent(/Platform Team.*Owner/);
    expect(screen.getByLabelText('Workspace name')).toHaveValue('');
    const [request] = api.to(CREATE);
    expect(request!.body).toEqual({ name: 'Platform Team' });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('replaces the empty state with the first workspace', async () => {
    signedInWith({ [LIST]: page([]), [CREATE]: created('First') });
    renderApp('/workspaces');
    const user = userEvent.setup();
    await screen.findByText('You’re not in any workspaces yet');

    await user.type(screen.getByLabelText('Workspace name'), 'First');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await within(await screen.findByRole('list')).findByText('First')).toBeInTheDocument();
    expect(screen.queryByText('You’re not in any workspaces yet')).not.toBeInTheDocument();
  });

  it.each([
    ['empty', '   ', 'Name is required'],
    ['too long', 'x'.repeat(101), 'Name must be at most 100 characters'],
  ])('validates a %s name before calling the API', async (_label, value, message) => {
    const api = signedInWith({ [LIST]: page([]) });
    renderApp('/workspaces');
    const user = userEvent.setup();
    await screen.findByText('You’re not in any workspaces yet');

    const input = screen.getByLabelText('Workspace name');
    if (value.trim()) await user.type(input, value);
    else await user.type(input, value);
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(input).toHaveAccessibleDescription(message);
    expect(input).toHaveFocus();
    expect(api.to(CREATE)).toHaveLength(0);
  });

  it('shows the server’s field error', async () => {
    signedInWith({
      [LIST]: page([]),
      [CREATE]: apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [
        { location: 'body', path: 'name', message: 'Name must not contain control characters' },
      ]),
    });
    renderApp('/workspaces');
    const user = userEvent.setup();
    await screen.findByText('You’re not in any workspaces yet');

    await user.type(screen.getByLabelText('Workspace name'), 'Team');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Workspace name')).toHaveAccessibleDescription(
        'Name must not contain control characters',
      ),
    );
  });

  it('explains an outage without adding anything to the list', async () => {
    signedInWith({ [LIST]: page([]), [CREATE]: unavailable });
    renderApp('/workspaces');
    const user = userEvent.setup();
    await screen.findByText('You’re not in any workspaces yet');

    await user.type(screen.getByLabelText('Workspace name'), 'Team');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByText('You’re not in any workspaces yet')).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('shows a Workspaces link only when signed in', async () => {
    signedInWith({ [LIST]: page([]) });
    renderApp('/account');

    const header = within(await screen.findByRole('banner'));
    expect(await header.findByRole('link', { name: 'Workspaces' })).toHaveAttribute(
      'href',
      '/workspaces',
    );
  });
});

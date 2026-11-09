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
} from '../../test/mock-api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const DETAIL = `GET /api/v1/workspaces/${WS_ID}`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const PROJECTS = `GET /api/v1/workspaces/${WS_ID}/projects`;
const GRACE = '01a14e7b-cea3-700d-aeda-0000000000a1';
const COOWNER = '01a14e7b-cea3-700d-aeda-0000000000a3';
const ROLE_GRACE = `PATCH /api/v1/workspaces/${WS_ID}/members/${GRACE}/role`;
const ROLE_COOWNER = `PATCH /api/v1/workspaces/${WS_ID}/members/${COOWNER}/role`;

type Handler = NonNullable<Parameters<typeof mockApi>[0]>[string];

const detail = (role: 'OWNER' | 'MEMBER'): MockReply => ({
  status: 200,
  body: {
    data: {
      workspace: { id: WS_ID, name: 'Platform Team', createdAt: '2026-10-18T10:00:00.000Z' },
      membership: { role },
    },
  },
});
const member = (userId: string, email: string, role: 'OWNER' | 'MEMBER') => ({
  userId,
  email,
  role,
  joinedAt: '2026-10-18T11:00:00.000Z',
});
const members = (viewerRole: 'OWNER' | 'MEMBER'): MockReply => ({
  status: 200,
  body: {
    data: {
      members: [
        member(USER.id, USER.email, viewerRole),
        member(COOWNER, 'coowner@example.com', 'OWNER'),
        member(GRACE, 'grace@example.com', 'MEMBER'),
      ],
    },
    meta: { limit: 20, nextCursor: null },
  },
});
const roleChanged = (userId: string, role: 'OWNER' | 'MEMBER', changed = true): MockReply => ({
  status: 200,
  body: { data: { member: { userId, role }, changed } },
});

async function open(viewerRole: 'OWNER' | 'MEMBER', handlers: Record<string, Handler> = {}) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [DETAIL]: detail(viewerRole),
    [MEMBERS]: members(viewerRole),
    [PROJECTS]: noProjects,
    ...handlers,
  });
  const view = renderApp(`/workspaces/${WS_ID}/members`);
  await screen.findByRole('list', { name: 'Members' }, { timeout: 5000 });
  return { api, ...view };
}

const rowOf = (email: string) =>
  within(screen.getByRole('list', { name: 'Members' }))
    .getByText(email)
    .closest('li')!;

describe('role controls', () => {
  it('owners see "Make owner" on members and "Make member" on other owners, never on themselves', async () => {
    await open('OWNER');

    expect(
      within(rowOf('grace@example.com')).getByRole('button', {
        name: 'Make grace@example.com an owner',
      }),
    ).toBeInTheDocument();
    expect(
      within(rowOf('coowner@example.com')).getByRole('button', {
        name: 'Make coowner@example.com a member',
      }),
    ).toBeInTheDocument();
    expect(within(rowOf(USER.email)).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/A workspace must always keep at least one owner/)).toBeInTheDocument();
  });

  it('regular members see roles as read-only text', async () => {
    await open('MEMBER');

    const list = screen.getByRole('list', { name: 'Members' });
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(rowOf('coowner@example.com')).getByText('Owner')).toBeInTheDocument();
    expect(within(rowOf('grace@example.com')).getByText('Member')).toBeInTheDocument();
    expect(screen.queryByText(/As an owner you can change roles/)).not.toBeInTheDocument();
  });
});

describe('promoting', () => {
  it('asks for confirmation, sends PATCH { role: OWNER } with CSRF, and updates the row', async () => {
    const { api } = await open('OWNER', { [ROLE_GRACE]: roleChanged(GRACE, 'OWNER') });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Make grace@example.com an owner' }));
    const group = screen.getByRole('group', { name: 'Confirm role change for grace@example.com' });
    expect(group).toHaveTextContent('Make grace@example.com an owner of Platform Team?');
    expect(api.to(ROLE_GRACE)).toHaveLength(0);

    await user.click(within(group).getByRole('button', { name: 'Make owner' }));

    expect(
      await screen.findByText('grace@example.com is now an owner of Platform Team.'),
    ).toBeInTheDocument();
    expect(within(rowOf('grace@example.com')).getByText('Owner')).toBeInTheDocument();
    // An owner row offers demotion and no longer offers removal.
    expect(
      within(rowOf('grace@example.com')).getByRole('button', {
        name: 'Make grace@example.com a member',
      }),
    ).toBeInTheDocument();
    expect(
      within(rowOf('grace@example.com')).queryByRole('button', { name: /^Remove/ }),
    ).not.toBeInTheDocument();
    const [request] = api.to(ROLE_GRACE);
    expect(request!.body).toEqual({ role: 'OWNER' });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });
});

describe('demoting', () => {
  it('requires confirmation that explains the at-least-one-owner rule; Cancel aborts', async () => {
    const { api } = await open('OWNER', { [ROLE_COOWNER]: roleChanged(COOWNER, 'MEMBER') });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Make coowner@example.com a member' }));
    const group = screen.getByRole('group', {
      name: 'Confirm role change for coowner@example.com',
    });

    expect(group).toHaveTextContent('They will lose owner permissions.');
    expect(group).toHaveTextContent('A workspace must always keep at least one owner.');
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(api.to(ROLE_COOWNER)).toHaveLength(0);
    expect(within(rowOf('coowner@example.com')).getByText('Owner')).toBeInTheDocument();
  });

  it('demotes after confirmation and updates the list', async () => {
    const { api } = await open('OWNER', { [ROLE_COOWNER]: roleChanged(COOWNER, 'MEMBER') });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Make coowner@example.com a member' }));
    await user.click(screen.getByRole('button', { name: 'Make member' }));

    expect(
      await screen.findByText('coowner@example.com is now a member of Platform Team.'),
    ).toBeInTheDocument();
    expect(within(rowOf('coowner@example.com')).getByText('Member')).toBeInTheDocument();
    expect(api.to(ROLE_COOWNER)[0]!.body).toEqual({ role: 'MEMBER' });
  });

  it('communicates last-owner protection (409) and keeps the role', async () => {
    await open('OWNER', {
      [ROLE_COOWNER]: apiError(409, 'CONFLICT', 'A workspace must have at least one owner.'),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Make coowner@example.com a member' }));
    await user.click(screen.getByRole('button', { name: 'Make member' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A workspace must have at least one owner.',
    );
    expect(within(rowOf('coowner@example.com')).getByText('Owner')).toBeInTheDocument();
  });
});

describe('pending, idempotent and failure states', () => {
  it('disables every member action while a change is pending and sends one request', async () => {
    const pending = deferred<MockReply>();
    const { api } = await open('OWNER', { [ROLE_GRACE]: () => pending.promise });

    fireEvent.click(screen.getByRole('button', { name: 'Make grace@example.com an owner' }));
    const group = screen.getByRole('group', { name: 'Confirm role change for grace@example.com' });
    const confirmButton = within(group).getByRole('button', { name: 'Make owner' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(await within(group).findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(
      within(rowOf('coowner@example.com')).getByRole('button', {
        name: 'Make coowner@example.com a member',
      }),
    ).toBeDisabled();
    expect(api.to(ROLE_GRACE)).toHaveLength(1);

    pending.resolve(roleChanged(GRACE, 'OWNER'));
    await waitFor(() =>
      expect(within(rowOf('grace@example.com')).getByText('Owner')).toBeInTheDocument(),
    );
  });

  it('reports an unchanged role (changed: false) without pretending to change it', async () => {
    await open('OWNER', { [ROLE_GRACE]: roleChanged(GRACE, 'OWNER', false) });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Make grace@example.com an owner' }));
    await user.click(screen.getByRole('button', { name: 'Make owner' }));

    expect(await screen.findByText('grace@example.com is already an owner.')).toBeInTheDocument();
  });

  it.each([
    [apiError(403, 'FORBIDDEN', 'x'), 'Only workspace owners can change roles'],
    [apiError(404, 'NOT_FOUND', 'Member not found'), 'no longer a member of the workspace'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
  ])('keeps the list and shows a safe message on failure (%#)', async (failure, message) => {
    await open('OWNER', {
      [ROLE_GRACE]: () => {
        if (failure instanceof Error) throw failure;
        return failure;
      },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Make grace@example.com an owner' }));
    await user.click(screen.getByRole('button', { name: 'Make owner' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(/prisma|sql|55P03|stack/i);
    expect(within(rowOf('grace@example.com')).getByText('Member')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it('treats a 401 as session expiry (sign-in, then back to the workspace)', async () => {
    const { router } = await open('OWNER', {
      [ROLE_GRACE]: apiError(401, 'UNAUTHORIZED', 'Authentication required'),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Make grace@example.com an owner' }));
    await user.click(screen.getByRole('button', { name: 'Make owner' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect((router.state.location.state as { from?: { pathname: string } }).from?.pathname).toBe(
      `/workspaces/${WS_ID}/members`,
    );
  });
});

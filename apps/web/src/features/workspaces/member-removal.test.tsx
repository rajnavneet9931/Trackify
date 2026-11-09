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
const LINUS = '01a14e7b-cea3-700d-aeda-0000000000a2';
const COOWNER = '01a14e7b-cea3-700d-aeda-0000000000a3';
const DELETE_GRACE = `DELETE /api/v1/workspaces/${WS_ID}/members/${GRACE}`;

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
        member(LINUS, 'linus@example.com', 'MEMBER'),
      ],
    },
    meta: { limit: 20, nextCursor: null },
  },
});
const removed: MockReply = { status: 200, body: { data: { removed: true } } };

async function open(viewerRole: 'OWNER' | 'MEMBER', deleteHandler?: Handler) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [DETAIL]: detail(viewerRole),
    [MEMBERS]: members(viewerRole),
    [PROJECTS]: noProjects,
    ...(deleteHandler && { [DELETE_GRACE]: deleteHandler }),
  });
  const view = renderApp(`/workspaces/${WS_ID}/members`);
  await screen.findByRole('list', { name: 'Members' }, { timeout: 5000 });
  return { api, ...view };
}

const rowOf = (email: string) =>
  within(screen.getByRole('list', { name: 'Members' }))
    .getByText(email)
    .closest('li')!;

async function startRemoving(email: string) {
  const user = userEvent.setup();
  await user.click(within(rowOf(email)).getByRole('button', { name: `Remove ${email}` }));
  return { user, group: screen.getByRole('group', { name: `Confirm removing ${email}` }) };
}

describe('member removal controls', () => {
  it('are offered to owners only for regular members, never for owners or themselves', async () => {
    await open('OWNER');

    expect(
      within(rowOf('grace@example.com')).getByRole('button', { name: 'Remove grace@example.com' }),
    ).toBeInTheDocument();
    expect(
      within(rowOf('linus@example.com')).getByRole('button', { name: 'Remove linus@example.com' }),
    ).toBeInTheDocument();
    // Owner rows offer a role change (Step 12) but never removal.
    expect(
      within(rowOf('coowner@example.com')).queryByRole('button', { name: /^Remove/ }),
    ).not.toBeInTheDocument();
    // Nothing at all on your own row.
    expect(within(rowOf(USER.email)).queryByRole('button')).not.toBeInTheDocument();
  });

  it('are not shown to regular members', async () => {
    await open('MEMBER');
    expect(
      within(screen.getByRole('list', { name: 'Members' })).queryAllByRole('button'),
    ).toHaveLength(0);
  });

  it('never offer owner removal or ownership transfer', async () => {
    await open('OWNER');
    expect(
      screen.queryByRole('button', { name: /Remove coowner|Remove .*owner|transfer/i }),
    ).not.toBeInTheDocument();
  });
});

describe('removing a member', () => {
  it('requires confirmation naming the person and the workspace, and Cancel aborts', async () => {
    const { api } = await open('OWNER', removed);
    const { user, group } = await startRemoving('grace@example.com');

    expect(group).toHaveTextContent('Remove grace@example.com from Platform Team?');
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(api.to(DELETE_GRACE)).toHaveLength(0);

    await user.click(within(group).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(api.to(DELETE_GRACE)).toHaveLength(0);
    expect(rowOf('grace@example.com')).toBeInTheDocument();
  });

  it('sends a DELETE with the CSRF token and removes the row on success', async () => {
    const { api } = await open('OWNER', removed);
    const { user, group } = await startRemoving('grace@example.com');

    await user.click(within(group).getByRole('button', { name: 'Remove member' }));

    expect(
      await screen.findByText('grace@example.com was removed from Platform Team.'),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Members' });
    expect(within(list).queryByText('grace@example.com')).not.toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const [request] = api.to(DELETE_GRACE);
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(request!.body).toBeUndefined();
  });

  it('disables the actions while pending and sends a single request', async () => {
    const pending = deferred<MockReply>();
    const { api } = await open('OWNER', () => pending.promise);
    const { group } = await startRemoving('grace@example.com');
    const confirm = within(group).getByRole('button', { name: 'Remove member' });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(await within(group).findByRole('button', { name: 'Removing…' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(
      within(rowOf('linus@example.com')).getByRole('button', { name: 'Remove linus@example.com' }),
    ).toBeDisabled();
    expect(api.to(DELETE_GRACE)).toHaveLength(1);

    pending.resolve(removed);
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Members' })).queryByText('grace@example.com'),
      ).not.toBeInTheDocument(),
    );
  });

  it.each([
    [
      apiError(409, 'CONFLICT', 'Workspace owners cannot be removed.'),
      'Workspace owners cannot be removed.',
    ],
    [apiError(403, 'FORBIDDEN', 'x'), 'Only workspace owners can remove members.'],
    [apiError(404, 'NOT_FOUND', 'Member not found'), 'no longer a member of the workspace'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
  ])('keeps the list and shows a safe error on failure (%#)', async (failure, message) => {
    await open('OWNER', () => {
      if (failure instanceof Error) throw failure;
      return failure;
    });
    const { user, group } = await startRemoving('grace@example.com');

    await user.click(within(group).getByRole('button', { name: 'Remove member' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(rowOf('grace@example.com')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem'),
    ).toHaveLength(4);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/prisma|sql|stack/i);
  });

  it('treats a 401 as session expiry (sign-in, then back to the workspace)', async () => {
    const { router } = await open(
      'OWNER',
      apiError(401, 'UNAUTHORIZED', 'Authentication required'),
    );
    const { user, group } = await startRemoving('grace@example.com');

    await user.click(within(group).getByRole('button', { name: 'Remove member' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect((router.state.location.state as { from?: { pathname: string } }).from?.pathname).toBe(
      `/workspaces/${WS_ID}/members`,
    );
  });
});

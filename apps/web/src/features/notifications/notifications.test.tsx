import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  renderApp,
  session,
  USER,
  type MockReply,
} from '../../test/mock-api';
import type { AppNotification } from './notifications.api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const PROJECT_ID = '01a14e7b-cea3-700d-aeda-0000000000aa';
const TASK_ID = '01a14e7b-cea3-700d-aeda-0000000000c1';
const GRACE = '01a14e7b-cea3-700d-aeda-0000000000d1';
const LIST = 'GET /api/v1/notifications';
const COUNT = 'GET /api/v1/notifications/unread-count';
const READ_ALL = 'PATCH /api/v1/notifications/read-all';
const id = (n: number) => `01a14e7b-cea3-700d-aeda-${String(n).padStart(12, '0')}`;

const notification = (n: number, extra: Partial<AppNotification> = {}): AppNotification => ({
  id: id(n),
  type: 'TASK_ASSIGNED',
  title: `Title ${n}`,
  message: `Message ${n}`,
  workspaceId: WS_ID,
  resourceType: 'TASK',
  resourceId: TASK_ID,
  actorId: GRACE,
  actor: { id: GRACE, email: 'grace@example.com' },
  isRead: false,
  readAt: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  target: { workspaceId: WS_ID, projectId: PROJECT_ID, taskId: TASK_ID },
  ...extra,
});
const page = (items: AppNotification[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { notifications: items }, meta: { limit: 20, nextCursor } },
});
const count = (unreadCount: number): MockReply => ({
  status: 200,
  body: { data: { unreadCount } },
});

/** A small server: notifications that can be read and deleted, and a matching count. */
function server(initial: AppNotification[]) {
  let items = initial.map((n) => ({ ...n }));
  const unread = () => items.filter((n) => !n.isRead).length;
  const handlers: Record<string, unknown> = {
    'GET /api/v1/auth/me': session('csrf-1'),
    [COUNT]: () => count(unread()),
    [LIST]: (r: { query: URLSearchParams }) => {
      const limit = Number(r.query.get('limit'));
      const list = r.query.get('unreadOnly') === 'true' ? items.filter((n) => !n.isRead) : items;
      return page(list.slice(0, limit));
    },
    [READ_ALL]: () => {
      const updated = unread();
      items = items.map((n) => ({ ...n, isRead: true, readAt: '2026-11-04T12:00:00.000Z' }));
      return { status: 200, body: { data: { updated } } };
    },
  };
  for (const n of initial) {
    handlers[`PATCH /api/v1/notifications/${n.id}/read`] = () => {
      items = items.map((i) =>
        i.id === n.id ? { ...i, isRead: true, readAt: i.readAt ?? '2026-11-04T12:00:00.000Z' } : i,
      );
      const current = items.find((i) => i.id === n.id);
      return current
        ? { status: 200, body: { data: { notification: current } } }
        : apiError(404, 'NOT_FOUND', 'Notification not found');
    };
    handlers[`DELETE /api/v1/notifications/${n.id}`] = () => {
      const before = items.length;
      items = items.filter((i) => i.id !== n.id);
      return items.length < before
        ? { status: 200, body: { data: { deleted: true } } }
        : apiError(404, 'NOT_FOUND', 'Notification not found');
    };
  }
  return handlers as Parameters<typeof mockApi>[0];
}

const bell = () => screen.findByRole('button', { name: /^Notifications/ }, { timeout: 5000 });
const panel = () => within(screen.getByRole('region', { name: 'Notifications' }));

describe('notification bell', () => {
  it('shows the unread count from the server', async () => {
    mockApi(server([notification(1), notification(2), notification(3, { isRead: true })]));
    renderApp('/account');
    await waitFor(
      async () => expect(await bell()).toHaveAccessibleName('Notifications, 2 unread'),
      {
        timeout: 5000,
      },
    );
    expect((await bell()).textContent).toBe('2');
  });

  it('caps the badge at 99+', async () => {
    mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), [COUNT]: count(250) });
    renderApp('/account');
    await waitFor(async () => expect((await bell()).textContent).toBe('99+'), { timeout: 5000 });
  });

  it('is not shown (and asks nothing) when signed out', async () => {
    const api = mockApi();
    renderApp('/');
    const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
    expect(await nav.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(api.to(COUNT)).toEqual([]);
  });

  it('opens a panel with the newest five, read and unread states', async () => {
    const api = mockApi(
      server([
        notification(1, { title: 'Task assigned to you' }),
        notification(2, {
          isRead: true,
          readAt: '2026-11-04T11:00:00.000Z',
          actorId: null,
          actor: null,
        }),
      ]),
    );
    renderApp('/account');
    fireEvent.click(await bell());

    expect(await panel().findByRole('list', { name: 'Latest notifications' })).toBeInTheDocument();
    expect(api.to(LIST).at(-1)!.query.get('limit')).toBe('5');
    const [unread, read] = panel().getAllByRole('listitem');
    expect(unread).toHaveTextContent('Unread: Task assigned to you');
    expect(unread).toHaveTextContent('grace@example.com');
    expect(read).not.toHaveTextContent('Unread');
    expect(read).toHaveTextContent('Trackify'); // a reminder: no person behind it
    expect(within(read!).queryByRole('button', { name: /^Mark as read/ })).not.toBeInTheDocument();
    expect(await bell()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('marks one as read once (with the CSRF token) and refreshes the count', async () => {
    const api = mockApi(server([notification(1), notification(2)]));
    renderApp('/account');
    fireEvent.click(await bell());
    const button = await panel().findByRole('button', { name: 'Mark as read: Message 1' });
    fireEvent.click(button);
    fireEvent.click(button); // ignored while the first request runs

    await waitFor(async () => expect(await bell()).toHaveAccessibleName('Notifications, 1 unread'));
    const requests = api.to(`PATCH /api/v1/notifications/${id(1)}/read`);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(panel().getAllByRole('listitem')[0]).not.toHaveTextContent('Unread');
  });

  it('marks all as read', async () => {
    const api = mockApi(server([notification(1), notification(2)]));
    renderApp('/account');
    fireEvent.click(await bell());
    fireEvent.click(await panel().findByRole('button', { name: 'Mark all as read' }));

    await waitFor(async () => expect(await bell()).toHaveAccessibleName('Notifications'));
    expect(api.to(READ_ALL)).toHaveLength(1);
    expect(panel().queryByText(/Unread:/)).not.toBeInTheDocument();
  });

  it('opens the task, marks it read and closes', async () => {
    const api = mockApi(server([notification(1)]));
    const { router } = renderApp('/account');
    fireEvent.click(await bell());
    fireEvent.click(await panel().findByRole('link', { name: 'Title 1' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`,
      ),
    );
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.to(`PATCH /api/v1/notifications/${id(1)}/read`)).toHaveLength(1),
    );
  });

  it('shows no link for a task that no longer exists', async () => {
    mockApi(server([notification(1, { target: null })]));
    renderApp('/account');
    fireEvent.click(await bell());
    const [item] = await panel().findAllByRole('listitem');
    expect(within(item!).queryByRole('link')).not.toBeInTheDocument();
    expect(item).toHaveTextContent('No longer available');
  });

  it('shows empty and error-with-retry states', async () => {
    let healthy = false;
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [LIST]: () => (healthy ? page([]) : apiError(503, 'SERVICE_UNAVAILABLE', 'x')),
    });
    renderApp('/account');
    fireEvent.click(await bell());
    const alert = await panel().findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load your notifications.');
    healthy = true;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await panel().findByText(/all caught up/)).toBeInTheDocument();
  });

  it('refreshes the count when the window regains focus', async () => {
    let unread = 1;
    const api = mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), [COUNT]: () => count(unread) });
    renderApp('/account');
    await waitFor(
      async () => expect(await bell()).toHaveAccessibleName('Notifications, 1 unread'),
      {
        timeout: 5000,
      },
    );
    unread = 4;
    const before = api.to(COUNT).length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(async () => expect(await bell()).toHaveAccessibleName('Notifications, 4 unread'));
    expect(api.to(COUNT).length).toBeGreaterThan(before);
  });
});

describe('notifications page', () => {
  it('is linked from the bell and lists notifications with Load more', async () => {
    const first = Array.from({ length: 2 }, (_, i) => notification(i + 1));
    mockApi({
      ...server(first),
      [LIST]: (r) =>
        r.query.get('limit') === '5'
          ? page(first)
          : r.query.get('cursor')
            ? page([notification(9, { title: 'Older' })])
            : page(first, 'next'),
    });
    const { router } = renderApp('/account');
    fireEvent.click(await bell());
    fireEvent.click(await panel().findByRole('link', { name: 'View all notifications' }));
    expect(router.state.location.pathname).toBe('/notifications');

    const list = await screen.findByRole('list', { name: 'Notifications' }, { timeout: 5000 });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Load more notifications' }));
    expect(await within(list).findByText('Older')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more notifications' }),
    ).not.toBeInTheDocument();
  });

  it('filters unread only through the URL', async () => {
    const api = mockApi(server([notification(1), notification(2, { isRead: true })]));
    const { router } = renderApp('/notifications');
    await screen.findByRole('list', { name: 'Notifications' }, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /^Unread/ }));

    await waitFor(() => expect(router.state.location.search).toBe('?unread=1'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Notifications' })).getAllByRole('listitem'),
      ).toHaveLength(1),
    );
    expect(api.to(LIST).at(-1)!.query.get('unreadOnly')).toBe('true');
    expect(screen.getByRole('button', { name: /^Unread/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('deletes a notification and updates the count', async () => {
    const api = mockApi(server([notification(1), notification(2)]));
    renderApp('/notifications');
    const list = await screen.findByRole('list', { name: 'Notifications' }, { timeout: 5000 });
    fireEvent.click(within(list).getByRole('button', { name: 'Delete: Message 1' }));

    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(api.to(`DELETE /api/v1/notifications/${id(1)}`)).toHaveLength(1);
    await waitFor(async () => expect(await bell()).toHaveAccessibleName('Notifications, 1 unread'));
  });

  it('marks all as read from the page', async () => {
    mockApi(server([notification(1), notification(2)]));
    renderApp('/notifications');
    const list = await screen.findByRole('list', { name: 'Notifications' }, { timeout: 5000 });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(within(list).queryByText(/Unread:/)).not.toBeInTheDocument());
    await waitFor(async () => expect(await bell()).toHaveAccessibleName('Notifications'));
  });

  it('removes a notification that is gone (404) and says so', async () => {
    mockApi({
      ...server([notification(1)]),
      [`PATCH /api/v1/notifications/${id(1)}/read`]: apiError(404, 'NOT_FOUND', 'x'),
    });
    renderApp('/notifications');
    const list = await screen.findByRole('list', { name: 'Notifications' }, { timeout: 5000 });
    fireEvent.click(within(list).getByRole('button', { name: 'Mark as read: Message 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This notification is no longer available.',
    );
    expect(screen.getByText('No notifications yet.')).toBeInTheDocument();
  });

  it('shows loading, empty and error-with-retry states', async () => {
    const pending = deferred<MockReply>();
    let calls = 0;
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [LIST]: () => {
        calls += 1;
        if (calls <= 2) return pending.promise; // StrictMode mounts twice
        return page([]);
      },
    });
    renderApp('/notifications');
    expect(
      await screen.findByText('Loading notifications…', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    pending.resolve(apiError(503, 'SERVICE_UNAVAILABLE', 'x'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load your notifications.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No notifications yet.')).toBeInTheDocument();
  });

  it('treats a 401 as signed out', async () => {
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [LIST]: apiError(401, 'UNAUTHORIZED', 'x'),
    });
    const { router } = renderApp('/notifications');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'), { timeout: 5000 });
  });

  it('labels the viewer’s own actions as "You"', async () => {
    mockApi(
      server([notification(1, { actorId: USER.id, actor: { id: USER.id, email: USER.email } })]),
    );
    renderApp('/notifications');
    const list = await screen.findByRole('list', { name: 'Notifications' }, { timeout: 5000 });
    expect(within(list).getByText(/^You ·/)).toBeInTheDocument();
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readRecentWorkspaces, rememberWorkspace } from '../lib/recent-workspaces';
import {
  apiError,
  mockApi,
  noProjects,
  renderApp,
  session,
  USER,
  type MockReply,
} from '../test/mock-api';

const WS_A = '01a14e7b-cea3-700d-aeda-0000000000a1';
const WS_B = '01a14e7b-cea3-700d-aeda-0000000000b2';
const WS_GONE = '01a14e7b-cea3-700d-aeda-0000000000c3';
const LIST = 'GET /api/v1/workspaces';

const workspace = (id: string, name: string, role = 'MEMBER') => ({
  id,
  name,
  role,
  createdAt: '2026-10-18T10:00:00.000Z',
});
const list = (items: unknown[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { workspaces: items }, meta: { limit: 100, nextCursor } },
});
const detail = (id: string, name: string, role = 'OWNER'): MockReply => ({
  status: 200,
  body: {
    data: {
      workspace: { id, name, createdAt: '2026-10-18T10:00:00.000Z' },
      membership: { role },
    },
  },
});
const noMembers: MockReply = {
  status: 200,
  body: { data: { members: [] }, meta: { limit: 20, nextCursor: null } },
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('recent workspaces store', () => {
  it('keeps the five most recent, newest first, per user', () => {
    for (const id of ['1', '2', '3', '4', '5', '6', '3']) rememberWorkspace('u1', id);
    expect(readRecentWorkspaces('u1')).toEqual(['3', '6', '5', '4', '2']);
    expect(readRecentWorkspaces('u2')).toEqual([]);
  });

  it('survives broken or blocked storage', () => {
    localStorage.setItem('trackify:recent-workspaces:u1', '{not json');
    expect(readRecentWorkspaces('u1')).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => rememberWorkspace('u1', 'x')).not.toThrow();
    spy.mockRestore();
  });
});

describe('home page (signed in)', () => {
  it('welcomes the user with their workspace count and recently opened workspaces', async () => {
    rememberWorkspace(USER.id, WS_GONE); // deleted or left since: not shown
    rememberWorkspace(USER.id, WS_B);
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [LIST]: list([workspace(WS_A, 'Alpha', 'OWNER'), workspace(WS_B, 'Beta')]),
    });
    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    const summary = within(await screen.findByLabelText('My work summary'));
    expect(summary.getByText('Workspaces').parentElement).toHaveTextContent('2');
    expect(summary.getByRole('link', { name: 'View all workspaces →' })).toHaveAttribute(
      'href',
      '/workspaces',
    );
    const recent = within(screen.getByRole('region', { name: 'Recently opened' }));
    expect(recent.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      `/workspaces/${WS_B}`,
    ]);
    expect(screen.queryByText(/features are on the way/)).not.toBeInTheDocument();
  });

  it('shows "Jump back in" without history and "100+" when there are more', async () => {
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [LIST]: list([workspace(WS_A, 'Alpha')], 'next'),
    });
    renderApp('/');
    expect(await screen.findByRole('region', { name: 'Jump back in' })).toBeInTheDocument();
    expect(screen.getByText('1+')).toBeInTheDocument();
  });

  it('guides users without workspaces and creates one in place', async () => {
    const { router } = (() => {
      mockApi({
        'GET /api/v1/auth/me': session('csrf-1'),
        [LIST]: list([]),
        'POST /api/v1/workspaces': {
          status: 201,
          body: {
            data: {
              workspace: { id: WS_A, name: 'Team', createdAt: '2026-11-05T10:00:00.000Z' },
              membership: { role: 'OWNER' },
            },
          },
        },
        [`GET /api/v1/workspaces/${WS_A}`]: detail(WS_A, 'Team'),
        [`GET /api/v1/workspaces/${WS_A}/projects`]: noProjects,
        [`GET /api/v1/workspaces/${WS_A}/members`]: noMembers,
      });
      return renderApp('/');
    })();
    expect(await screen.findByText('You’re not in any workspace yet')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workspaces/${WS_A}`));
  });

  it('offers a retry when the workspaces can’t be loaded', async () => {
    let healthy = false;
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [LIST]: () => (healthy ? list([]) : apiError(503, 'SERVICE_UNAVAILABLE', 'x')),
    });
    renderApp('/');
    const alert = await screen.findByRole('alert');
    healthy = true;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('You’re not in any workspace yet')).toBeInTheDocument();
  });
});

describe('workspace tabs', () => {
  const openOverview = () => {
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [`GET /api/v1/workspaces/${WS_A}`]: detail(WS_A, 'Alpha'),
      [`GET /api/v1/workspaces/${WS_A}/projects`]: noProjects,
      [`GET /api/v1/workspaces/${WS_A}/members`]: noMembers,
      [`GET /api/v1/workspaces/${WS_A}/dashboard`]: apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
      [`GET /api/v1/workspaces/${WS_A}/settings`]: {
        status: 200,
        body: {
          data: {
            settings: {
              id: WS_A,
              name: 'Alpha',
              description: null,
              createdAt: '2026-10-18T10:00:00.000Z',
              updatedAt: '2026-10-18T10:00:00.000Z',
            },
            membership: { role: 'OWNER' },
          },
        },
      },
    });
    return renderApp(`/workspaces/${WS_A}`);
  };
  const tabs = () => within(screen.getByRole('navigation', { name: 'Workspace' }));
  const current = () =>
    tabs()
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page')
      .map((a) => a.textContent);

  it('are real pages: marks the active one and keeps the workspace context', async () => {
    const { router } = openOverview();
    await screen.findByRole('navigation', { name: 'Workspace' }, { timeout: 5000 });
    expect(
      tabs()
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Dashboard', 'Projects', 'Members', 'Settings']);
    expect(current()).toEqual(['Overview']);

    // Every tab is a real page.
    fireEvent.click(tabs().getByRole('link', { name: 'Members' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Members' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/workspaces/${WS_A}/members`);
    expect(current()).toEqual(['Members']);

    fireEvent.click(tabs().getByRole('link', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(current()).toEqual(['Projects']);

    fireEvent.click(tabs().getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Workspace settings' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/workspaces/${WS_A}/settings`);
    expect(current()).toEqual(['Settings']);

    // Back and forward move between the pages.
    await router.navigate(-1);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/workspaces/${WS_A}/projects`),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    // Breadcrumbs lead back to the workspace.
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'href',
      `/workspaces/${WS_A}`,
    );
  });

  it('remembers the workspace as recently opened', async () => {
    openOverview();
    await screen.findByRole('navigation', { name: 'Workspace' }, { timeout: 5000 });
    await waitFor(() => expect(readRecentWorkspaces(USER.id)).toEqual([WS_A]));
  });
});

describe('global navigation on small screens', () => {
  it('folds the links behind a menu button that closes on navigation', async () => {
    mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), [LIST]: list([]) });
    const { router } = renderApp('/account');
    const button = await screen.findByRole('button', { name: 'Open menu' }, { timeout: 5000 });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('navigation', { name: 'Main' })).toHaveClass('hidden');

    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('navigation', { name: 'Main' })).not.toHaveClass('hidden');

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Workspaces',
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'));
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('toasts', () => {
  it('confirm an action that has no other visible result, and can be dismissed', async () => {
    const id = '01a14e7b-cea3-700d-aeda-000000000001';
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      'GET /api/v1/notifications': {
        status: 200,
        body: {
          data: {
            notifications: [
              {
                id,
                type: 'TASK_ASSIGNED',
                title: 'Task assigned to you',
                message: 'Message 1',
                workspaceId: WS_A,
                resourceType: 'TASK',
                resourceId: WS_B,
                actorId: null,
                actor: null,
                isRead: true,
                readAt: null,
                createdAt: '2026-11-04T10:00:00.000Z',
                target: null,
              },
            ],
          },
          meta: { limit: 20, nextCursor: null },
        },
      },
      [`DELETE /api/v1/notifications/${id}`]: { status: 200, body: { data: { deleted: true } } },
    });
    renderApp('/notifications');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete: Message 1' }, { timeout: 5000 }),
    );
    expect(await screen.findByText('Notification deleted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByText('Notification deleted.')).not.toBeInTheDocument();
  });
});

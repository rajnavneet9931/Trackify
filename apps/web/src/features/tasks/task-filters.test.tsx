import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  mockApi,
  renderApp,
  session,
  USER,
  type MockReply,
  type RecordedRequest,
} from '../../test/mock-api';
import { DEFAULT_VIEW, paramsFromView, queryFromView, viewFromParams } from './task-view';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const PROJECT_ID = '01a14e7b-cea3-700d-aeda-0000000000aa';
const GRACE = '01a14e7b-cea3-700d-aeda-0000000000d1';
const PROJECT = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASKS = `${PROJECT}/tasks`;
const CREATE = `POST /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks`;
const PAGE_URL = `/workspaces/${WS_ID}/projects/${PROJECT_ID}`;

const task = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `01a14e7b-cea3-700d-aeda-${String(n).padStart(12, '0')}`,
  projectId: PROJECT_ID,
  title: `Task ${n}`,
  description: null,
  status: 'TODO',
  priority: 'MEDIUM',
  createdById: USER.id,
  assigneeId: null,
  assignee: null,
  dueDate: null,
  reminderAt: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...extra,
});
const page = (
  tasks: unknown[],
  extra: { nextCursor?: string; total?: number } = {},
): MockReply => ({
  status: 200,
  body: {
    data: { tasks },
    meta: {
      limit: 20,
      nextCursor: extra.nextCursor ?? null,
      ...(extra.total !== undefined && { total: extra.total }),
    },
  },
});

function open(path: string, tasks: (r: RecordedRequest) => MockReply, extra = {}) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [`GET /api/v1/workspaces/${WS_ID}`]: {
      status: 200,
      body: {
        data: {
          workspace: { id: WS_ID, name: 'Team', createdAt: '2026-10-18T10:00:00.000Z' },
          membership: { role: 'MEMBER' },
        },
      },
    },
    [`GET /api/v1/workspaces/${WS_ID}/members`]: {
      status: 200,
      body: {
        data: {
          members: [
            {
              userId: USER.id,
              email: USER.email,
              role: 'OWNER',
              joinedAt: '2026-10-18T10:00:00.000Z',
            },
            {
              userId: GRACE,
              email: 'grace@example.com',
              role: 'MEMBER',
              joinedAt: '2026-10-18T10:00:00.000Z',
            },
          ],
        },
        meta: { limit: 100, nextCursor: null },
      },
    },
    [PROJECT]: {
      status: 200,
      body: {
        data: {
          project: {
            id: PROJECT_ID,
            workspaceId: WS_ID,
            name: 'Website',
            description: null,
            status: 'ACTIVE',
            createdById: USER.id,
            createdAt: '2026-11-01T09:00:00.000Z',
            updatedAt: '2026-11-01T09:00:00.000Z',
          },
          creator: null,
        },
      },
    },
    [TASKS]: tasks,
    ...extra,
  });
  const view = renderApp(path);
  return { api, ...view };
}
const filters = () => within(screen.getByRole('search', { name: 'Filter tasks' }));
const lastQuery = (api: ReturnType<typeof mockApi>) => api.to(TASKS).at(-1)!.query;

describe('task view helpers', () => {
  it('round-trips the view through URL parameters and ignores junk', () => {
    const view = {
      ...DEFAULT_VIEW,
      q: 'login',
      status: 'TODO' as const,
      assignee: 'none',
      sort: 'title' as const,
      order: 'asc' as const,
    };
    expect(viewFromParams(paramsFromView(view))).toEqual(view);
    expect(paramsFromView(DEFAULT_VIEW).toString()).toBe('');
    expect(
      viewFromParams(new URLSearchParams('status=BLOCKED&sort=assignee&assignee=me&due=soon')),
    ).toEqual(DEFAULT_VIEW);
  });

  it('turns "Due today" into the local day’s UTC bounds', () => {
    const now = new Date(2026, 10, 4, 15, 30);
    const query = queryFromView({ ...DEFAULT_VIEW, due: 'today' }, now);
    expect(query.dueAfter).toBe(new Date(2026, 10, 4).toISOString());
    expect(query.dueBefore).toBe(new Date(2026, 10, 5).toISOString());
    const week = queryFromView({ ...DEFAULT_VIEW, due: 'week' }, now);
    expect(new Date(week.dueBefore!).getTime() - new Date(week.dueAfter!).getTime()).toBe(
      7 * 24 * 3_600_000,
    );
  });
});

describe('task filters on the project page', () => {
  it('applies the view from the URL on load (refresh/share) and shows it in the controls', async () => {
    const { api } = open(
      `${PAGE_URL}?q=login&status=TODO&assignee=none&sort=title&order=asc&overdue=1`,
      () => page([task(1)], { total: 1 }),
    );
    await screen.findByRole('list', { name: 'Tasks' }, { timeout: 5000 });
    const query = lastQuery(api);
    expect(Object.fromEntries(query)).toMatchObject({
      search: 'login',
      status: 'TODO',
      unassigned: 'true',
      overdue: 'true',
      sortBy: 'title',
      sortOrder: 'asc',
    });
    expect(filters().getByLabelText('Search')).toHaveValue('login');
    expect(filters().getByLabelText('Status')).toHaveValue('TODO');
    expect(filters().getByLabelText('Assignee')).toHaveValue('none');
    expect(filters().getByLabelText('Overdue only')).toBeChecked();
    expect(screen.getByText('1 matching task')).toBeInTheDocument();
  });

  it('debounces the search, then updates the URL and the list', async () => {
    const { api, router } = open(PAGE_URL, (r) =>
      r.query.get('search') === 'bug'
        ? page([task(7, { title: 'Bug 7' })], { total: 1 })
        : page([task(1)], { total: 1 }),
    );
    await screen.findByText('Task 1', {}, { timeout: 5000 });
    const before = api.to(TASKS).length;

    fireEvent.change(filters().getByLabelText('Search'), { target: { value: 'b' } });
    fireEvent.change(filters().getByLabelText('Search'), { target: { value: 'bu' } });
    fireEvent.change(filters().getByLabelText('Search'), { target: { value: 'bug' } });
    expect(api.to(TASKS)).toHaveLength(before); // nothing yet

    // Debounce + refetch can exceed the 1 s default on a loaded machine.
    expect(await screen.findByText('Bug 7', {}, { timeout: 5000 })).toBeInTheDocument();
    const searches = api
      .to(TASKS)
      .slice(before)
      .map((r) => r.query.get('search'));
    expect(searches.every((s) => s === 'bug')).toBe(true);
    expect(router.state.location.search).toBe('?q=bug');
  });

  it('resets pagination when a filter changes (no cursor, list replaced)', async () => {
    const { api, router } = open(PAGE_URL, (r) => {
      if (r.query.get('priority') === 'HIGH')
        return page([task(9, { title: 'Urgent fix' })], { total: 1 });
      return r.query.get('cursor')
        ? page([task(2)])
        : page([task(1)], { nextCursor: 'c1', total: 2 });
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more tasks' }, { timeout: 5000 }),
    );
    await screen.findByText('Task 2');

    fireEvent.change(filters().getByLabelText('Priority'), { target: { value: 'HIGH' } });

    expect(await screen.findByText('Urgent fix', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('Task 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Task 2')).not.toBeInTheDocument();
    const query = lastQuery(api);
    expect(query.get('priority')).toBe('HIGH');
    expect(query.get('cursor')).toBeNull();
    expect(router.state.location.search).toBe('?priority=HIGH');
  });

  it('maps assignee, due-date, overdue and sort controls to the API query', async () => {
    const { api } = open(PAGE_URL, () => page([task(1)], { total: 1 }));
    await screen.findByText('Task 1', {}, { timeout: 5000 });
    // The filters live in the Filters menu.
    fireEvent.click(filters().getByRole('button', { name: 'Filters' }));
    expect(
      within(filters().getByLabelText('Assignee'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Anyone', 'Unassigned', `${USER.email} (you)`, 'grace@example.com']);

    fireEvent.change(filters().getByLabelText('Assignee'), { target: { value: GRACE } });
    await waitFor(() => expect(lastQuery(api).get('assigneeId')).toBe(GRACE));
    fireEvent.change(filters().getByLabelText('Due date'), { target: { value: 'today' } });
    await waitFor(() => expect(lastQuery(api).get('dueAfter')).not.toBeNull());
    fireEvent.click(filters().getByLabelText('Overdue only'));
    await waitFor(() => expect(lastQuery(api).get('overdue')).toBe('true'));
    fireEvent.change(filters().getByLabelText('Sort by'), { target: { value: 'priority' } });
    fireEvent.change(filters().getByLabelText('Order'), { target: { value: 'asc' } });
    await waitFor(() => expect(lastQuery(api).get('sortOrder')).toBe('asc'));
    expect(Object.fromEntries(lastQuery(api))).toMatchObject({
      assigneeId: GRACE,
      overdue: 'true',
      sortBy: 'priority',
      sortOrder: 'asc',
    });

    // "No due date" turns overdue off (the API refuses the combination).
    fireEvent.change(filters().getByLabelText('Due date'), { target: { value: 'none' } });
    await waitFor(() => expect(lastQuery(api).get('dueDate')).toBe('none'));
    expect(lastQuery(api).get('overdue')).toBeNull();
    expect(filters().getByLabelText('Overdue only')).not.toBeChecked();
  });

  it('clears every filter and the sort with Clear all', async () => {
    const { api, router } = open(`${PAGE_URL}?q=x&status=DONE&sort=title`, () =>
      page([], { total: 0 }),
    );
    expect(
      await screen.findByText('No tasks match these filters.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    fireEvent.click(filters().getByRole('button', { name: 'Clear all filters' }));

    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(filters().getByLabelText('Search')).toHaveValue('');
    expect(Object.fromEntries(lastQuery(api))).toEqual({
      limit: '20',
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    expect(filters().queryByRole('button', { name: 'Clear all filters' })).not.toBeInTheDocument();
  });

  it('shows the total count, and an error with retry', async () => {
    let healthy = false;
    open(PAGE_URL, () =>
      healthy
        ? page([task(1), task(2)], { total: 5, nextCursor: 'c' })
        : apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    );
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    healthy = true;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('5 tasks')).toBeInTheDocument();
  });

  it('does not insert a new task into a filtered list (it may not match)', async () => {
    const { api } = open(
      `${PAGE_URL}?status=DONE`,
      () => page([task(1, { status: 'DONE', title: 'Done one' })], { total: 1 }),
      {
        [CREATE]: { status: 201, body: { data: { task: task(5, { title: 'Brand new' }) } } },
      },
    );
    await screen.findByText('Done one', {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    const form = within(screen.getByRole('region', { name: 'Create a task' }));
    fireEvent.change(form.getByLabelText('Task title'), { target: { value: 'Brand new' } });
    fireEvent.click(form.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(api.to(CREATE)).toHaveLength(1));
    expect(await form.findByText(/created\./)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Brand new' })).not.toBeInTheDocument();
  });
});

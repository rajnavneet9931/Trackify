import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  noActivities,
  noComments,
  renderApp,
  session,
  USER,
  type MockReply,
  type RecordedRequest,
} from '../../test/mock-api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const PROJECT_ID = '01a14e7b-cea3-700d-aeda-0000000000aa';
const TASK_ID = '01a14e7b-cea3-700d-aeda-0000000000cc';
const GRACE = { id: '01a14e7b-cea3-700d-aeda-0000000000d1', email: 'grace@example.com' };
const LINUS = { id: '01a14e7b-cea3-700d-aeda-0000000000d2', email: 'linus@example.com' };
const PROJECT = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASKS = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks`;
const TASK = `${TASKS}/${TASK_ID}`;
const ASSIGN = `PATCH /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}/assignee`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const TASK_PAGE = `/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`;

type Handler = NonNullable<Parameters<typeof mockApi>[0]>[string];

const projectReply = (status = 'ACTIVE'): MockReply => ({
  status: 200,
  body: {
    data: {
      project: {
        id: PROJECT_ID,
        workspaceId: WS_ID,
        name: 'Website Redesign',
        description: null,
        status,
        createdById: USER.id,
        createdAt: '2026-11-01T09:00:00.000Z',
        updatedAt: '2026-11-01T09:00:00.000Z',
      },
      creator: { id: USER.id, email: USER.email },
    },
  },
});
const task = (assignee: { id: string; email: string } | null = null, extra = {}) => ({
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: 'Implement login API',
  description: null,
  status: 'TODO',
  priority: 'HIGH',
  createdById: USER.id,
  assigneeId: assignee?.id ?? null,
  assignee,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T09:30:00.000Z',
  ...extra,
});
const taskReply = (assignee: { id: string; email: string } | null = null): MockReply => ({
  status: 200,
  body: { data: { task: task(assignee), creator: { id: USER.id, email: USER.email } } },
});
const member = (person: { id: string; email: string }, role = 'MEMBER') => ({
  userId: person.id,
  email: person.email,
  role,
  joinedAt: '2026-10-18T10:00:00.000Z',
});
const membersPage = (members: unknown[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { members }, meta: { limit: 100, nextCursor } },
});
const assigned = (assignee: { id: string; email: string } | null): MockReply => ({
  status: 200,
  body: {
    data: { task: task(assignee, { updatedAt: '2026-11-03T12:00:00.000Z' }), changed: true },
  },
});
const allMembers = membersPage([
  member({ id: USER.id, email: USER.email }, 'OWNER'),
  member(GRACE),
  member(LINUS),
]);

function openTask(handlers: Record<string, Handler> = {}) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [PROJECT]: projectReply(),
    [TASK]: taskReply(),
    [`${TASK}/comments`]: noComments,
    [`${TASK}/activities`]: noActivities,
    [MEMBERS]: allMembers,
    ...handlers,
  });
  const view = renderApp(TASK_PAGE);
  return { api, ...view };
}
const panel = () => within(screen.getByRole('region', { name: 'Assignee' }));
const select = () => panel().getByLabelText('Assign to');

describe('task assignee on the task page', () => {
  it('lists only this workspace’s members plus "Unassigned", loading them first', async () => {
    const pending = deferred<MockReply>();
    const { api } = openTask({ [MEMBERS]: () => pending.promise });
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    expect(panel().getByText('Loading members…')).toBeInTheDocument();

    pending.resolve(allMembers);
    await waitFor(() => expect(select()).toBeInTheDocument());

    const options = within(select())
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'Unassigned',
      `${USER.email} (you)`,
      'grace@example.com',
      'linus@example.com',
    ]);
    expect(select()).toHaveValue('');
    expect(api.to(MEMBERS).every((r) => r.path === `/api/v1/workspaces/${WS_ID}/members`)).toBe(
      true,
    );
    // Saves on selection: there is no separate Save button.
    expect(panel().queryByRole('button', { name: 'Save assignee' })).not.toBeInTheDocument();
  });

  it('loads every page of members', async () => {
    openTask({
      [MEMBERS]: (r: RecordedRequest) =>
        r.query.get('cursor') ? membersPage([member(LINUS)]) : membersPage([member(GRACE)], 'next'),
    });
    await waitFor(() =>
      expect(within(select()).getByRole('option', { name: 'linus@example.com' })).toBeTruthy(),
    );
    expect(within(select()).getByRole('option', { name: 'grace@example.com' })).toBeTruthy();
  });

  it('assigns an unassigned task, with the CSRF token, and shows success', async () => {
    const { api } = openTask({ [ASSIGN]: assigned(GRACE) });
    await waitFor(() => expect(select()).toBeInTheDocument());
    const user = userEvent.setup();

    await user.selectOptions(select(), GRACE.id);

    expect(await panel().findByRole('status')).toHaveTextContent(
      'Task assigned to grace@example.com.',
    );
    expect(select()).toHaveValue(GRACE.id);
    const [request] = api.to(ASSIGN);
    expect(request!.body).toEqual({ assigneeId: GRACE.id });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('reassigns an assigned task', async () => {
    const { api } = openTask({ [TASK]: taskReply(GRACE), [ASSIGN]: assigned(LINUS) });
    await waitFor(() => expect(select()).toHaveValue(GRACE.id));
    const user = userEvent.setup();

    await user.selectOptions(select(), LINUS.id);

    expect(await panel().findByRole('status')).toHaveTextContent('assigned to linus@example.com');
    expect(api.to(ASSIGN)[0]!.body).toEqual({ assigneeId: LINUS.id });
  });

  it('unassigns with the Unassigned option (sends null)', async () => {
    const { api } = openTask({ [TASK]: taskReply(GRACE), [ASSIGN]: assigned(null) });
    await waitFor(() => expect(select()).toHaveValue(GRACE.id));
    const user = userEvent.setup();

    await user.selectOptions(select(), '');

    expect(await panel().findByRole('status')).toHaveTextContent('Task unassigned.');
    expect(api.to(ASSIGN)[0]!.body).toEqual({ assigneeId: null });
  });

  it('uses the new version for a later edit (no false conflict)', async () => {
    const { api } = openTask({
      [ASSIGN]: assigned(GRACE),
      [`PATCH /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`]: {
        status: 200,
        body: { data: { task: task(GRACE) } },
      },
    });
    await waitFor(() => expect(select()).toBeInTheDocument());
    const user = userEvent.setup();
    await user.selectOptions(select(), GRACE.id);
    await panel().findByRole('status');

    await user.click(screen.getByRole('button', { name: 'Edit task' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(
        api.requests.find((r) => r.method === 'PATCH' && !r.path.endsWith('/assignee'))?.body,
      ).toMatchObject({ expectedUpdatedAt: '2026-11-03T12:00:00.000Z' }),
    );
  });

  it('keeps an assignee selectable even if they are not in the loaded member list', async () => {
    openTask({ [TASK]: taskReply(LINUS), [MEMBERS]: membersPage([member(GRACE)]) });
    await waitFor(() => expect(select()).toHaveValue(LINUS.id));
  });

  it('shows an empty state when there are no members to list', async () => {
    openTask({ [MEMBERS]: membersPage([]) });
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    expect(await panel().findByText('This workspace has no members to assign yet.')).toBeTruthy();
    expect(
      within(select())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Unassigned']);
  });

  it('shows a retryable error when members cannot be loaded', async () => {
    let healthy = false;
    openTask({
      [MEMBERS]: () => (healthy ? allMembers : apiError(503, 'SERVICE_UNAVAILABLE', 'x')),
    });
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    const alert = await panel().findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load the members of this workspace.');
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(select()).toBeInTheDocument());
  });

  it('saves on selection, disables the control while saving and sends one request', async () => {
    const pending = deferred<MockReply>();
    const { api } = openTask({ [ASSIGN]: () => pending.promise });
    await waitFor(() => expect(select()).toBeInTheDocument());
    fireEvent.change(select(), { target: { value: GRACE.id } });
    fireEvent.change(select(), { target: { value: LINUS.id } }); // ignored while saving

    expect(await panel().findByText('Saving…')).toBeInTheDocument();
    expect(select()).toBeDisabled();
    expect(api.to(ASSIGN)).toHaveLength(1);
    expect(api.to(ASSIGN)[0]!.body).toEqual({ assigneeId: GRACE.id });
    pending.resolve(assigned(GRACE));
    expect(await panel().findByRole('status')).toHaveTextContent('grace@example.com');
  });

  it.each([
    [
      apiError(422, 'UNPROCESSABLE_ENTITY', 'The assignee must be a member of this workspace.'),
      'The assignee must be a member of this workspace.',
    ],
    [
      apiError(
        409,
        'CONFLICT',
        'This project is archived. Its tasks are read-only until it is restored.',
      ),
      'This project is archived.',
    ],
    [apiError(404, 'NOT_FOUND', 'x'), 'This task is no longer available.'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
  ])('reverts to the stored assignee and explains failures safely (%#)', async (reply, message) => {
    openTask({ [ASSIGN]: reply });
    await waitFor(() => expect(select()).toBeInTheDocument());
    const user = userEvent.setup();
    await user.selectOptions(select(), GRACE.id);

    expect(await panel().findByRole('alert')).toHaveTextContent(message);
    expect(select()).toHaveValue(''); // what is actually stored, not the failed choice
  });

  it('treats a 401 as signed out', async () => {
    const { router } = openTask({ [ASSIGN]: apiError(401, 'UNAUTHORIZED', 'x') });
    await waitFor(() => expect(select()).toBeInTheDocument());
    const user = userEvent.setup();
    await user.selectOptions(select(), GRACE.id);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('is read-only in archived projects (no selector, no member request)', async () => {
    const { api } = openTask({ [PROJECT]: projectReply('ARCHIVED'), [TASK]: taskReply(GRACE) });
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    expect(panel().getByText('grace@example.com')).toBeInTheDocument();
    expect(panel().queryByLabelText('Assign to')).not.toBeInTheDocument();
    expect(panel().queryByRole('button')).not.toBeInTheDocument();
    expect(api.to(MEMBERS)).toHaveLength(0);
  });

  it('shows "Unassigned" read-only in archived projects', async () => {
    openTask({ [PROJECT]: projectReply('ARCHIVED') });
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    expect(panel().getByText('Unassigned')).toBeInTheDocument();
  });
});

describe('assignee in the task list', () => {
  it('shows the assignee’s email or "Unassigned"', async () => {
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [`GET /api/v1/workspaces/${WS_ID}`]: {
        status: 200,
        body: {
          data: {
            workspace: { id: WS_ID, name: 'Platform Team', createdAt: '2026-10-18T10:00:00.000Z' },
            membership: { role: 'MEMBER' },
          },
        },
      },
      [PROJECT]: projectReply(),
      [TASKS]: {
        status: 200,
        body: {
          data: {
            tasks: [
              task(GRACE, { id: '01a14e7b-cea3-700d-aeda-000000000101', title: 'Assigned one' }),
              task(null, { id: '01a14e7b-cea3-700d-aeda-000000000102', title: 'Open one' }),
            ],
          },
          meta: { limit: 20, nextCursor: null },
        },
      },
    });
    renderApp(`/workspaces/${WS_ID}/projects/${PROJECT_ID}`);

    const items = within(await screen.findByRole('list', { name: 'Tasks' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('Assigned to grace@example.com');
    expect(items[1]).toHaveTextContent('Unassigned');
  });
});

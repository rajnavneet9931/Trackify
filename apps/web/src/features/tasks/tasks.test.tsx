import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
const OTHER_PROJECT = '01a14e7b-cea3-700d-aeda-0000000000bb';
const TASK_ID = '01a14e7b-cea3-700d-aeda-0000000000cc';
const WORKSPACE = `GET /api/v1/workspaces/${WS_ID}`;
const PROJECT = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASKS = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks`;
const CREATE = `POST /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks`;
const TASK = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`;
const PATCH = `PATCH /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`;
const PROJECT_PAGE = `/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASK_PAGE = `${PROJECT_PAGE}/tasks/${TASK_ID}`;

type Handler = NonNullable<Parameters<typeof mockApi>[0]>[string];

const workspace = (role: 'OWNER' | 'MEMBER'): MockReply => ({
  status: 200,
  body: {
    data: {
      workspace: { id: WS_ID, name: 'Platform Team', createdAt: '2026-10-18T10:00:00.000Z' },
      membership: { role },
    },
  },
});
const projectData = (extra: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  workspaceId: WS_ID,
  name: 'Website Redesign',
  description: null,
  status: 'ACTIVE',
  createdById: USER.id,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  ...extra,
});
const projectReply = (extra: Record<string, unknown> = {}): MockReply => ({
  status: 200,
  body: { data: { project: projectData(extra), creator: { id: USER.id, email: USER.email } } },
});
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
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...extra,
});
const page = (tasks: unknown[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { tasks }, meta: { limit: 20, nextCursor } },
});
const byCursor =
  (pages: Record<string, MockReply>): Handler =>
  (request: RecordedRequest) =>
    pages[request.query.get('cursor') ?? ''] ?? { status: 500 };
const theTask = (extra: Record<string, unknown> = {}) =>
  task(0, {
    id: TASK_ID,
    title: 'Implement login API',
    description: 'Create secure login endpoint\nwith rate limits',
    priority: 'HIGH',
    createdAt: '2026-11-02T08:00:00.000Z',
    updatedAt: '2026-11-02T09:30:00.000Z',
    ...extra,
  });
const taskReply = (
  extra: Record<string, unknown> = {},
  creator: unknown = { id: USER.id, email: USER.email },
): MockReply => ({ status: 200, body: { data: { task: theTask(extra), creator } } });

function signedIn(handlers: Record<string, Handler>) {
  return mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), ...handlers });
}
async function openProject(
  role: 'OWNER' | 'MEMBER',
  tasks: Handler,
  extra: Record<string, Handler> = {},
) {
  const api = signedIn({
    [WORKSPACE]: workspace(role),
    [PROJECT]: projectReply(),
    [TASKS]: tasks,
    ...extra,
  });
  const view = renderApp(PROJECT_PAGE);
  await screen.findByRole('heading', { level: 1, name: 'Website Redesign' });
  return { api, ...view };
}
async function openTask(extra: Record<string, Handler> = {}) {
  const api = signedIn({
    [PROJECT]: projectReply(),
    [TASK]: taskReply(),
    [`${TASK}/comments`]: noComments,
    [`${TASK}/activities`]: noActivities,
    [`GET /api/v1/workspaces/${WS_ID}/members`]: {
      status: 200,
      body: { data: { members: [] }, meta: { limit: 100, nextCursor: null } },
    },
    ...extra,
  });
  const view = renderApp(TASK_PAGE);
  return { api, ...view };
}
const taskList = () => screen.getByRole('list', { name: 'Tasks' });
const taskTitles = () =>
  within(taskList())
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent);
/** The create form, opened with the Tasks section's "Create task" button if needed. */
const createForm = () => {
  if (!screen.queryByRole('region', { name: 'Create a task' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  }
  return within(screen.getByRole('region', { name: 'Create a task' }));
};

describe('task list on the project page', () => {
  it('shows a loading state, then title, description preview, status, priority and date', async () => {
    const pending = deferred<MockReply>();
    await openProject('MEMBER', () => pending.promise);
    expect(screen.getByText('Loading tasks…')).toBeInTheDocument();

    pending.resolve(
      page([
        task(2, {
          title: 'Write docs',
          description: `First line of the description\nSecond line ${'x'.repeat(200)}`,
          status: 'IN_PROGRESS',
          priority: 'URGENT',
          createdAt: '2026-11-02T08:30:00.000Z',
        }),
        task(1),
      ]),
    );

    const items = within(await screen.findByRole('list', { name: 'Tasks' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Write docs');
    expect(items[0]).toHaveTextContent('First line of the description');
    expect(items[0]).not.toHaveTextContent('Second line');
    // In active projects the status is a select in each row (no duplicate badge).
    expect(within(items[0]!).getByRole('combobox', { name: /^Change status of/ })).toHaveValue(
      'IN_PROGRESS',
    );
    expect(items[0]).toHaveTextContent('Priority: Urgent');
    // The table's date column is the due date.
    expect(items[0]).toHaveTextContent('No due date');
    expect(within(items[0]!).getByRole('link', { name: 'Write docs' })).toHaveAttribute(
      'href',
      `${PROJECT_PAGE}/tasks/${task(2).id}`,
    );
  });

  it('shows an empty state', async () => {
    await openProject('MEMBER', page([]));
    expect(await screen.findByText('No tasks yet.')).toBeInTheDocument();
  });

  it('pages across several pages in order without duplicate tasks', async () => {
    const { api } = await openProject(
      'MEMBER',
      byCursor({
        '': page([task(5), task(4)], 'c1'),
        c1: page([task(4), task(3), task(2)], 'c2'), // overlaps: 4 again
        c2: page([task(1)]),
      }),
    );
    await screen.findByRole('list', { name: 'Tasks' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Load more tasks' }));
    await waitFor(() => expect(taskTitles()).toHaveLength(4));
    await user.click(screen.getByRole('button', { name: 'Load more tasks' }));
    await waitFor(() => expect(taskTitles()).toHaveLength(5));

    expect(taskTitles()).toEqual(['Task 5', 'Task 4', 'Task 3', 'Task 2', 'Task 1']);
    expect(screen.queryByRole('button', { name: 'Load more tasks' })).not.toBeInTheDocument();
    expect(
      api
        .to(TASKS)
        .map((r) => r.query.get('cursor'))
        .filter(Boolean),
    ).toEqual(['c1', 'c2']);
  });

  it('sends one load-more request at a time', async () => {
    const more = deferred<MockReply>();
    const { api } = await openProject('MEMBER', (request: RecordedRequest) =>
      request.query.get('cursor') ? more.promise : page([task(2)], 'c1'),
    );
    const button = await screen.findByRole('button', { name: 'Load more tasks' });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled();
    expect(api.to(TASKS).filter((r) => r.query.get('cursor'))).toHaveLength(1);
    more.resolve(page([task(1)]));
    await waitFor(() => expect(taskTitles()).toEqual(['Task 2', 'Task 1']));
  });

  it('retries after a failure', async () => {
    let healthy = false;
    await openProject('MEMBER', () =>
      healthy ? page([task(1)]) : apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load the tasks of this project.');
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(taskTitles()).toEqual(['Task 1']));
  });

  it('treats a 401 as signed out', async () => {
    const { router } = await openProject('MEMBER', apiError(401, 'UNAUTHORIZED', 'x'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('never shows the previous project’s tasks after switching projects', async () => {
    const other = deferred<MockReply>();
    const { router } = await openProject('MEMBER', page([task(1, { title: 'Old project task' })]), {
      [`GET /api/v1/workspaces/${WS_ID}/projects/${OTHER_PROJECT}`]: projectReply({
        id: OTHER_PROJECT,
        name: 'Second Project',
      }),
      [`GET /api/v1/workspaces/${WS_ID}/projects/${OTHER_PROJECT}/tasks`]: () => other.promise,
    });
    await screen.findByText('Old project task');

    await act(() => router.navigate(`/workspaces/${WS_ID}/projects/${OTHER_PROJECT}`));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Second Project' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Old project task')).not.toBeInTheDocument();
    expect(screen.getByText('Loading tasks…')).toBeInTheDocument();
    other.resolve(page([task(9, { title: 'New project task' })]));
    expect(await screen.findByText('New project task')).toBeInTheDocument();
  });
});

describe('creating a task', () => {
  it.each([['OWNER'], ['MEMBER']] as const)(
    'is available to a %s of an active project',
    async (role) => {
      await openProject(role, page([]));
      const open = screen.getByRole('button', { name: 'Create task' });
      expect(open).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('region', { name: 'Create a task' })).not.toBeInTheDocument();
      fireEvent.click(open);
      expect(screen.getByRole('region', { name: 'Create a task' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    },
  );

  it('validates before calling the API', async () => {
    const { api } = await openProject('MEMBER', page([]));
    const user = userEvent.setup();
    await user.type(createForm().getByLabelText('Task title'), '   ');
    await user.click(createForm().getByRole('button', { name: 'Create task' }));

    expect(createForm().getByLabelText('Task title')).toHaveAccessibleDescription(
      'Title is required',
    );
    expect(createForm().getByLabelText('Task title')).toHaveFocus();

    fireEvent.change(createForm().getByLabelText('Task title'), {
      target: { value: 't'.repeat(201) },
    });
    fireEvent.change(createForm().getByLabelText(/Description/), {
      target: { value: 'd'.repeat(5001) },
    });
    await user.click(createForm().getByRole('button', { name: 'Create task' }));
    expect(createForm().getByLabelText('Task title')).toHaveAccessibleDescription(
      'Title must be at most 200 characters',
    );
    expect(createForm().getByLabelText(/Description/)).toHaveAccessibleDescription(
      'Description must be at most 5000 characters',
    );
    expect(api.to(CREATE)).toHaveLength(0);
  });

  it('creates a task with trimmed values and the chosen priority, and lists it first', async () => {
    const { api } = await openProject('MEMBER', page([task(1)]), {
      [CREATE]: {
        status: 201,
        body: { data: { task: task(7, { title: 'Implement login API', priority: 'HIGH' }) } },
      },
    });
    await screen.findByRole('list', { name: 'Tasks' });
    const user = userEvent.setup();

    expect(createForm().getByLabelText('Priority')).toHaveValue('MEDIUM');
    await user.type(createForm().getByLabelText('Task title'), '  Implement login API ');
    await user.type(createForm().getByLabelText(/Description/), ' Secure endpoint ');
    await user.selectOptions(createForm().getByLabelText('Priority'), 'HIGH');
    await user.click(createForm().getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(taskTitles()).toEqual(['Implement login API', 'Task 1']));
    expect(createForm().getByRole('status')).toHaveTextContent('Task Implement login API created.');
    const [request] = api.to(CREATE);
    expect(request!.body).toEqual({
      title: 'Implement login API',
      description: 'Secure endpoint',
      priority: 'HIGH',
    });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(createForm().getByLabelText('Task title')).toHaveValue('');
    expect(createForm().getByLabelText('Priority')).toHaveValue('MEDIUM');
  });

  it('never sends a status and omits an empty description', async () => {
    const { api } = await openProject('MEMBER', page([]), {
      [CREATE]: { status: 201, body: { data: { task: task(7) } } },
    });
    const user = userEvent.setup();
    await user.type(createForm().getByLabelText('Task title'), 'Plain');
    await user.click(createForm().getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(api.to(CREATE)).toHaveLength(1));
    expect(api.to(CREATE)[0]!.body).toEqual({ title: 'Plain', priority: 'MEDIUM' });
  });

  it('shows a pending state and prevents duplicate submissions', async () => {
    const pending = deferred<MockReply>();
    const { api } = await openProject('MEMBER', page([]), { [CREATE]: () => pending.promise });
    await userEvent.setup().type(createForm().getByLabelText('Task title'), 'Once');
    const form = createForm().getByRole('button', { name: 'Create task' }).closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await createForm().findByRole('button', { name: 'Creating task…' })).toBeDisabled();
    expect(createForm().getByLabelText('Task title')).toHaveAttribute('readonly');
    expect(createForm().getByLabelText('Priority')).toBeDisabled();
    expect(api.to(CREATE)).toHaveLength(1);
    pending.resolve({ status: 201, body: { data: { task: task(3, { title: 'Once' }) } } });
    expect(await createForm().findByText(/created\./)).toBeInTheDocument();
  });

  it.each([
    [
      apiError(
        409,
        'CONFLICT',
        'This project is archived. Its tasks are read-only until it is restored.',
      ),
      'This project is archived.',
    ],
    [apiError(404, 'NOT_FOUND', 'x'), 'This project is no longer available.'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
  ])('explains failures safely (%#)', async (reply, message) => {
    await openProject('MEMBER', page([]), { [CREATE]: reply });
    const user = userEvent.setup();
    await user.type(createForm().getByLabelText('Task title'), 'Fails');
    await user.click(createForm().getByRole('button', { name: 'Create task' }));

    expect(await createForm().findByRole('alert')).toHaveTextContent(message);
    expect(createForm().getByLabelText('Task title')).toHaveValue('Fails');
  });

  it('is replaced by a read-only note in archived projects (list still shown)', async () => {
    await openProject('MEMBER', page([task(1)]), {
      [PROJECT]: projectReply({ status: 'ARCHIVED' }),
    });
    expect(
      await screen.findByText('This project is archived, so its tasks are read-only.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Create a task' })).not.toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('keeps project creation and listing working on the Projects page', async () => {
    signedIn({
      [WORKSPACE]: workspace('OWNER'),
      [`GET /api/v1/workspaces/${WS_ID}/members`]: {
        status: 200,
        body: { data: { members: [] }, meta: { limit: 20, nextCursor: null } },
      },
      [`GET /api/v1/workspaces/${WS_ID}/projects`]: {
        status: 200,
        body: {
          data: { projects: [projectData()] },
          meta: { limit: 20, nextCursor: null },
        },
      },
    });
    renderApp(`/workspaces/${WS_ID}/projects`);
    expect(
      await screen.findByRole('link', { name: 'Website Redesign' }, { timeout: 5000 }),
    ).toHaveAttribute('href', PROJECT_PAGE);
    expect(screen.getByRole('heading', { name: 'Create a project' })).toBeInTheDocument();
  });
});

describe('task details page', () => {
  it('opens from the task list with the right IDs', async () => {
    const { api, router } = await openProject('MEMBER', page([theTask()]), {
      [TASK]: taskReply(),
    });
    await userEvent.setup().click(await screen.findByRole('link', { name: 'Implement login API' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Implement login API' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(TASK_PAGE);
    expect(api.to(TASK).length).toBeGreaterThan(0);
  });

  it('shows a loading state, then title, full description, status, priority, creator and dates', async () => {
    const pending = deferred<MockReply>();
    await openTask({ [TASK]: () => pending.promise });
    expect(await screen.findByText('Loading task…')).toBeInTheDocument();
    pending.resolve(taskReply());

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Implement login API' }),
    ).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Task details' });
    expect(details).toHaveTextContent('Create secure login endpoint');
    expect(details).toHaveTextContent('with rate limits');
    expect(screen.getByLabelText('Status')).toHaveDisplayValue('To do');
    expect(screen.getByLabelText('Priority')).toHaveDisplayValue('High');
    expect(screen.getByText(`${USER.email} (you)`)).toBeInTheDocument();
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    expect(
      screen.getByText(format.format(new Date('2026-11-02T08:00:00.000Z'))),
    ).toBeInTheDocument();
    expect(
      screen.getByText(format.format(new Date('2026-11-02T09:30:00.000Z'))),
    ).toBeInTheDocument();
    // Breadcrumbs: Workspaces › workspace › Projects › project › this task.
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Website Redesign' })).toHaveAttribute(
      'href',
      PROJECT_PAGE,
    );
    expect(crumbs.getByText('Implement login API')).toHaveAttribute('aria-current', 'page');
  });

  it('handles an empty description and a creator who left', async () => {
    await openTask({ [TASK]: taskReply({ description: null }, null) });
    expect(await screen.findByText('No description.')).toBeInTheDocument();
    expect(screen.getByText('A former member')).toBeInTheDocument();
  });

  it.each([
    ['an unknown task', { [TASK]: apiError(404, 'NOT_FOUND', 'Task not found') }],
    ['an inaccessible project', { [PROJECT]: apiError(404, 'NOT_FOUND', 'Workspace not found') }],
    ['a malformed ID', { [TASK]: apiError(400, 'VALIDATION_ERROR', 'Invalid') }],
  ])('shows "not found" for %s, with a way back', async (_l, handlers) => {
    await openTask(handlers);
    expect(await screen.findByRole('heading', { name: 'Task not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to project' })).toHaveAttribute(
      'href',
      PROJECT_PAGE,
    );
  });

  it('retries after a server error', async () => {
    let healthy = false;
    await openTask({
      [TASK]: () => (healthy ? taskReply() : apiError(503, 'SERVICE_UNAVAILABLE', 'x')),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load this task.');
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Implement login API' }),
    ).toBeInTheDocument();
  });

  it('treats a 401 as signed out', async () => {
    const { router } = await openTask({ [TASK]: apiError(401, 'UNAUTHORIZED', 'x') });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('is read-only in archived projects', async () => {
    await openTask({ [PROJECT]: projectReply({ status: 'ARCHIVED' }) });
    expect(
      await screen.findByText('This project is archived, so its tasks are read-only.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit task' })).not.toBeInTheDocument();
  });
});

describe('editing a task', () => {
  const openEditor = async (extra: Record<string, Handler> = {}) => {
    const result = await openTask(extra);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Edit task' }));
    return result;
  };
  const form = () => within(screen.getByRole('form', { name: 'Edit task' }));

  it('prefills every field, validates, and saves status and priority with the version seen', async () => {
    const { api } = await openEditor({
      [PATCH]: {
        status: 200,
        body: {
          data: {
            task: theTask({
              title: 'Login API',
              description: null,
              status: 'DONE',
              priority: 'URGENT',
              updatedAt: '2026-11-03T12:00:00.000Z',
            }),
          },
        },
      },
    });
    const user = userEvent.setup();
    expect(form().getByLabelText('Task title')).toHaveValue('Implement login API');
    expect(form().getByLabelText(/Description/)).toHaveValue(
      'Create secure login endpoint\nwith rate limits',
    );
    expect(form().getByLabelText('Status')).toHaveValue('TODO');
    expect(form().getByLabelText('Priority')).toHaveValue('HIGH');

    await user.clear(form().getByLabelText('Task title'));
    await user.click(form().getByRole('button', { name: 'Save changes' }));
    expect(form().getByLabelText('Task title')).toHaveAccessibleDescription('Title is required');
    expect(api.to(PATCH)).toHaveLength(0);

    await user.type(form().getByLabelText('Task title'), ' Login API ');
    await user.clear(form().getByLabelText(/Description/));
    await user.selectOptions(form().getByLabelText('Status'), 'DONE');
    await user.selectOptions(form().getByLabelText('Priority'), 'URGENT');
    await user.click(form().getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Login API' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Task updated.');
    expect(screen.getByLabelText('Status')).toHaveDisplayValue('Done');
    expect(screen.getByLabelText('Priority')).toHaveDisplayValue('Urgent');
    expect(screen.getByText('No description.')).toBeInTheDocument();
    const [request] = api.to(PATCH);
    expect(request!.body).toEqual({
      title: 'Login API',
      description: null,
      status: 'DONE',
      priority: 'URGENT',
      expectedUpdatedAt: '2026-11-02T09:30:00.000Z',
    });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('cancels without saving', async () => {
    const { api } = await openEditor();
    const user = userEvent.setup();
    await user.selectOptions(form().getByLabelText('Status'), 'DONE');
    await user.click(form().getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Status')).toHaveDisplayValue('To do');
    expect(api.to(PATCH)).toHaveLength(0);
  });

  it('disables the form while saving and sends one request', async () => {
    const pending = deferred<MockReply>();
    const { api } = await openEditor({ [PATCH]: () => pending.promise });
    const editForm = screen.getByRole('form', { name: 'Edit task' });

    fireEvent.submit(editForm);
    fireEvent.submit(editForm);

    expect(await form().findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(form().getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(form().getByLabelText('Status')).toBeDisabled();
    expect(form().getByLabelText('Priority')).toBeDisabled();
    expect(api.to(PATCH)).toHaveLength(1);
    pending.resolve({ status: 200, body: { data: { task: theTask() } } });
    expect(await screen.findByText('Task updated.')).toBeInTheDocument();
  });

  it('reports a concurrent change and reloads the latest version', async () => {
    let version = 1;
    await openEditor({
      [TASK]: () => (version === 1 ? taskReply() : taskReply({ status: 'IN_PROGRESS' })),
      [PATCH]: apiError(
        409,
        'CONFLICT',
        'This task was changed by someone else. Reload it to see the latest version.',
      ),
    });
    const user = userEvent.setup();
    await user.click(form().getByRole('button', { name: 'Save changes' }));
    expect(await form().findByRole('alert')).toHaveTextContent('changed by someone else');

    version = 2;
    await user.click(form().getByRole('button', { name: 'Reload task' }));
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveDisplayValue('In progress'));
    expect(screen.queryByRole('form', { name: 'Edit task' })).not.toBeInTheDocument();
  });

  it.each([
    [apiError(404, 'NOT_FOUND', 'x'), 'This task is no longer available.'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
  ])('keeps the form and explains failures safely (%#)', async (reply, message) => {
    await openEditor({ [PATCH]: reply });
    const user = userEvent.setup();
    await user.type(form().getByLabelText('Task title'), '!');
    await user.click(form().getByRole('button', { name: 'Save changes' }));
    expect(await form().findByRole('alert')).toHaveTextContent(message);
    expect(form().getByLabelText('Task title')).toHaveValue('Implement login API!');
  });

  it('shows a server-side status error on the Status control', async () => {
    await openEditor({
      [PATCH]: apiError(400, 'VALIDATION_ERROR', 'Invalid', [
        { path: 'status', message: 'Status must be one of TODO, IN_PROGRESS, DONE' },
      ]),
    });
    await userEvent.setup().click(form().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(form().getByLabelText('Status')).toHaveAccessibleDescription(
        'Status must be one of TODO, IN_PROGRESS, DONE',
      ),
    );
    expect(form().getByLabelText('Status')).toHaveAttribute('aria-invalid', 'true');
  });

  it('treats a 401 while saving as signed out', async () => {
    const { router } = await openEditor({ [PATCH]: apiError(401, 'UNAUTHORIZED', 'x') });
    await userEvent.setup().click(form().getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('deleting a project that has tasks', () => {
  it('shows the API’s explanation and keeps the page', async () => {
    const DELETE = `DELETE /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
    const { router } = await openProject('OWNER', page([task(1)]), {
      [DELETE]: apiError(
        409,
        'CONFLICT',
        'This project still has tasks, so it cannot be deleted. Archive it instead to make it read-only.',
      ),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await user.type(screen.getByLabelText('Type the project name to confirm'), 'Website Redesign');
    await user.click(screen.getByRole('button', { name: 'Delete this project permanently' }));

    expect(await screen.findByText(/still has tasks, so it cannot be deleted/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PROJECT_PAGE);
  });
});

describe('project task workflow', () => {
  const GRACE = '01a14e7b-cea3-700d-aeda-0000000000d1';
  const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
  const membersReply: MockReply = {
    status: 200,
    body: {
      data: {
        members: [
          {
            userId: USER.id,
            name: null,
            email: USER.email,
            role: 'OWNER',
            joinedAt: '2026-10-18T10:00:00.000Z',
          },
          {
            userId: GRACE,
            name: 'Grace',
            email: 'grace@example.com',
            role: 'MEMBER',
            joinedAt: '2026-10-18T10:00:00.000Z',
          },
        ],
      },
      meta: { limit: 100, nextCursor: null },
    },
  };

  it('creates a task with a status and an assignee, and lists it first', async () => {
    const created = task(9, {
      title: 'Launch',
      status: 'IN_PROGRESS',
      priority: 'URGENT',
      assigneeId: GRACE,
      assignee: { id: GRACE, email: 'grace@example.com' },
    });
    const { api } = await openProject('MEMBER', page([task(1)]), {
      [MEMBERS]: membersReply,
      [CREATE]: { status: 201, body: { data: { task: created } } },
    });
    const form = createForm();
    await waitFor(() =>
      expect(within(form.getByLabelText('Assignee')).getAllByRole('option')).toHaveLength(3),
    );
    expect(form.getByLabelText('Status')).toHaveValue('TODO');
    fireEvent.change(form.getByLabelText('Task title'), { target: { value: 'Launch' } });
    fireEvent.change(form.getByLabelText('Status'), { target: { value: 'IN_PROGRESS' } });
    fireEvent.change(form.getByLabelText('Priority'), { target: { value: 'URGENT' } });
    fireEvent.change(form.getByLabelText('Assignee'), { target: { value: GRACE } });
    fireEvent.click(form.getByRole('button', { name: 'Create task' }));

    expect(await form.findByText(/created\./)).toBeInTheDocument();
    expect(api.to(CREATE)[0]!.body).toEqual({
      title: 'Launch',
      priority: 'URGENT',
      status: 'IN_PROGRESS',
      assigneeId: GRACE,
    });
    expect(taskTitles()).toEqual(['Launch', 'Task 1']);
    const row = within(taskList()).getAllByRole('listitem')[0]!;
    expect(row).toHaveTextContent('Assigned to Grace'); // display name from the member list
    // The form is ready for the next task.
    expect(form.getByLabelText('Status')).toHaveValue('TODO');
    expect(form.getByLabelText('Assignee')).toHaveValue('');
  });

  it('shows the server’s refusal of an assignee who left (422)', async () => {
    await openProject('MEMBER', page([]), {
      [MEMBERS]: membersReply,
      [CREATE]: apiError(
        422,
        'UNPROCESSABLE_ENTITY',
        'The assignee must be a member of this workspace.',
      ),
    });
    const form = createForm();
    await waitFor(() =>
      expect(within(form.getByLabelText('Assignee')).getAllByRole('option')).toHaveLength(3),
    );
    fireEvent.change(form.getByLabelText('Task title'), { target: { value: 'X' } });
    fireEvent.change(form.getByLabelText('Assignee'), { target: { value: GRACE } });
    fireEvent.click(form.getByRole('button', { name: 'Create task' }));
    expect(await form.findByRole('alert')).toHaveTextContent(
      'The assignee must be a member of this workspace.',
    );
  });

  it('offers to create the first task from the empty list', async () => {
    await openProject('MEMBER', page([]));
    fireEvent.click(await screen.findByRole('button', { name: 'Create the first task' }));
    expect(screen.getByRole('region', { name: 'Create a task' })).toBeInTheDocument();
  });

  it('changes a task’s status from the list with the version shown', async () => {
    const id = task(1).id;
    const patchUrl = `PATCH /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${id}`;
    const { api } = await openProject('MEMBER', page([task(1)]), {
      [patchUrl]: (r) => ({
        status: 200,
        body: {
          data: {
            task: task(1, {
              status: (r.body as { status: string }).status,
              updatedAt: '2026-11-03T11:00:00.000Z',
            }),
          },
        },
      }),
    });
    const select = await screen.findByLabelText('Change status of Task 1');
    fireEvent.change(select, { target: { value: 'DONE' } });

    await waitFor(() => expect(api.to(patchUrl)).toHaveLength(1));
    expect(api.to(patchUrl)[0]!.body).toEqual({
      status: 'DONE',
      expectedUpdatedAt: '2026-11-03T10:00:00.000Z',
    });
    expect(api.to(patchUrl)[0]!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(await screen.findByText('“Task 1” is now Done.')).toBeInTheDocument();
    expect(screen.getByLabelText('Change status of Task 1')).toHaveValue('DONE');
  });

  it('explains a concurrent change (409) next to the task', async () => {
    const id = task(1).id;
    await openProject('MEMBER', page([task(1)]), {
      [`PATCH /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${id}`]: apiError(
        409,
        'CONFLICT',
        'stale',
      ),
    });
    fireEvent.change(await screen.findByLabelText('Change status of Task 1'), {
      target: { value: 'DONE' },
    });
    expect(await within(taskList()).findByRole('alert')).toHaveTextContent(
      'This task was changed by someone else.',
    );
    expect(screen.getByLabelText('Change status of Task 1')).toHaveValue('TODO');
  });

  it('has no create button or status controls in an archived project', async () => {
    signedIn({
      [WORKSPACE]: workspace('OWNER'),
      [PROJECT]: projectReply({ status: 'ARCHIVED' }),
      [TASKS]: page([task(1)]),
    });
    renderApp(PROJECT_PAGE);
    await screen.findByRole('list', { name: 'Tasks' }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Change status of Task 1')).not.toBeInTheDocument();
  });
});

describe('workspace → project → tasks → create task', () => {
  it('navigates from a project card on the workspace overview to creating a task', async () => {
    const { router } = (() => {
      signedIn({
        [WORKSPACE]: workspace('MEMBER'),
        [`GET /api/v1/workspaces/${WS_ID}/projects`]: {
          status: 200,
          body: { data: { projects: [projectData()] }, meta: { limit: 20, nextCursor: null } },
        },
        [`GET /api/v1/workspaces/${WS_ID}/members`]: {
          status: 200,
          body: { data: { members: [] }, meta: { limit: 100, nextCursor: null } },
        },
        [PROJECT]: projectReply(),
        [TASKS]: page([]),
      });
      return renderApp(`/workspaces/${WS_ID}`);
    })();
    const projects = await screen.findByRole(
      'list',
      { name: 'Recent projects' },
      { timeout: 5000 },
    );
    fireEvent.click(within(projects).getByRole('link', { name: 'Website Redesign' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(PROJECT_PAGE));
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }));
    expect(screen.getByRole('region', { name: 'Create a task' })).toBeInTheDocument();
    // Project pages keep the workspace context, with Projects active.
    const tabs = within(screen.getByRole('navigation', { name: 'Workspace' }));
    expect(tabs.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('audit fixes: page structure and inline task controls', () => {
  it('puts Tasks right after the project header, with project settings and deletion below', async () => {
    await openProject('OWNER', page([task(1)]));
    const tasksHeading = await screen.findByRole('heading', { name: 'Tasks' });
    const settings = screen.getByRole('region', { name: 'Project settings' });
    // DOCUMENT_POSITION_FOLLOWING: settings come after the tasks.
    expect(
      tasksHeading.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(settings).getByRole('button', { name: 'Delete permanently' }),
    ).toBeInTheDocument();
    // The header's main action is editing; deletion is not up there.
    const header = screen
      .getByRole('heading', { level: 1, name: 'Website Redesign' })
      .closest('header')!;
    expect(within(header).getByRole('button', { name: 'Edit project' })).toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    expect(document.title).toBe('Website Redesign · Platform Team · Trackify');
  });

  it('changes status and priority on the task page immediately, with the version shown', async () => {
    let version = '2026-11-02T09:30:00.000Z';
    const { api } = await openTask({
      [PATCH]: (r) => {
        const body = r.body as { status?: string; priority?: string; expectedUpdatedAt: string };
        version = body.expectedUpdatedAt === version ? '2026-11-02T10:00:00.000Z' : version;
        return {
          status: 200,
          body: {
            data: { task: theTask({ ...body, expectedUpdatedAt: undefined, updatedAt: version }) },
          },
        };
      },
    });
    await screen.findByRole(
      'heading',
      { level: 1, name: 'Implement login API' },
      { timeout: 5000 },
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'IN_PROGRESS' } });
    expect(await screen.findByText('Status changed to In progress.')).toBeInTheDocument();
    expect(api.to(PATCH)[0]!.body).toEqual({
      status: 'IN_PROGRESS',
      expectedUpdatedAt: '2026-11-02T09:30:00.000Z',
    });
    expect(screen.getByLabelText('Status')).toHaveValue('IN_PROGRESS');

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'URGENT' } });
    expect(await screen.findByText('Priority changed to Urgent.')).toBeInTheDocument();
    // The second change uses the version returned by the first: no false conflict.
    expect(api.to(PATCH)[1]!.body).toEqual({
      priority: 'URGENT',
      expectedUpdatedAt: '2026-11-02T10:00:00.000Z',
    });
  });

  it('explains a concurrent change on the task page and offers a reload', async () => {
    await openTask({ [PATCH]: apiError(409, 'CONFLICT', 'stale') });
    await screen.findByRole(
      'heading',
      { level: 1, name: 'Implement login API' },
      { timeout: 5000 },
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'DONE' } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This task was changed by someone else.');
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toHaveValue('TODO');
  });
});

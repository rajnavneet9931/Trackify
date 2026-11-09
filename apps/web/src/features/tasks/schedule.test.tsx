import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiError,
  mockApi,
  noActivities,
  noComments,
  renderApp,
  session,
  USER,
  type MockReply,
} from '../../test/mock-api';
import { dueState, fromLocalInputValue, scheduleProblem, toLocalInputValue } from './dates';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const PROJECT_ID = '01a14e7b-cea3-700d-aeda-0000000000aa';
const TASK_ID = '01a14e7b-cea3-700d-aeda-0000000000cc';
const PROJECT = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASKS = `${PROJECT}/tasks`;
const TASK = `${TASKS}/${TASK_ID}`;
const CREATE = `POST /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks`;
const PATCH = `PATCH /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`;

/** "Now" for every test: 4 Nov 2026, 12:00 local time. */
const NOW = new Date(2026, 10, 4, 12, 0, 0);
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

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
const task = (extra: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: 'Launch',
  description: null,
  status: 'TODO',
  priority: 'MEDIUM',
  createdById: USER.id,
  assigneeId: null,
  assignee: null,
  dueDate: null,
  reminderAt: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T09:30:00.000Z',
  ...extra,
});
const taskReply = (extra: Record<string, unknown> = {}, reminder: unknown = null): MockReply => ({
  status: 200,
  body: { data: { task: task(extra), creator: { id: USER.id, email: USER.email }, reminder } },
});
const page = (tasks: unknown[]): MockReply => ({
  status: 200,
  body: { data: { tasks }, meta: { limit: 20, nextCursor: null } },
});
const common = {
  'GET /api/v1/auth/me': session('csrf-1'),
  [`GET /api/v1/workspaces/${WS_ID}`]: apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
  [`GET /api/v1/workspaces/${WS_ID}/members`]: {
    status: 200,
    body: { data: { members: [] }, meta: { limit: 100, nextCursor: null } },
  },
  [`${TASK}/comments`]: noComments,
  [`${TASK}/activities`]: noActivities,
};

describe('date helpers (local time ↔ UTC)', () => {
  it('converts datetime-local values (local time) to UTC ISO and back', () => {
    const iso = fromLocalInputValue('2026-12-01T17:30');
    expect(iso).toBe(new Date(2026, 11, 1, 17, 30).toISOString());
    expect(toLocalInputValue(iso)).toBe('2026-12-01T17:30');
    // The UTC instant differs from the local wall time by exactly the local offset.
    const offsetMinutes = new Date(2026, 11, 1, 17, 30).getTimezoneOffset();
    expect(new Date(iso!).getUTCHours() * 60 + new Date(iso!).getUTCMinutes()).toBe(
      (17 * 60 + 30 + offsetMinutes + 24 * 60) % (24 * 60),
    );
    expect(fromLocalInputValue('')).toBeNull();
    expect(toLocalInputValue(null)).toBe('');
  });

  it('applies the same reminder rules as the API', () => {
    expect(scheduleProblem(null, local(5, 9))).toBe('A reminder requires a due date');
    expect(scheduleProblem(local(5, 9), local(5, 10))).toBe(
      'The reminder cannot be after the due date',
    );
    expect(scheduleProblem(local(5, 9), local(5, 9))).toBeUndefined();
    expect(scheduleProblem(null, null)).toBeUndefined();
  });

  it('classifies overdue, due today and due soon (done tasks never)', () => {
    expect(dueState(local(4, 11), 'TODO')).toBe('overdue');
    expect(dueState(local(4, 18), 'IN_PROGRESS')).toBe('today');
    expect(dueState(local(5, 18), 'TODO')).toBe('soon');
    expect(dueState(local(9, 18), 'TODO')).toBeNull();
    expect(dueState(local(1, 9), 'DONE')).toBeNull();
    expect(dueState(null, 'TODO')).toBeNull();
  });
});

describe('creating a task with a deadline', () => {
  const open = (extra = {}) => {
    const api = mockApi({
      ...common,
      // The project page needs the workspace (name and the viewer's role).
      [`GET /api/v1/workspaces/${WS_ID}`]: {
        status: 200,
        body: {
          data: {
            workspace: { id: WS_ID, name: 'Team', createdAt: '2026-10-18T10:00:00.000Z' },
            membership: { role: 'MEMBER' },
          },
        },
      },
      [PROJECT]: projectReply(),
      [TASKS]: page([]),
      ...extra,
    });
    renderApp(`/workspaces/${WS_ID}/projects/${PROJECT_ID}`);
    return api;
  };
  const form = () => within(screen.getByRole('region', { name: 'Create a task' }));

  it('enables the reminder only once a due date is set, and sends both in UTC', async () => {
    const api = open({ [CREATE]: { status: 201, body: { data: { task: task() } } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }, { timeout: 5000 }));
    expect(form().getByLabelText(/Reminder/)).toBeDisabled();

    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(form().getByLabelText('Task title'), 'Launch');
    fireEvent.change(form().getByLabelText(/Due date/), { target: { value: '2026-12-01T17:00' } });
    expect(form().getByLabelText(/Reminder/)).toBeEnabled();
    fireEvent.change(form().getByLabelText(/Reminder/), { target: { value: '2026-12-01T09:00' } });
    fireEvent.click(form().getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(api.to(CREATE)).toHaveLength(1));
    expect(api.to(CREATE)[0]!.body).toEqual({
      title: 'Launch',
      priority: 'MEDIUM',
      dueDate: new Date(2026, 11, 1, 17, 0).toISOString(),
      reminderAt: new Date(2026, 11, 1, 9, 0).toISOString(),
    });
  });

  it('refuses a reminder after the due date before calling the API', async () => {
    const api = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }, { timeout: 5000 }));
    fireEvent.change(form().getByLabelText('Task title'), { target: { value: 'Launch' } });
    fireEvent.change(form().getByLabelText(/Due date/), { target: { value: '2026-12-01T09:00' } });
    fireEvent.change(form().getByLabelText(/Reminder/), { target: { value: '2026-12-01T10:00' } });
    fireEvent.click(form().getByRole('button', { name: 'Create task' }));

    expect(form().getByLabelText(/Reminder/)).toHaveAccessibleDescription(
      'The reminder cannot be after the due date',
    );
    expect(api.to(CREATE)).toHaveLength(0);
  });

  it('shows the server’s reminder error on the reminder field', async () => {
    open({
      [CREATE]: apiError(400, 'VALIDATION_ERROR', 'Invalid', [
        { location: 'body', path: 'reminderAt', message: 'A reminder requires a due date' },
      ]),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }, { timeout: 5000 }));
    fireEvent.change(form().getByLabelText('Task title'), { target: { value: 'Launch' } });
    fireEvent.click(form().getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(form().getByLabelText(/Reminder/)).toHaveAccessibleDescription(
        'A reminder requires a due date',
      ),
    );
  });

  it('shows Overdue, Due today and Due soon badges and the due date in the list', async () => {
    open({
      [TASKS]: page([
        task({ id: '01a14e7b-cea3-700d-aeda-000000000001', title: 'Late', dueDate: local(3, 9) }),
        task({
          id: '01a14e7b-cea3-700d-aeda-000000000002',
          title: 'Tonight',
          dueDate: local(4, 20),
        }),
        task({
          id: '01a14e7b-cea3-700d-aeda-000000000003',
          title: 'Tomorrow',
          dueDate: local(5, 9),
        }),
        task({
          id: '01a14e7b-cea3-700d-aeda-000000000004',
          title: 'Done late',
          dueDate: local(1, 9),
          status: 'DONE',
        }),
        task({ id: '01a14e7b-cea3-700d-aeda-000000000005', title: 'No deadline' }),
      ]),
    });
    const items = within(await screen.findByRole('list', { name: 'Tasks' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('Overdue');
    expect(items[1]).toHaveTextContent('Due today');
    expect(items[2]).toHaveTextContent('Due soon');
    expect(items[3]).not.toHaveTextContent(/Overdue|Due today|Due soon/);
    expect(items[4]).not.toHaveTextContent(/Due /);
    expect(items[0]!.querySelectorAll('time')[0]).toHaveAttribute('dateTime', local(3, 9));
  });
});

describe('task page: deadline, reminder status and editing', () => {
  const open = (taskHandler: MockReply, extra = {}, projectStatus = 'ACTIVE') => {
    const api = mockApi({
      ...common,
      [PROJECT]: projectReply(projectStatus),
      [TASK]: taskHandler,
      ...extra,
    });
    renderApp(`/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`);
    return api;
  };
  // Due date and reminder live in the task's properties panel.
  const details = () => within(screen.getByRole('complementary', { name: 'Task properties' }));

  it.each([
    [
      { reminderAt: local(5, 9) },
      { status: 'PENDING', remindAt: local(5, 9), sentAt: null },
      'Reminder scheduled for',
    ],
    [
      { reminderAt: local(4, 9) },
      { status: 'SENT', remindAt: local(4, 9), sentAt: local(4, 9) },
      'Reminder sent',
    ],
    [
      { reminderAt: local(4, 9) },
      { status: 'FAILED', remindAt: local(4, 9), sentAt: null },
      'could not be delivered',
    ],
    [{}, null, 'No reminder'],
  ])('shows the reminder status (%#)', async (extra, reminder, text) => {
    open(taskReply({ dueDate: local(6, 17), ...extra }, reminder));
    await screen.findByRole('heading', { level: 1, name: 'Launch' });
    expect(details().getByText(new RegExp(text))).toBeInTheDocument();
  });

  it('shows the due date in local time with an Overdue badge', async () => {
    open(taskReply({ dueDate: local(3, 17) }));
    await screen.findByRole('heading', { level: 1, name: 'Launch' });
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(
      screen
        .getByRole('complementary', { name: 'Task properties' })
        .querySelector(`time[datetime="${local(3, 17)}"]`),
    ).not.toBeNull();
  });

  it('prefills local times, sends unchanged values exactly, and removes both with null', async () => {
    const api = open(taskReply({ dueDate: local(6, 17), reminderAt: local(6, 9) }), {
      [PATCH]: { status: 200, body: { data: { task: task() } } },
    });
    await screen.findByRole('heading', { level: 1, name: 'Launch' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    const editor = within(screen.getByRole('form', { name: 'Edit task' }));
    expect(editor.getByLabelText(/Due date/)).toHaveValue('2026-11-06T17:00');
    expect(editor.getByLabelText(/Reminder/)).toHaveValue('2026-11-06T09:00');

    fireEvent.click(editor.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.to(PATCH)).toHaveLength(1));
    expect(api.to(PATCH)[0]!.body).toMatchObject({
      dueDate: local(6, 17),
      reminderAt: local(6, 9),
    });
  });

  it('removes the deadline and reminder (null) and refuses a reminder without a due date', async () => {
    const api = open(taskReply({ dueDate: local(6, 17), reminderAt: local(6, 9) }), {
      [PATCH]: { status: 200, body: { data: { task: task() } } },
    });
    await screen.findByRole('heading', { level: 1, name: 'Launch' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    const editor = within(screen.getByRole('form', { name: 'Edit task' }));

    fireEvent.change(editor.getByLabelText(/Due date/), { target: { value: '' } });
    fireEvent.click(editor.getByRole('button', { name: 'Save changes' }));
    expect(editor.getByLabelText(/Reminder/)).toHaveAccessibleDescription(
      'A reminder requires a due date',
    );
    expect(api.to(PATCH)).toHaveLength(0);

    fireEvent.change(editor.getByLabelText(/Reminder/), { target: { value: '' } });
    fireEvent.click(editor.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.to(PATCH)).toHaveLength(1));
    expect(api.to(PATCH)[0]!.body).toMatchObject({ dueDate: null, reminderAt: null });
  });

  it('is read-only in archived projects (values shown, no edit)', async () => {
    open(
      taskReply(
        { dueDate: local(6, 17), reminderAt: local(6, 9) },
        { status: 'CANCELLED', remindAt: local(6, 9), sentAt: null },
      ),
      {},
      'ARCHIVED',
    );
    await screen.findByRole('heading', { level: 1, name: 'Launch' });
    expect(screen.queryByRole('button', { name: 'Edit task' })).not.toBeInTheDocument();
    expect(details().getByText(/was cancelled/)).toBeInTheDocument();
  });
});

describe('reminders page', () => {
  it('now lives in the notification center (/reminders redirects)', async () => {
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      'GET /api/v1/notifications': {
        status: 200,
        body: { data: { notifications: [] }, meta: { limit: 20, nextCursor: null } },
      },
    });
    const { router } = renderApp('/reminders');
    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/notifications');
  });
});

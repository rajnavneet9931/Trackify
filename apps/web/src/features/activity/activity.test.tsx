import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
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
const OTHER_TASK = '01a14e7b-cea3-700d-aeda-0000000000dd';
const ALEX = { id: '01a14e7b-cea3-700d-aeda-0000000000a1', email: 'alex@example.com' };
const SAM = { id: '01a14e7b-cea3-700d-aeda-0000000000a2', email: 'sam@example.com' };
const PROJECT = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASK = `${PROJECT}/tasks/${TASK_ID}`;
const ACTIVITIES = `${TASK}/activities`;
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
const taskReply = (id = TASK_ID, title = 'Implement login API'): MockReply => ({
  status: 200,
  body: {
    data: {
      task: {
        id,
        projectId: PROJECT_ID,
        title,
        description: null,
        status: 'TODO',
        priority: 'MEDIUM',
        createdById: ALEX.id,
        assigneeId: null,
        assignee: null,
        createdAt: '2026-11-02T08:00:00.000Z',
        updatedAt: '2026-11-02T08:00:00.000Z',
      },
      creator: null,
    },
  },
});
let seq = 0;
const entry = (
  details: Record<string, unknown>,
  actor: { id: string; email: string } | null = ALEX,
  extra: Record<string, unknown> = {},
) => ({
  id: `01a14e7b-cea3-700d-aeda-${String(++seq).padStart(12, '0')}`,
  taskId: TASK_ID,
  type: details.type,
  actorId: actor?.id ?? null,
  actor,
  details,
  createdAt: '2026-11-03T10:00:00.000Z',
  ...extra,
});
const page = (activities: unknown[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { activities }, meta: { limit: 20, nextCursor } },
});

function openTask(activities: Handler, extra: Record<string, Handler> = {}) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [`GET /api/v1/workspaces/${WS_ID}`]: apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    [PROJECT]: projectReply(),
    [TASK]: taskReply(),
    [`GET /api/v1/workspaces/${WS_ID}/members`]: {
      status: 200,
      body: { data: { members: [] }, meta: { limit: 100, nextCursor: null } },
    },
    [`${TASK}/comments`]: noComments,
    [ACTIVITIES]: activities,
    ...extra,
  });
  return { api, ...renderApp(TASK_PAGE) };
}
const section = () => within(screen.getByRole('region', { name: 'Activity' }));
const lines = () =>
  within(section().getByRole('list', { name: 'Activity' }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('p')?.textContent);

describe('task activity timeline', () => {
  it('shows a loading state, then readable entries oldest first with timestamps', async () => {
    const pending = deferred<MockReply>();
    openTask(() => pending.promise);
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    expect(section().getByText('Loading activity…')).toBeInTheDocument();

    pending.resolve(
      page([
        entry({ type: 'TASK_CREATED', priority: 'MEDIUM' }),
        entry({ type: 'STATUS_CHANGED', from: 'TODO', to: 'IN_PROGRESS' }),
        entry({ type: 'PRIORITY_CHANGED', from: 'MEDIUM', to: 'HIGH' }),
        entry({ type: 'ASSIGNEE_CHANGED', from: null, to: SAM }),
        entry({ type: 'ASSIGNEE_CHANGED', from: SAM, to: { id: USER.id, email: USER.email } }),
        entry({ type: 'ASSIGNEE_CHANGED', from: SAM, to: null }),
        entry({ type: 'COMMENT_ADDED', commentId: 'c1' }),
        entry({ type: 'COMMENT_EDITED', commentId: 'c1' }, SAM),
        entry({ type: 'COMMENT_DELETED', commentId: 'c1' }, { id: USER.id, email: USER.email }),
      ]),
    );

    await waitFor(() => expect(section().queryByText('Loading activity…')).not.toBeInTheDocument());
    expect(lines()).toEqual([
      'alex@example.com created this task.',
      'alex@example.com changed status from To do to In progress.',
      'alex@example.com changed priority from Medium to High.',
      'alex@example.com assigned this task to sam@example.com.',
      'alex@example.com reassigned this task from sam@example.com to you.',
      'alex@example.com removed the task assignment.',
      'alex@example.com added a comment.',
      'sam@example.com edited a comment.',
      'You deleted a comment.',
    ]);
    const firstTime = section().getAllByRole('listitem')[0]!.querySelector('time');
    expect(firstTime).toHaveAttribute('dateTime', '2026-11-03T10:00:00.000Z');
  });

  it('describes title and description updates', async () => {
    openTask(
      page([
        entry({
          type: 'TASK_UPDATED',
          changedFields: ['title', 'description'],
          title: { from: 'Old', to: 'New' },
        }),
        entry({ type: 'TASK_UPDATED', changedFields: ['description'] }),
      ]),
    );
    await waitFor(() =>
      expect(lines()).toEqual([
        'alex@example.com renamed this task from “Old” to “New” and updated the description.',
        'alex@example.com updated the description.',
      ]),
    );
  });

  it('handles former members, deleted users and member-removal unassignments gracefully', async () => {
    openTask(
      page([
        entry({ type: 'TASK_CREATED', priority: 'LOW' }, null, { actorId: ALEX.id }), // left the workspace
        entry({ type: 'STATUS_CHANGED', from: 'TODO', to: 'DONE' }, null), // account deleted
        entry({
          type: 'ASSIGNEE_CHANGED',
          from: { id: SAM.id, email: null },
          to: null,
          reason: 'MEMBER_REMOVED',
        }),
        entry({ type: 'ASSIGNEE_CHANGED', from: null, to: { id: SAM.id, email: null } }),
        entry({ type: 'STATUS_CHANGED', unavailable: true }),
      ]),
    );
    await waitFor(() =>
      expect(lines()).toEqual([
        'A former member created this task.',
        'A deleted user changed status from To do to Done.',
        'alex@example.com removed a former member from the workspace, which removed the task assignment.',
        'alex@example.com assigned this task to a former member.',
        'alex@example.com changed this task.',
      ]),
    );
  });

  it('shows an empty state', async () => {
    openTask(page([]));
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
  });

  it('shows a retryable error', async () => {
    let healthy = false;
    openTask(() =>
      healthy
        ? page([entry({ type: 'TASK_CREATED', priority: 'LOW' })])
        : apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    );
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    const alert = await section().findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load the activity history.');
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(lines()).toEqual(['alex@example.com created this task.']));
  });

  it('loads more entries in order, without duplicates', async () => {
    const created = entry({ type: 'TASK_CREATED', priority: 'LOW' });
    const status = entry({ type: 'STATUS_CHANGED', from: 'TODO', to: 'DONE' });
    const comment = entry({ type: 'COMMENT_ADDED', commentId: 'c1' });
    const { api } = openTask((r: RecordedRequest) =>
      r.query.get('cursor') === 'p2' ? page([status, comment]) : page([created, status], 'p2'),
    );
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    await userEvent
      .setup()
      .click(await section().findByRole('button', { name: 'Load more activity' }));
    await waitFor(() =>
      expect(lines()).toEqual([
        'alex@example.com created this task.',
        'alex@example.com changed status from To do to Done.',
        'alex@example.com added a comment.',
      ]),
    );
    expect(
      api
        .to(ACTIVITIES)
        .map((r) => r.query.get('cursor'))
        .filter(Boolean),
    ).toEqual(['p2']);
  });

  it('refreshes on demand to show new entries', async () => {
    let entries = [entry({ type: 'TASK_CREATED', priority: 'LOW' })];
    openTask(() => page(entries));
    await waitFor(() => expect(lines()).toHaveLength(1));
    entries = [...entries, entry({ type: 'COMMENT_ADDED', commentId: 'c2' })];
    await userEvent.setup().click(section().getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(lines()).toHaveLength(2));
  });

  it('stays readable in archived projects', async () => {
    openTask(page([entry({ type: 'TASK_CREATED', priority: 'LOW' })]), {
      [PROJECT]: projectReply('ARCHIVED'),
    });
    await waitFor(() => expect(lines()).toEqual(['alex@example.com created this task.']));
  });

  it('never shows another task’s history after navigating', async () => {
    const other = deferred<MockReply>();
    const { router } = openTask(page([entry({ type: 'COMMENT_ADDED', commentId: 'old' })]), {
      [`${PROJECT}/tasks/${OTHER_TASK}`]: taskReply(OTHER_TASK, 'Second task'),
      [`${PROJECT}/tasks/${OTHER_TASK}/comments`]: noComments,
      [`${PROJECT}/tasks/${OTHER_TASK}/activities`]: () => other.promise,
    });
    await waitFor(() => expect(lines()).toEqual(['alex@example.com added a comment.']));

    await act(() =>
      router.navigate(`/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${OTHER_TASK}`),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Second task' }),
    ).toBeInTheDocument();
    expect(section().getByText('Loading activity…')).toBeInTheDocument();
    expect(section().queryByText('alex@example.com added a comment.')).not.toBeInTheDocument();
    other.resolve(page([entry({ type: 'TASK_CREATED', priority: 'HIGH' }, SAM)]));
    await waitFor(() => expect(lines()).toEqual(['sam@example.com created this task.']));
  });

  it('treats a 401 as signed out', async () => {
    const { router } = openTask(apiError(401, 'UNAUTHORIZED', 'x'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

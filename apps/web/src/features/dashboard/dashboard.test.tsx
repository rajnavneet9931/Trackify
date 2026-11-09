import { fireEvent, screen, within } from '@testing-library/react';
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
import type { Dashboard } from './dashboard.api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const WEBSITE = '01a14e7b-cea3-700d-aeda-0000000000aa';
const EMPTY = '01a14e7b-cea3-700d-aeda-0000000000ab';
const TASK = '01a14e7b-cea3-700d-aeda-0000000000c1';
const GRACE = '01a14e7b-cea3-700d-aeda-0000000000d1';
const DASHBOARD = `GET /api/v1/workspaces/${WS_ID}/dashboard`;
const PAGE = `/workspaces/${WS_ID}/dashboard`;

const zero: Dashboard = {
  generatedAt: '2026-11-04T12:00:00.000Z',
  windows: {
    todayStart: '2026-11-04T00:00:00.000Z',
    todayEnd: '2026-11-05T00:00:00.000Z',
    weekEnd: '2026-11-11T12:00:00.000Z',
  },
  tasks: {
    total: 0,
    byStatus: { TODO: 0, IN_PROGRESS: 0, DONE: 0 },
    byPriority: { LOW: 0, MEDIUM: 0, HIGH: 0, URGENT: 0 },
    overdue: 0,
    dueToday: 0,
    dueNext7Days: 0,
  },
  projects: { active: 0, archived: 0, completion: [] },
  myWork: { assigned: 0, pending: 0, overdue: 0, upcoming: 0, tasks: [] },
  recentActivity: [],
};

const full: Dashboard = {
  ...zero,
  tasks: {
    total: 8,
    byStatus: { TODO: 4, IN_PROGRESS: 3, DONE: 1 },
    byPriority: { LOW: 1, MEDIUM: 3, HIGH: 2, URGENT: 2 },
    overdue: 2,
    dueToday: 1,
    dueNext7Days: 3,
  },
  projects: {
    active: 2,
    archived: 1,
    completion: [
      { id: EMPTY, name: 'Empty', totalTasks: 0, doneTasks: 0, completionPercent: 0 },
      { id: WEBSITE, name: 'Website', totalTasks: 8, doneTasks: 1, completionPercent: 12 },
    ],
  },
  myWork: {
    assigned: 3,
    pending: 2,
    overdue: 1,
    upcoming: 1,
    tasks: [
      {
        id: TASK,
        title: 'Fix login',
        status: 'TODO',
        priority: 'HIGH',
        dueDate: '2026-11-03T09:00:00.000Z',
        project: { id: WEBSITE, name: 'Website' },
      },
    ],
  },
  recentActivity: [
    {
      id: 'a1',
      type: 'STATUS_CHANGED',
      createdAt: '2026-11-04T11:00:00.000Z',
      actorId: GRACE,
      actor: { id: GRACE, email: 'grace@example.com' },
      task: { id: TASK, title: 'Fix login' },
      project: { id: WEBSITE, name: 'Website' },
    },
    {
      id: 'a2',
      type: 'COMMENT_ADDED',
      createdAt: '2026-11-04T10:00:00.000Z',
      actorId: USER.id,
      actor: { id: USER.id, email: USER.email },
      task: { id: TASK, title: 'Fix login' },
      project: { id: WEBSITE, name: 'Website' },
    },
    {
      id: 'a3',
      type: 'TASK_CREATED',
      createdAt: '2026-11-04T09:00:00.000Z',
      actorId: '01a14e7b-cea3-700d-aeda-0000000000e9',
      actor: null,
      task: { id: TASK, title: 'Fix login' },
      project: { id: WEBSITE, name: 'Website' },
    },
  ],
};

const reply = (dashboard: Dashboard): MockReply => ({ status: 200, body: { data: { dashboard } } });

function open(handler: MockReply | (() => MockReply | Promise<MockReply>)) {
  const api = mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), [DASHBOARD]: handler });
  return { api, ...renderApp(PAGE) };
}

describe('workspace dashboard page', () => {
  it('shows a loading state, then the summary cards', async () => {
    const pending = deferred<MockReply>();
    open(() => pending.promise);
    expect(await screen.findByText('Loading dashboard…')).toBeInTheDocument();
    pending.resolve(reply(full));

    const summary = within(await screen.findByLabelText('Summary'));
    const card = (label: string) => summary.getByText(label).parentElement!;
    expect(card('Total tasks')).toHaveTextContent('8');
    expect(card('Completed')).toHaveTextContent('1');
    expect(card('In progress')).toHaveTextContent('3');
    expect(card('Overdue')).toHaveTextContent('2');
    expect(card('Overdue')).toHaveTextContent('1 due today · 3 in the next 7 days');
    expect(card('Active projects')).toHaveTextContent('21 archived');
  });

  it('draws status, priority and completion charts with the numbers as text', async () => {
    open(reply(full));
    const status = await screen.findByRole('list', { name: 'Tasks by status' });
    expect(
      within(status)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['To do4(50%)', 'In progress3(38%)', 'Done1(13%)']);
    const priority = screen.getByRole('list', { name: 'Tasks by priority' });
    expect(
      within(priority)
        .getAllByRole('listitem')
        .map((li) => li.title),
    ).toEqual(['Urgent: 2 (25%)', 'High: 2 (25%)', 'Medium: 3 (38%)', 'Low: 1 (13%)']);

    const completion = screen.getByRole('list', { name: 'Completion by project' });
    const [empty, website] = within(completion).getAllByRole('listitem');
    expect(empty).toHaveTextContent('EmptyNo tasks yet');
    expect(website).toHaveTextContent('Website12%(1/8 done)');
    expect(within(website!).getByRole('link', { name: 'Website' })).toHaveAttribute(
      'href',
      `/workspaces/${WS_ID}/projects/${WEBSITE}`,
    );
  });

  it('shows my work with links to my open tasks', async () => {
    open(reply(full));
    const panel = within(
      (await screen.findByRole('heading', { name: 'My work' })).closest('section')!,
    );
    expect(panel.getByText('Assigned', { selector: 'dt' }).nextSibling).toHaveTextContent('3');
    expect(panel.getByText('Pending', { selector: 'dt' }).nextSibling).toHaveTextContent('2');
    expect(panel.getByText('Overdue', { selector: 'dt' }).nextSibling).toHaveTextContent('1');
    expect(panel.getByText('Next 7 days', { selector: 'dt' }).nextSibling).toHaveTextContent('1');
    const task = panel.getByRole('link', { name: 'Fix login' });
    expect(task).toHaveAttribute('href', `/workspaces/${WS_ID}/projects/${WEBSITE}/tasks/${TASK}`);
    expect(panel.getByText('Overdue', { selector: 'span' })).toBeInTheDocument();
  });

  it('lists recent activity with actor, task and project links', async () => {
    open(reply(full));
    const items = within(await screen.findByRole('list', { name: 'Recent activity' })).getAllByRole(
      'listitem',
    );
    expect(items.map((li) => li.querySelector('p')!.textContent)).toEqual([
      'grace@example.com changed the status of Fix login in Website',
      'You commented on Fix login in Website',
      'A former member created Fix login in Website',
    ]);
    expect(within(items[0]!).getByRole('link', { name: 'Fix login' })).toHaveAttribute(
      'href',
      `/workspaces/${WS_ID}/projects/${WEBSITE}/tasks/${TASK}`,
    );
    expect(within(items[0]!).getByRole('link', { name: 'Website' })).toHaveAttribute(
      'href',
      `/workspaces/${WS_ID}/projects/${WEBSITE}`,
    );
  });

  it('shows empty states for a workspace without projects or activity', async () => {
    open(reply(zero));
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Summary')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing assigned to you is open.')).toBeInTheDocument();
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });

  it('shows "No tasks yet" in the charts when projects have no tasks', async () => {
    open(
      reply({
        ...zero,
        projects: {
          active: 1,
          archived: 0,
          completion: [
            { id: EMPTY, name: 'Empty', totalTasks: 0, doneTasks: 0, completionPercent: 0 },
          ],
        },
      }),
    );
    expect(await screen.findAllByText('No tasks yet.')).toHaveLength(2);
    expect(screen.getByText('No tasks yet')).toBeInTheDocument(); // the project row
  });

  it('shows an error with retry (503 is not "signed out")', async () => {
    let healthy = false;
    open(() => (healthy ? reply(full) : apiError(503, 'SERVICE_UNAVAILABLE', 'Unavailable')));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load the dashboard. Please try again.');
    healthy = true;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Tasks by status' })).toBeInTheDocument();
  });

  it('treats a 404 as "not found" without revealing whether the workspace exists', async () => {
    open(apiError(404, 'NOT_FOUND', 'Workspace not found'));
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
  });

  it('is reachable from the workspace page', async () => {
    mockApi({
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
        body: { data: { members: [] }, meta: { limit: 20, nextCursor: null } },
      },
      [`GET /api/v1/workspaces/${WS_ID}/projects`]: noProjects,
      [DASHBOARD]: reply(full),
    });
    const { router } = renderApp(`/workspaces/${WS_ID}`);
    const tabs = within(
      await screen.findByRole('navigation', { name: 'Workspace' }, { timeout: 5000 }),
    );
    fireEvent.click(tabs.getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PAGE);
  });
});

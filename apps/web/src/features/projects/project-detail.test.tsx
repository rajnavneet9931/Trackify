import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  noTasks,
  renderApp,
  session,
  USER,
  type MockReply,
  type RecordedRequest,
} from '../../test/mock-api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const PROJECT_ID = '01a14e7b-cea3-700d-aeda-0000000000aa';
const OTHER_ID = '01a14e7b-cea3-700d-aeda-0000000000bb';
const WORKSPACE = `GET /api/v1/workspaces/${WS_ID}`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const PROJECTS = `GET /api/v1/workspaces/${WS_ID}/projects`;
const DETAIL = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const PATCH = `PATCH /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const ARCHIVE = `POST /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/archive`;
const RESTORE = `POST /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/restore`;
const DELETE = `DELETE /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const PAGE = `/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASKS = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks`;

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
const project = (extra: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  workspaceId: WS_ID,
  name: 'Website Redesign',
  description: 'Redesign the company website',
  status: 'ACTIVE',
  createdById: USER.id,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-02T15:30:00.000Z',
  ...extra,
});
const detail = (
  extra: Record<string, unknown> = {},
  creator: unknown = { id: USER.id, email: USER.email },
): MockReply => ({ status: 200, body: { data: { project: project(extra), creator } } });
const changed = (extra: Record<string, unknown>): MockReply => ({
  status: 200,
  body: { data: { project: project(extra), changed: true } },
});
const members: MockReply = {
  status: 200,
  body: {
    data: {
      members: [
        { userId: USER.id, email: USER.email, role: 'OWNER', joinedAt: '2026-10-18T10:00:00.000Z' },
      ],
    },
    meta: { limit: 20, nextCursor: null },
  },
};

async function openProject(
  role: 'OWNER' | 'MEMBER',
  handlers: Record<string, Handler> = {},
  path = PAGE,
) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [WORKSPACE]: workspace(role),
    [DETAIL]: detail(),
    [TASKS]: noTasks,
    ...handlers,
  });
  const view = renderApp(path);
  return { api, ...view };
}
const ready = () => screen.findByRole('heading', { level: 1, name: 'Website Redesign' });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const editForm = () => within(screen.getByRole('form', { name: 'Edit project' }));
const expectNoManagementControls = () => {
  for (const name of [
    'Edit project',
    'Archive',
    'Restore',
    'Delete permanently',
    /Delete this project/,
  ]) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(screen.queryByText('Danger zone')).not.toBeInTheDocument();
};
const formatted = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

describe('project details page', () => {
  it('opens from the project list with the right workspace and project IDs', async () => {
    const { api, router } = await openProject(
      'MEMBER',
      {
        [MEMBERS]: members,
        [PROJECTS]: {
          status: 200,
          body: { data: { projects: [project()] }, meta: { limit: 20, nextCursor: null } },
        },
      },
      `/workspaces/${WS_ID}`,
    );

    // First render of the route tree in this file: allow for a cold start under full-suite load.
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'Website Redesign' }, { timeout: 5000 }));

    expect(await ready()).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PAGE);
    // The details request used exactly the workspace and project from the link.
    expect(api.to(DETAIL).length).toBeGreaterThan(0);
    expect(
      api.requests
        .filter((r) => r.method === 'GET' && /\/projects\/[^/]+$/.test(r.path))
        .every((r) => r.path === `/api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`),
    ).toBe(true);
  });

  it('shows a loading state, then name, description, status, creator, dates and workspace', async () => {
    const pending = deferred<MockReply>();
    await openProject('MEMBER', { [DETAIL]: () => pending.promise });

    expect(await screen.findByText('Loading project…')).toBeInTheDocument();
    pending.resolve(detail());
    expect(await ready()).toBeInTheDocument();

    expect(screen.getByText('Redesign the company website')).toBeInTheDocument();
    expect(screen.getByText('Status:').parentElement).toHaveTextContent('Active');
    const details = screen.getByRole('region', { name: 'Project details' });
    expect(details).toHaveTextContent(`Created by ${USER.email} (you)`);
    expect(details).toHaveTextContent(formatted('2026-11-01T09:00:00.000Z'));
    expect(details).toHaveTextContent(formatted('2026-11-02T15:30:00.000Z'));
    // Breadcrumbs give the full path back to the workspace.
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Platform Team' })).toHaveAttribute(
      'href',
      `/workspaces/${WS_ID}`,
    );
    expect(crumbs.getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      `/workspaces/${WS_ID}/projects`,
    );
  });

  it('handles a missing description and a creator who left the workspace', async () => {
    await openProject('MEMBER', { [DETAIL]: detail({ description: null }, null) });
    await ready();
    expect(screen.getByText('No description.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Project details' })).toHaveTextContent(
      'Created by A former member',
    );
  });

  it.each([
    ['an unknown project', { [DETAIL]: apiError(404, 'NOT_FOUND', 'Project not found') }],
    [
      'a workspace the user cannot open',
      { [WORKSPACE]: apiError(404, 'NOT_FOUND', 'Workspace not found') },
    ],
    ['a malformed ID', { [DETAIL]: apiError(400, 'VALIDATION_ERROR', 'Invalid') }],
  ])('shows "not found" for %s', async (_label, handlers) => {
    await openProject('MEMBER', handlers);
    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(screen.queryByText('Redesign the company website')).not.toBeInTheDocument();
  });

  it('shows a permission-denied state for a 403', async () => {
    await openProject('MEMBER', { [DETAIL]: apiError(403, 'FORBIDDEN', 'x') });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
  });

  it('shows a retryable error for server and network failures', async () => {
    let healthy = false;
    await openProject('MEMBER', {
      [DETAIL]: () => (healthy ? detail() : apiError(503, 'SERVICE_UNAVAILABLE', 'x')),
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load this project.');
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await ready()).toBeInTheDocument();
  });

  it('never shows the previous project while another one loads', async () => {
    const second = deferred<MockReply>();
    const { router } = await openProject('MEMBER', {
      [`GET /api/v1/workspaces/${WS_ID}/projects/${OTHER_ID}`]: () => second.promise,
    });
    await ready();

    await act(() => router.navigate(`/workspaces/${WS_ID}/projects/${OTHER_ID}`));

    expect(await screen.findByText('Loading project…')).toBeInTheDocument();
    expect(screen.queryByText('Website Redesign')).not.toBeInTheDocument();
    second.resolve(detail({ id: OTHER_ID, name: 'Second Project' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Second Project' }),
    ).toBeInTheDocument();
  });

  it('treats a 401 as signed out', async () => {
    const { router } = await openProject('MEMBER', {
      [DETAIL]: apiError(401, 'UNAUTHORIZED', 'x'),
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('never shows management controls to members (active or archived)', async () => {
    await openProject('MEMBER');
    await ready();
    expectNoManagementControls();
    expect(screen.queryByRole('region', { name: 'Manage project' })).not.toBeInTheDocument();
  });

  it('never shows management controls to members of an archived project', async () => {
    await openProject('MEMBER', { [DETAIL]: detail({ status: 'ARCHIVED' }) });
    await ready();
    expect(screen.getByText('This project is archived and read-only.')).toBeInTheDocument();
    expectNoManagementControls();
  });

  it('shows owners Edit, Archive and Delete permanently for an active project', async () => {
    await openProject('OWNER');
    await ready();
    expect(button('Edit project')).toBeEnabled();
    expect(button('Archive')).toBeEnabled();
    expect(button('Delete permanently')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });
});

describe('editing a project', () => {
  it('prefills the form, validates like the server, and saves with the version seen', async () => {
    const { api } = await openProject('OWNER', {
      [PATCH]: {
        status: 200,
        body: {
          data: {
            project: project({
              name: 'New Name',
              description: null,
              updatedAt: '2026-11-03T08:00:00.000Z',
            }),
          },
        },
      },
    });
    await ready();
    const user = userEvent.setup();

    await user.click(button('Edit project'));
    const name = screen.getByLabelText('Project name');
    const description = editForm().getByLabelText(/Description/);
    expect(name).toHaveValue('Website Redesign');
    expect(description).toHaveValue('Redesign the company website');

    await user.clear(name);
    await user.click(button('Save changes'));
    expect(name).toHaveAccessibleDescription('Name is required');
    expect(api.to(PATCH)).toHaveLength(0);

    await user.type(name, '  New Name ');
    await user.clear(description);
    await user.click(button('Save changes'));

    expect(await screen.findByRole('heading', { level: 1, name: 'New Name' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Project updated.');
    expect(screen.getByText('No description.')).toBeInTheDocument();
    const [request] = api.to(PATCH);
    expect(request!.body).toEqual({
      name: 'New Name',
      description: null,
      expectedUpdatedAt: '2026-11-02T15:30:00.000Z',
    });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('rejects an over-long description before calling the API', async () => {
    const { api } = await openProject('OWNER');
    await ready();
    await userEvent.setup().click(button('Edit project'));
    fireEvent.change(editForm().getByLabelText(/Description/), {
      target: { value: 'd'.repeat(2001) },
    });
    await userEvent.setup().click(button('Save changes'));

    expect(editForm().getByLabelText(/Description/)).toHaveAccessibleDescription(
      'Description must be at most 2000 characters',
    );
    expect(api.to(PATCH)).toHaveLength(0);
  });

  it('cancels without saving', async () => {
    const { api } = await openProject('OWNER');
    await ready();
    const user = userEvent.setup();
    await user.click(button('Edit project'));
    await user.type(screen.getByLabelText('Project name'), ' changed');
    await user.click(button('Cancel'));

    expect(screen.getByRole('heading', { level: 1, name: 'Website Redesign' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();
    expect(api.to(PATCH)).toHaveLength(0);
  });

  it('disables the form while saving and sends one request', async () => {
    const pending = deferred<MockReply>();
    const { api } = await openProject('OWNER', { [PATCH]: () => pending.promise });
    await ready();
    await userEvent.setup().click(button('Edit project'));
    const form = screen.getByRole('form', { name: 'Edit project' });

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(button('Cancel')).toBeDisabled();
    expect(screen.getByLabelText('Project name')).toHaveAttribute('readonly');
    expect(api.to(PATCH)).toHaveLength(1);
    pending.resolve(changed({}));
    expect(await screen.findByText('Project updated.')).toBeInTheDocument();
  });

  it('reports a conflicting change and offers to reload the latest version', async () => {
    let version = 1;
    await openProject('OWNER', {
      [DETAIL]: () => (version === 1 ? detail() : detail({ name: 'Renamed by someone else' })),
      [PATCH]: apiError(
        409,
        'CONFLICT',
        'This project was changed by someone else. Reload it to see the latest version.',
      ),
    });
    await ready();
    const user = userEvent.setup();
    await user.click(button('Edit project'));
    await user.click(button('Save changes'));

    expect(await screen.findByRole('alert')).toHaveTextContent('changed by someone else');
    version = 2;
    await user.click(button('Reload project'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Renamed by someone else' }),
    ).toBeInTheDocument();
  });

  it.each([
    [apiError(403, 'FORBIDDEN', 'x'), 'Only workspace owners can edit projects.'],
    [apiError(404, 'NOT_FOUND', 'x'), 'This project no longer exists.'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
  ])('keeps the form and explains failures safely (%#)', async (reply, message) => {
    await openProject('OWNER', { [PATCH]: reply });
    await ready();
    const user = userEvent.setup();
    await user.click(button('Edit project'));
    await user.type(screen.getByLabelText('Project name'), '!');
    await user.click(button('Save changes'));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('Project name')).toHaveValue('Website Redesign!');
    expect(button('Save changes')).toBeEnabled();
  });

  it('treats a 401 while saving as signed out', async () => {
    const { router } = await openProject('OWNER', { [PATCH]: apiError(401, 'UNAUTHORIZED', 'x') });
    await ready();
    const user = userEvent.setup();
    await user.click(button('Edit project'));
    await user.click(button('Save changes'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('archiving and restoring', () => {
  it('archives after a confirmation that explains it is reversible; the project becomes read-only', async () => {
    const { api } = await openProject('OWNER', { [ARCHIVE]: changed({ status: 'ARCHIVED' }) });
    await ready();
    const user = userEvent.setup();

    await user.click(button('Archive'));
    const confirm = screen.getByRole('group', { name: 'Confirm archiving' });
    expect(confirm).toHaveTextContent('Archiving is reversible');
    expect(api.to(ARCHIVE)).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Archive project' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Project archived.');
    expect(screen.getByText('Status:').parentElement).toHaveTextContent('Archived');
    expect(screen.getByText(/This project is archived and read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(button('Restore')).toBeEnabled();
    expect(api.to(ARCHIVE)[0]!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('can cancel the archive confirmation', async () => {
    const { api } = await openProject('OWNER');
    await ready();
    const user = userEvent.setup();
    await user.click(button('Archive'));
    await user.click(button('Cancel'));
    expect(api.to(ARCHIVE)).toHaveLength(0);
    expect(button('Archive')).toBeInTheDocument();
  });

  it('restores an archived project after confirmation', async () => {
    const { api } = await openProject('OWNER', {
      [DETAIL]: detail({ status: 'ARCHIVED' }),
      [RESTORE]: changed({ status: 'ACTIVE' }),
    });
    await ready();
    const user = userEvent.setup();

    await user.click(button('Restore'));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm restoring' })).getByRole('button', {
        name: 'Restore project',
      }),
    );

    expect(await screen.findByRole('status')).toHaveTextContent('Project restored.');
    expect(screen.getByText('Status:').parentElement).toHaveTextContent('Active');
    expect(button('Edit project')).toBeEnabled();
    expect(api.to(RESTORE)).toHaveLength(1);
  });

  it('disables the controls while a request is pending and sends it once', async () => {
    const pending = deferred<MockReply>();
    const { api } = await openProject('OWNER', { [ARCHIVE]: () => pending.promise });
    await ready();
    await userEvent.setup().click(button('Archive'));
    const confirmButton = button('Archive project');

    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(await screen.findByRole('button', { name: 'Archiving…' })).toBeDisabled();
    expect(button('Cancel')).toBeDisabled();
    expect(button('Delete permanently')).toBeDisabled();
    expect(api.to(ARCHIVE)).toHaveLength(1);
    pending.resolve(changed({ status: 'ARCHIVED' }));
    expect(await screen.findByText(/Project archived\./)).toBeInTheDocument();
  });

  it('keeps the page and shows a safe error when archiving fails', async () => {
    await openProject('OWNER', { [ARCHIVE]: apiError(403, 'FORBIDDEN', 'internal detail') });
    await ready();
    const user = userEvent.setup();
    await user.click(button('Archive'));
    await user.click(button('Archive project'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Only workspace owners can manage projects.');
    expect(alert).not.toHaveTextContent('internal detail');
    expect(screen.getByText('Status:').parentElement).toHaveTextContent('Active');
    expect(screen.getByText('Redesign the company website')).toBeInTheDocument();
  });
});

describe('permanent deletion', () => {
  it('needs its own explicit confirmation: the project name must be typed', async () => {
    const { api } = await openProject('OWNER', {
      [DELETE]: { status: 200, body: { data: { deleted: true } } },
    });
    await ready();
    const user = userEvent.setup();

    await user.click(button('Delete permanently'));
    const form = screen.getByRole('form', { name: 'Confirm permanent deletion' });
    expect(form).toHaveTextContent('cannot be undone');
    expect(form).not.toHaveTextContent('reversible');
    const confirm = within(form).getByRole('button', { name: 'Delete this project permanently' });
    expect(confirm).toBeDisabled();

    await user.type(within(form).getByLabelText('Type the project name to confirm'), 'Website');
    expect(confirm).toBeDisabled();
    fireEvent.submit(form);
    expect(api.to(DELETE)).toHaveLength(0);
  });

  it('deletes and returns to the workspace’s projects', async () => {
    const { api, router } = await openProject('OWNER', {
      [DELETE]: { status: 200, body: { data: { deleted: true } } },
      [MEMBERS]: members,
      [PROJECTS]: {
        status: 200,
        body: { data: { projects: [] }, meta: { limit: 20, nextCursor: null } },
      },
    });
    await ready();
    const user = userEvent.setup();

    await user.click(button('Delete permanently'));
    await user.type(screen.getByLabelText('Type the project name to confirm'), 'Website Redesign');
    await user.click(button('Delete this project permanently'));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/workspaces/${WS_ID}/projects`),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    const [request] = api.to(DELETE);
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('disables everything while deleting and sends one request', async () => {
    const pending = deferred<MockReply>();
    const { api } = await openProject('OWNER', { [DELETE]: () => pending.promise });
    await ready();
    const user = userEvent.setup();
    await user.click(button('Delete permanently'));
    await user.type(screen.getByLabelText('Type the project name to confirm'), 'Website Redesign');
    const form = screen.getByRole('form', { name: 'Confirm permanent deletion' });

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(button('Cancel')).toBeDisabled();
    expect(api.to(DELETE)).toHaveLength(1);
    pending.resolve(apiError(503, 'SERVICE_UNAVAILABLE', 'x'));
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
  });

  it('keeps the page when deletion fails', async () => {
    const { router } = await openProject('OWNER', {
      [DELETE]: apiError(404, 'NOT_FOUND', 'Project not found'),
    });
    await ready();
    const user = userEvent.setup();
    await user.click(button('Delete permanently'));
    await user.type(screen.getByLabelText('Type the project name to confirm'), 'Website Redesign');
    await user.click(button('Delete this project permanently'));

    expect(await screen.findByRole('alert')).toHaveTextContent('This project no longer exists.');
    expect(router.state.location.pathname).toBe(PAGE);
    expect(screen.getByRole('heading', { level: 1, name: 'Website Redesign' })).toBeInTheDocument();
  });

  it('treats a 401 while deleting as signed out', async () => {
    const { router } = await openProject('OWNER', {
      [DELETE]: (_r: RecordedRequest) => apiError(401, 'UNAUTHORIZED', 'x'),
    });
    await ready();
    const user = userEvent.setup();
    await user.click(button('Delete permanently'));
    await user.type(screen.getByLabelText('Type the project name to confirm'), 'Website Redesign');
    await user.click(button('Delete this project permanently'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

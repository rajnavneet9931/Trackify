import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  renderApp,
  session,
  USER,
  type MockReply,
  type RecordedRequest,
} from '../../test/mock-api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const DETAIL = `GET /api/v1/workspaces/${WS_ID}`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const PROJECTS = `GET /api/v1/workspaces/${WS_ID}/projects`;
const CREATE = `POST /api/v1/workspaces/${WS_ID}/projects`;

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

const project = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `01a14e7b-cea3-700d-aeda-${String(n).padStart(12, '0')}`,
  workspaceId: WS_ID,
  name: `Project ${n}`,
  description: null,
  status: 'ACTIVE',
  createdById: USER.id,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...extra,
});
const page = (projects: unknown[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { projects }, meta: { limit: 20, nextCursor } },
});
/** Serves pages by cursor (state-based, so StrictMode's double mount is harmless). */
const byCursor =
  (pages: Record<string, MockReply>): Handler =>
  (request: RecordedRequest) =>
    pages[request.query.get('cursor') ?? ''] ?? { status: 500 };

async function openDetail(role: 'OWNER' | 'MEMBER', projects: Handler, extra = {}) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [DETAIL]: detail(role),
    [MEMBERS]: members,
    [PROJECTS]: projects,
    ...extra,
  });
  const view = renderApp(`/workspaces/${WS_ID}/projects`);
  await screen.findByRole('heading', { level: 1, name: 'Projects' }, { timeout: 5000 });
  return { api, ...view };
}

const projectList = () => screen.getByRole('list', { name: 'Projects' });
const projectNames = () =>
  within(projectList())
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent);

describe('project list on the workspace page', () => {
  it('shows a loading state, then the projects', async () => {
    const pending = deferred<MockReply>();
    await openDetail('MEMBER', () => pending.promise);

    expect(screen.getByText('Loading projects…')).toBeInTheDocument();
    pending.resolve(page([project(1)]));
    expect(await screen.findByRole('list', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.queryByText('Loading projects…')).not.toBeInTheDocument();
  });

  it('renders name, description, status and creation date', async () => {
    await openDetail(
      'MEMBER',
      page([
        project(2, {
          name: 'Website Redesign',
          description: 'Redesign the company website',
          createdAt: '2026-11-02T08:30:00.000Z',
        }),
        project(1, { name: 'Old Initiative', status: 'ARCHIVED' }),
      ]),
    );

    const items = within(await screen.findByRole('list', { name: 'Projects' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);
    expect(
      within(items[0]!).getByRole('heading', { name: 'Website Redesign' }),
    ).toBeInTheDocument();
    expect(items[0]).toHaveTextContent('Redesign the company website');
    expect(items[0]).toHaveTextContent('Status: Active');
    const time = items[0]!.querySelector('time')!;
    expect(time).toHaveAttribute('dateTime', '2026-11-02T08:30:00.000Z');
    expect(time.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
        new Date('2026-11-02T08:30:00.000Z'),
      ),
    );
    expect(items[1]).toHaveTextContent('Status: Archived');
    // Each name links to its details page; no edit/archive/delete controls in the list.
    expect(within(projectList()).queryAllByRole('button')).toHaveLength(0);
    expect(
      within(projectList())
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      `/workspaces/${WS_ID}/projects/${project(2).id}`,
      `/workspaces/${WS_ID}/projects/${project(1).id}`,
    ]);
  });

  it('shows an empty state (with a hint suited to the role)', async () => {
    await openDetail('MEMBER', page([]));
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
    expect(screen.getByText('An owner can create one.')).toBeInTheDocument();
  });

  it('pages with Load more, using the cursor, without duplicates', async () => {
    const { api } = await openDetail(
      'MEMBER',
      byCursor({
        '': page([project(5), project(4)], 'c1'),
        c1: page([project(4), project(3), project(2)], 'c2'), // overlaps: 4 again
        c2: page([project(1)]),
      }),
    );
    await screen.findByRole('list', { name: 'Projects' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Load more projects' }));
    await waitFor(() => expect(projectNames()).toHaveLength(4));
    await user.click(screen.getByRole('button', { name: 'Load more projects' }));
    await waitFor(() => expect(projectNames()).toHaveLength(5));

    expect(projectNames()).toEqual([
      'Project 5',
      'Project 4',
      'Project 3',
      'Project 2',
      'Project 1',
    ]);
    expect(screen.queryByRole('button', { name: 'Load more projects' })).not.toBeInTheDocument();
    const cursors = api.to(PROJECTS).map((r) => r.query.get('cursor'));
    expect(cursors.filter(Boolean)).toEqual(['c1', 'c2']);
    expect(api.to(PROJECTS).every((r) => r.query.get('limit') === '20')).toBe(true);
  });

  it('shows a loading-more state and ignores repeated clicks', async () => {
    const more = deferred<MockReply>();
    const { api } = await openDetail('MEMBER', (request: RecordedRequest) =>
      request.query.get('cursor') ? more.promise : page([project(2)], 'c1'),
    );
    const button = await screen.findByRole('button', { name: 'Load more projects' });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled();
    expect(api.to(PROJECTS).filter((r) => r.query.get('cursor'))).toHaveLength(1);
    more.resolve(page([project(1)]));
    await waitFor(() => expect(projectNames()).toEqual(['Project 2', 'Project 1']));
  });

  it('retries after an initial failure', async () => {
    let healthy = false;
    await openDetail('MEMBER', () =>
      healthy ? page([project(1)]) : apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load the projects of this workspace.');
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('list', { name: 'Projects' })).toBeInTheDocument();
    expect(projectNames()).toEqual(['Project 1']);
  });

  it('keeps loaded projects when Load more fails, and lets the user try again', async () => {
    let failMore = true;
    await openDetail('MEMBER', (request: RecordedRequest) => {
      if (!request.query.get('cursor')) return page([project(2)], 'c1');
      return failMore ? new Promise<MockReply>((r) => r({ status: 503 })) : page([project(1)]);
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Load more projects' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load the projects');
    expect(projectNames()).toEqual(['Project 2']);

    failMore = false;
    await user.click(screen.getByRole('button', { name: 'Load more projects' }));
    await waitFor(() => expect(projectNames()).toEqual(['Project 2', 'Project 1']));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a 401 as signed out', async () => {
    const { router } = await openDetail('MEMBER', apiError(401, 'UNAUTHORIZED', 'x'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('never requests projects for a workspace the user cannot open', async () => {
    const api = mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [DETAIL]: apiError(404, 'NOT_FOUND', 'Workspace not found'),
    });
    renderApp(`/workspaces/${WS_ID}/projects`);

    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
    expect(api.to(PROJECTS)).toHaveLength(0);
  });

  it('is its own page under the workspace tabs, with the full breadcrumb path', async () => {
    await openDetail('MEMBER', page([project(1)]));

    expect(await screen.findByRole('list', { name: 'Projects' })).toBeInTheDocument();
    const tabs = within(screen.getByRole('navigation', { name: 'Workspace' }));
    expect(tabs.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Platform Team' })).toBeInTheDocument();
    expect(document.title).toBe('Projects · Platform Team · Trackify');
    // Members see the list, not the create form.
    expect(screen.queryByRole('heading', { name: 'Create a project' })).not.toBeInTheDocument();
  });

  it('puts a project an owner just created at the top of the list', async () => {
    await openDetail('OWNER', page([project(1)]), {
      [CREATE]: { status: 201, body: { data: { project: project(9, { name: 'Brand New' }) } } },
    });
    await screen.findByRole('list', { name: 'Projects' });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Project name'), 'Brand New');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(projectNames()).toEqual(['Brand New', 'Project 1']));
  });
});

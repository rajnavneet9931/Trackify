import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const DETAIL = `GET /api/v1/workspaces/${WS_ID}`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const PROJECTS = `GET /api/v1/workspaces/${WS_ID}/projects`;
const CREATE = `POST /api/v1/workspaces/${WS_ID}/projects`;

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
const created = (name = 'Website Redesign', description: string | null = null): MockReply => ({
  status: 201,
  body: {
    data: {
      project: {
        id: '01a14e7b-cea3-700d-aeda-0000000000aa',
        workspaceId: WS_ID,
        name,
        description,
        status: 'ACTIVE',
        createdById: USER.id,
        createdAt: '2026-11-03T10:00:00.000Z',
        updatedAt: '2026-11-03T10:00:00.000Z',
      },
    },
  },
});

type Handler = NonNullable<Parameters<typeof mockApi>[0]>[string];

async function openDetail(role: 'OWNER' | 'MEMBER', createReply?: Handler) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [DETAIL]: detail(role),
    [MEMBERS]: members,
    [PROJECTS]: noProjects,
    ...(createReply && { [CREATE]: createReply }),
  });
  const view = renderApp(`/workspaces/${WS_ID}/projects`);
  await screen.findByRole('heading', { level: 1, name: 'Projects' }, { timeout: 5000 });
  return { api, ...view };
}

async function fillAndSubmit(name: string, description = '') {
  const user = userEvent.setup();
  const nameInput = screen.getByLabelText('Project name');
  const descriptionInput = screen.getByLabelText(/Description/);
  await user.clear(nameInput);
  if (name) await user.type(nameInput, name);
  await user.clear(descriptionInput);
  if (description) await user.type(descriptionInput, description);
  await user.click(screen.getByRole('button', { name: 'Create project' }));
  return { nameInput, descriptionInput };
}

describe('create project form on the workspace page', () => {
  it('is shown to owners only', async () => {
    await openDetail('MEMBER');
    expect(screen.queryByRole('heading', { name: 'Create a project' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();
  });

  it('is shown to owners', async () => {
    await openDetail('OWNER');
    expect(screen.getByRole('heading', { name: 'Create a project' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toBeInTheDocument();
  });

  it('requires a name before calling the API', async () => {
    const { api } = await openDetail('OWNER', created());
    const { nameInput } = await fillAndSubmit('   ');

    expect(nameInput).toHaveAccessibleDescription('Name is required');
    expect(nameInput).toHaveFocus();
    expect(api.to(CREATE)).toHaveLength(0);
  });

  it('enforces the length limits before calling the API', async () => {
    const { api } = await openDetail('OWNER', created());
    const nameInput = screen.getByLabelText('Project name');
    const descriptionInput = screen.getByLabelText(/Description/);
    fireEvent.change(nameInput, { target: { value: 'n'.repeat(121) } });
    fireEvent.change(descriptionInput, { target: { value: 'd'.repeat(2001) } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create project' }));

    expect(nameInput).toHaveAccessibleDescription('Name must be at most 120 characters');
    expect(descriptionInput).toHaveAccessibleDescription(
      'Description must be at most 2000 characters',
    );
    expect(api.to(CREATE)).toHaveLength(0);
  });

  it('creates a project with trimmed values and the CSRF token, then clears the form', async () => {
    const { api } = await openDetail('OWNER', created('Website Redesign', 'Phase 1'));
    const { nameInput, descriptionInput } = await fillAndSubmit(
      '  Website Redesign  ',
      '  Phase 1  ',
    );

    const status = (await screen.findByText(/created\./)).closest('[role=status]')!;
    expect(status).toHaveTextContent('Project Website Redesign created.');
    const [request] = api.to(CREATE);
    expect(request!.body).toEqual({ name: 'Website Redesign', description: 'Phase 1' });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(nameInput).toHaveValue('');
    expect(descriptionInput).toHaveValue('');
  });

  it('omits an empty description and never sends server-decided fields', async () => {
    const { api } = await openDetail('OWNER', created());
    await fillAndSubmit('Website Redesign', '   ');

    await screen.findByText(/created\./);
    expect(api.to(CREATE)[0]!.body).toEqual({ name: 'Website Redesign' });
  });

  it('shows a pending state and prevents duplicate submissions', async () => {
    const pending = deferred<MockReply>();
    const { api } = await openDetail('OWNER', () => pending.promise);
    await userEvent.setup().type(screen.getByLabelText('Project name'), 'Roadmap');
    const form = screen.getByRole('button', { name: 'Create project' }).closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole('button', { name: 'Creating project…' })).toBeDisabled();
    expect(screen.getByLabelText('Project name')).toHaveAttribute('readonly');
    expect(api.to(CREATE)).toHaveLength(1);
    pending.resolve(created('Roadmap'));
    expect(await screen.findByText(/created\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
  });

  it('shows server field errors on the matching field', async () => {
    await openDetail(
      'OWNER',
      apiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { path: 'name', message: 'Name must not contain control characters' },
      ]),
    );
    const { nameInput } = await fillAndSubmit('Roadmap');

    await waitFor(() =>
      expect(nameInput).toHaveAccessibleDescription('Name must not contain control characters'),
    );
  });

  it.each([
    [apiError(403, 'FORBIDDEN', 'x'), 'Only workspace owners can create projects.'],
    [apiError(404, 'NOT_FOUND', 'x'), 'This workspace is no longer available.'],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
    [apiError(500, 'INTERNAL_ERROR', 'secret internal detail'), 'Something went wrong.'],
  ])('explains failures safely (%#) and allows another attempt', async (reply, message) => {
    await openDetail('OWNER', reply);
    await fillAndSubmit('Roadmap');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent('secret internal detail');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
    expect(screen.getByLabelText('Project name')).toHaveValue('Roadmap');
  });

  it('treats a 401 as signed out', async () => {
    const { router } = await openDetail('OWNER', apiError(401, 'UNAUTHORIZED', 'x'));
    await fillAndSubmit('Roadmap');

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

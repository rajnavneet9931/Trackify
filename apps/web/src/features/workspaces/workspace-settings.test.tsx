import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  mockApi,
  noProjects,
  renderApp,
  session,
  USER,
  type MockReply,
} from '../../test/mock-api';

const WS_ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';
const GRACE = '01a14e7b-cea3-700d-aeda-0000000000d1';
const SETTINGS = `GET /api/v1/workspaces/${WS_ID}/settings`;
const PATCH = `PATCH /api/v1/workspaces/${WS_ID}/settings`;
const DELETE = `DELETE /api/v1/workspaces/${WS_ID}`;
const MEMBERS = `GET /api/v1/workspaces/${WS_ID}/members`;
const PAGE = `/workspaces/${WS_ID}/settings`;
const VERSION = '2026-11-05T10:00:00.000Z';

const settings = (role: 'OWNER' | 'MEMBER', extra: Record<string, unknown> = {}): MockReply => ({
  status: 200,
  body: {
    data: {
      settings: {
        id: WS_ID,
        name: 'Team',
        description: 'Our team',
        createdAt: '2026-10-18T10:00:00.000Z',
        updatedAt: VERSION,
        ...extra,
      },
      membership: { role },
    },
  },
});
const members: MockReply = {
  status: 200,
  body: {
    data: {
      members: [
        {
          userId: USER.id,
          name: 'Ada',
          email: USER.email,
          role: 'OWNER',
          joinedAt: '2026-10-18T10:00:00.000Z',
        },
        {
          userId: GRACE,
          name: null,
          email: 'grace@example.com',
          role: 'MEMBER',
          joinedAt: '2026-10-19T10:00:00.000Z',
        },
      ],
    },
    meta: { limit: 20, nextCursor: null },
  },
};

function open(role: 'OWNER' | 'MEMBER', handlers: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [SETTINGS]: settings(role),
    [MEMBERS]: members,
    ...handlers,
  });
  return { api, ...renderApp(PAGE) };
}
const general = () => within(screen.getByRole('region', { name: 'General' }));

describe('workspace settings page', () => {
  it('is linked from the workspace page', async () => {
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
      [`GET /api/v1/workspaces/${WS_ID}/projects`]: noProjects,
      [MEMBERS]: members,
      [SETTINGS]: settings('MEMBER'),
    });
    const { router } = renderApp(`/workspaces/${WS_ID}`);
    fireEvent.click(await screen.findByRole('link', { name: 'Settings' }, { timeout: 5000 }));
    expect(await screen.findByRole('heading', { name: 'Workspace settings' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PAGE);
  });

  it('shows members read-only settings and no management controls', async () => {
    open('MEMBER');
    expect(
      await screen.findByRole('heading', { name: 'Workspace settings' }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(general().getByText('Team')).toBeInTheDocument();
    expect(general().getByText('Our team')).toBeInTheDocument();
    expect(general().getByText('Only owners can change these settings.')).toBeInTheDocument();
    expect(general().queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();
    // Members are no longer repeated here; Settings points to the Members page.
    expect(screen.queryByRole('list', { name: /Members/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Members, invitations and roles are on the/)).toBeInTheDocument();
  });

  it('lists members with names, emails and roles on the Members page', async () => {
    mockApi({
      'GET /api/v1/auth/me': session('csrf-1'),
      [`GET /api/v1/workspaces/${WS_ID}`]: {
        status: 200,
        body: {
          data: {
            workspace: { id: WS_ID, name: 'Team', createdAt: '2026-10-18T10:00:00.000Z' },
            membership: { role: 'OWNER' },
          },
        },
      },
      [MEMBERS]: members,
    });
    renderApp(`/workspaces/${WS_ID}/members`);
    const list = await screen.findByRole('list', { name: /Members/ }, { timeout: 5000 });
    const [ada, grace] = within(list).getAllByRole('listitem');
    expect(ada).toHaveTextContent('Ada');
    expect(ada).toHaveTextContent(USER.email);
    expect(ada).toHaveTextContent('Owner');
    expect(grace).toHaveTextContent('grace@example.com');
    expect(grace).toHaveTextContent('Member');
    // Existing owner controls are available here.
    expect(within(grace!).getByRole('button', { name: /Remove/ })).toBeInTheDocument();
  });

  it('lets an owner save only the changed fields, with the version seen', async () => {
    const { api } = open('OWNER', {
      [PATCH]: (r) =>
        settings('OWNER', { ...(r.body as object), updatedAt: '2026-11-05T11:00:00.000Z' }),
    });
    const name = await screen.findByLabelText('Workspace name', {}, { timeout: 5000 });
    expect(general().getByRole('button', { name: 'Save settings' })).toBeDisabled();
    fireEvent.change(name, { target: { value: '  Product ' } });
    fireEvent.click(general().getByRole('button', { name: 'Save settings' }));

    expect(await general().findByText('Settings saved.')).toBeInTheDocument();
    const [req] = api.to(PATCH);
    expect(req!.body).toEqual({ name: 'Product', expectedUpdatedAt: VERSION });
    expect(req!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(general().getByLabelText('Workspace name')).toHaveValue('Product');
  });

  it('validates the name and explains a concurrent edit (409) with a reload', async () => {
    let version = 0;
    const { api } = open('OWNER', {
      [SETTINGS]: () =>
        settings('OWNER', {
          name: version ? 'Renamed elsewhere' : 'Team',
          updatedAt: `2026-11-05T1${version}:00:00.000Z`,
        }),
      [PATCH]: apiError(409, 'CONFLICT', 'stale'),
    });
    const name = await screen.findByLabelText('Workspace name', {}, { timeout: 5000 });
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(general().getByRole('button', { name: 'Save settings' }));
    expect(await general().findByText('Name is required')).toBeInTheDocument();
    expect(api.to(PATCH)).toEqual([]);

    fireEvent.change(name, { target: { value: 'Mine' } });
    fireEvent.click(general().getByRole('button', { name: 'Save settings' }));
    expect(await general().findByText(/Someone else changed these settings/)).toBeInTheDocument();
    version = 1;
    fireEvent.click(general().getByRole('button', { name: 'Reload' }));
    expect(
      await screen.findByDisplayValue('Renamed elsewhere', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('deletes only after the exact name is typed, then returns to the workspace list', async () => {
    const { api, router } = open('OWNER', {
      [DELETE]: { status: 200, body: { data: { deleted: true } } },
      'GET /api/v1/workspaces': {
        status: 200,
        body: { data: { workspaces: [] }, meta: { limit: 20, nextCursor: null } },
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete workspace' }, { timeout: 5000 }),
    );
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/This permanently deletes Team/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Delete this workspace permanently' });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Type the workspace name to confirm'), {
      target: { value: 'team' },
    });
    expect(confirm).toBeDisabled(); // must match exactly
    fireEvent.change(dialog.getByLabelText('Type the workspace name to confirm'), {
      target: { value: 'Team' },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'));
    expect(await screen.findByText('Team was permanently deleted.')).toBeInTheDocument();
    const [req] = api.to(DELETE);
    expect(req!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(req!.body).toBeUndefined();
  });

  it('can cancel deletion, and shows a refusal from the server', async () => {
    const { api, router } = open('OWNER', { [DELETE]: apiError(403, 'FORBIDDEN', 'x') });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete workspace' }, { timeout: 5000 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.to(DELETE)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));
    fireEvent.change(screen.getByLabelText('Type the workspace name to confirm'), {
      target: { value: 'Team' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete this workspace permanently' }));
    expect(await screen.findByText('Only owners can delete this workspace.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PAGE);
  });

  it('shows not-found and error-with-retry states', async () => {
    open('OWNER', { [SETTINGS]: apiError(404, 'NOT_FOUND', 'Workspace not found') });
    expect(
      await screen.findByRole('heading', { name: 'Workspace not found' }, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('retries after a failure', async () => {
    let healthy = false;
    open('OWNER', {
      [SETTINGS]: () => (healthy ? settings('OWNER') : apiError(503, 'SERVICE_UNAVAILABLE', 'x')),
    });
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    healthy = true;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Workspace name', {}, { timeout: 5000 })).toHaveValue(
      'Team',
    );
  });
});

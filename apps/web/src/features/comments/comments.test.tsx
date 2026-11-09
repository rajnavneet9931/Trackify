import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  apiError,
  deferred,
  mockApi,
  noActivities,
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
const GRACE = { id: '01a14e7b-cea3-700d-aeda-0000000000d1', email: 'grace@example.com' };
const WORKSPACE = `GET /api/v1/workspaces/${WS_ID}`;
const PROJECT = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}`;
const TASK = `GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`;
const COMMENTS_PATH = `/api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}/comments`;
const LIST = `GET ${COMMENTS_PATH}`;
const POST = `POST ${COMMENTS_PATH}`;
const TASK_PAGE = `/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${TASK_ID}`;

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
        createdById: USER.id,
        assigneeId: null,
        assignee: null,
        createdAt: '2026-11-02T08:00:00.000Z',
        updatedAt: '2026-11-02T08:00:00.000Z',
      },
      creator: { id: USER.id, email: USER.email },
    },
  },
});
const comment = (
  n: number,
  author: { id: string; email: string } | null = GRACE,
  extra: Record<string, unknown> = {},
) => ({
  id: `01a14e7b-cea3-700d-aeda-${String(n).padStart(12, '0')}`,
  taskId: TASK_ID,
  authorId: author?.id ?? '01a14e7b-cea3-700d-aeda-0000000000ee',
  author,
  content: `Comment ${n}`,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...extra,
});
const ME = { id: USER.id, email: USER.email };
const page = (comments: unknown[], nextCursor: string | null = null): MockReply => ({
  status: 200,
  body: { data: { comments }, meta: { limit: 20, nextCursor } },
});
const byCursor =
  (pages: Record<string, MockReply>): Handler =>
  (request: RecordedRequest) =>
    pages[request.query.get('cursor') ?? ''] ?? { status: 500 };

function openTask(
  role: 'OWNER' | 'MEMBER',
  comments: Handler,
  extra: Record<string, Handler> = {},
) {
  const api = mockApi({
    'GET /api/v1/auth/me': session('csrf-1'),
    [WORKSPACE]: workspace(role),
    [PROJECT]: projectReply(),
    [TASK]: taskReply(),
    [`GET /api/v1/workspaces/${WS_ID}/members`]: page([]),
    [LIST]: comments,
    [`${TASK}/activities`]: noActivities,
    ...extra,
  });
  const view = renderApp(TASK_PAGE);
  return { api, ...view };
}
const section = () => within(screen.getByRole('region', { name: 'Comments' }));
const commentList = () => section().getByRole('list', { name: 'Comments' });
const contents = () =>
  within(commentList())
    .getAllByRole('listitem')
    .map((li) => li.querySelector('p.whitespace-pre-line')?.textContent);
const ready = async () => {
  await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
  await waitFor(() => expect(section().queryByText('Loading comments…')).not.toBeInTheDocument());
};

describe('task discussion', () => {
  it('shows a loading state, then comments oldest first with author and time', async () => {
    const pending = deferred<MockReply>();
    openTask('MEMBER', () => pending.promise);
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    expect(section().getByText('Loading comments…')).toBeInTheDocument();

    pending.resolve(
      page([
        comment(1, GRACE, { content: 'First!\nWith a second line' }),
        comment(2, ME, {
          createdAt: '2026-11-03T11:00:00.000Z',
          updatedAt: '2026-11-03T12:00:00.000Z',
        }),
        comment(3, null),
      ]),
    );

    const items = within(await section().findByRole('list', { name: 'Comments' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('grace@example.com');
    expect(items[0]).toHaveTextContent('First!');
    expect(items[0]).toHaveTextContent('With a second line');
    expect(items[0]!.querySelector('time')).toHaveAttribute('dateTime', '2026-11-03T10:00:00.000Z');
    expect(items[1]).toHaveAccessibleName('Your comment');
    expect(items[1]).toHaveTextContent(`${USER.email}(you)`);
    expect(items[1]).toHaveTextContent('edited');
    expect(items[0]).not.toHaveTextContent('edited');
    expect(items[2]).toHaveTextContent('Former member');
  });

  it('shows an empty state', async () => {
    openTask('MEMBER', page([]));
    expect(await screen.findByText(/No comments yet\./)).toBeInTheDocument();
  });

  it('shows a retryable error', async () => {
    let healthy = false;
    openTask('MEMBER', () =>
      healthy ? page([comment(1)]) : apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    );
    await screen.findByRole('heading', { level: 1, name: 'Implement login API' });
    const alert = await section().findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load the discussion.');
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(contents()).toEqual(['Comment 1']));
  });

  it('loads more comments, in order, without duplicates', async () => {
    const { api } = openTask(
      'MEMBER',
      byCursor({
        '': page([comment(1), comment(2)], 'c1'),
        c1: page([comment(2), comment(3)]),
      }),
    );
    await ready();
    await userEvent.setup().click(section().getByRole('button', { name: 'Load more comments' }));
    await waitFor(() => expect(contents()).toEqual(['Comment 1', 'Comment 2', 'Comment 3']));
    expect(section().queryByRole('button', { name: 'Load more comments' })).not.toBeInTheDocument();
    expect(
      api
        .to(LIST)
        .map((r) => r.query.get('cursor'))
        .filter(Boolean),
    ).toEqual(['c1']);
  });

  it('never shows another task’s discussion after navigating', async () => {
    const other = deferred<MockReply>();
    const { router } = openTask('MEMBER', page([comment(1, GRACE, { content: 'Old task talk' })]), {
      [`GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${OTHER_TASK}`]: taskReply(
        OTHER_TASK,
        'Second task',
      ),
      [`GET /api/v1/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${OTHER_TASK}/comments`]: () =>
        other.promise,
    });
    await screen.findByText('Old task talk');

    await act(() =>
      router.navigate(`/workspaces/${WS_ID}/projects/${PROJECT_ID}/tasks/${OTHER_TASK}`),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Second task' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Old task talk')).not.toBeInTheDocument();
    other.resolve(page([comment(9, GRACE, { content: 'New task talk' })]));
    expect(await screen.findByText('New task talk')).toBeInTheDocument();
  });

  it('treats a 401 as signed out', async () => {
    const { router } = openTask('MEMBER', apiError(401, 'UNAUTHORIZED', 'x'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('posting a comment', () => {
  it('validates before calling the API', async () => {
    const { api } = openTask('MEMBER', page([]));
    await ready();
    const form = within(section().getByRole('form', { name: 'Add a comment' }));
    const user = userEvent.setup();
    await user.click(form.getByRole('button', { name: 'Post comment' }));
    expect(form.getByLabelText('Add a comment')).toHaveAccessibleDescription('Comment is required');
    fireEvent.change(form.getByLabelText('Add a comment'), { target: { value: 'c'.repeat(5001) } });
    await user.click(form.getByRole('button', { name: 'Post comment' }));
    expect(form.getByLabelText('Add a comment')).toHaveAccessibleDescription(
      'Comment must be at most 5000 characters',
    );
    expect(api.to(POST)).toHaveLength(0);
  });

  it('posts trimmed content with the CSRF token and appends it at the end', async () => {
    const { api } = openTask('MEMBER', page([comment(1)]), {
      [POST]: { status: 201, body: { data: { comment: comment(5, ME, { content: 'Ship it' }) } } },
    });
    await ready();
    const form = within(section().getByRole('form', { name: 'Add a comment' }));
    const user = userEvent.setup();
    await user.type(form.getByLabelText('Add a comment'), '  Ship it  ');
    await user.click(form.getByRole('button', { name: 'Post comment' }));

    await waitFor(() => expect(contents()).toEqual(['Comment 1', 'Ship it']));
    expect(section().getByRole('status')).toHaveTextContent('Comment posted.');
    expect(form.getByLabelText('Add a comment')).toHaveValue('');
    const [request] = api.to(POST);
    expect(request!.body).toEqual({ content: 'Ship it' });
    expect(request!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('does not append out of order while older pages are still unloaded', async () => {
    openTask('MEMBER', page([comment(1)], 'more'), {
      [POST]: { status: 201, body: { data: { comment: comment(5, ME, { content: 'Later' }) } } },
    });
    await ready();
    const user = userEvent.setup();
    const form = within(section().getByRole('form', { name: 'Add a comment' }));
    await user.type(form.getByLabelText('Add a comment'), 'Later');
    await user.click(form.getByRole('button', { name: 'Post comment' }));

    expect(await section().findByRole('status')).toHaveTextContent('Load more comments to see it');
    expect(contents()).toEqual(['Comment 1']);
  });

  it('prevents duplicate submissions while posting', async () => {
    const pending = deferred<MockReply>();
    const { api } = openTask('MEMBER', page([]), { [POST]: () => pending.promise });
    await ready();
    const formEl = section().getByRole('form', { name: 'Add a comment' });
    await userEvent.setup().type(within(formEl).getByLabelText('Add a comment'), 'Once');

    fireEvent.submit(formEl);
    fireEvent.submit(formEl);

    expect(await within(formEl).findByRole('button', { name: 'Posting…' })).toBeDisabled();
    expect(within(formEl).getByLabelText('Add a comment')).toHaveAttribute('readonly');
    expect(api.to(POST)).toHaveLength(1);
    pending.resolve({
      status: 201,
      body: { data: { comment: comment(5, ME, { content: 'Once' }) } },
    });
    expect(await section().findByText('Comment posted.')).toBeInTheDocument();
  });

  it.each([
    [
      apiError(
        409,
        'CONFLICT',
        'This project is archived. Its discussion is read-only until it is restored.',
      ),
      'archived',
    ],
    [apiError(503, 'SERVICE_UNAVAILABLE', 'x'), 'temporarily unavailable'],
    [new TypeError('Failed to fetch'), 'temporarily unavailable'],
  ])('keeps the text and explains failures safely (%#)', async (reply, message) => {
    openTask('MEMBER', page([]), { [POST]: reply });
    await ready();
    const form = within(section().getByRole('form', { name: 'Add a comment' }));
    const user = userEvent.setup();
    await user.type(form.getByLabelText('Add a comment'), 'Keep me');
    await user.click(form.getByRole('button', { name: 'Post comment' }));
    expect(await form.findByRole('alert')).toHaveTextContent(message);
    expect(form.getByLabelText('Add a comment')).toHaveValue('Keep me');
  });
});

describe('editing and deleting comments', () => {
  const mine = comment(1, ME, { content: 'My comment' });
  const theirs = comment(2, GRACE, { content: 'Their comment' });
  const item = (text: string) =>
    within(commentList())
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes(text))!;

  it('members get Edit/Delete only on their own comments', async () => {
    openTask('MEMBER', page([mine, theirs]));
    await ready();
    expect(within(item('My comment')).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(
      within(item('My comment')).getByRole('button', { name: 'Delete your comment' }),
    ).toBeInTheDocument();
    expect(within(item('Their comment')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('owners can delete anyone’s comment but edit only their own', async () => {
    openTask('OWNER', page([mine, theirs]));
    await ready();
    await waitFor(() =>
      expect(
        within(item('Their comment')).getByRole('button', { name: 'Delete this comment' }),
      ).toBeInTheDocument(),
    );
    expect(
      within(item('Their comment')).queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(within(item('My comment')).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('edits a comment with the version seen, and shows the update', async () => {
    const PATCH = `PATCH ${COMMENTS_PATH}/${mine.id}`;
    const { api } = openTask('MEMBER', page([mine, theirs]), {
      [PATCH]: {
        status: 200,
        body: {
          data: {
            comment: { ...mine, content: 'Better wording', updatedAt: '2026-11-03T13:00:00.000Z' },
          },
        },
      },
    });
    await ready();
    const user = userEvent.setup();
    await user.click(within(item('My comment')).getByRole('button', { name: 'Edit' }));
    const editor = within(section().getByRole('form', { name: 'Edit comment' }));
    expect(editor.getByLabelText('Edit comment')).toHaveValue('My comment');
    await user.clear(editor.getByLabelText('Edit comment'));
    await user.click(editor.getByRole('button', { name: 'Save' }));
    expect(editor.getByLabelText('Edit comment')).toHaveAccessibleDescription(
      'Comment is required',
    );
    expect(api.to(PATCH)).toHaveLength(0);

    await user.type(editor.getByLabelText('Edit comment'), ' Better wording ');
    await user.click(editor.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(contents()).toEqual(['Better wording', 'Their comment']));
    expect(section().getByRole('status')).toHaveTextContent('Comment updated.');
    expect(item('Better wording')).toHaveTextContent('edited');
    expect(api.to(PATCH)[0]!.body).toEqual({
      content: 'Better wording',
      expectedUpdatedAt: '2026-11-03T10:00:00.000Z',
    });
  });

  it('reports a stale edit and reloads the discussion', async () => {
    let version = 1;
    openTask(
      'MEMBER',
      () => (version === 1 ? page([mine]) : page([{ ...mine, content: 'Changed elsewhere' }])),
      {
        [`PATCH ${COMMENTS_PATH}/${mine.id}`]: apiError(
          409,
          'CONFLICT',
          'This comment was changed meanwhile. Reload the discussion to see the latest version.',
        ),
      },
    );
    await ready();
    const user = userEvent.setup();
    await user.click(within(item('My comment')).getByRole('button', { name: 'Edit' }));
    const editor = within(section().getByRole('form', { name: 'Edit comment' }));
    await user.type(editor.getByLabelText('Edit comment'), '!');
    await user.click(editor.getByRole('button', { name: 'Save' }));
    expect(await editor.findByRole('alert')).toHaveTextContent('changed meanwhile');

    version = 2;
    await user.click(editor.getByRole('button', { name: 'Reload discussion' }));
    await waitFor(() => expect(contents()).toEqual(['Changed elsewhere']));
  });

  it('disables the editor while saving and sends one request', async () => {
    const pending = deferred<MockReply>();
    const PATCH = `PATCH ${COMMENTS_PATH}/${mine.id}`;
    const { api } = openTask('MEMBER', page([mine]), { [PATCH]: () => pending.promise });
    await ready();
    await userEvent.setup().click(within(item('My comment')).getByRole('button', { name: 'Edit' }));
    const formEl = section().getByRole('form', { name: 'Edit comment' });

    fireEvent.submit(formEl);
    fireEvent.submit(formEl);

    expect(await within(formEl).findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(within(formEl).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(api.to(PATCH)).toHaveLength(1);
    pending.resolve({ status: 200, body: { data: { comment: mine } } });
    expect(await section().findByText('Comment updated.')).toBeInTheDocument();
  });

  it('deletes only after confirmation', async () => {
    const DELETE = `DELETE ${COMMENTS_PATH}/${mine.id}`;
    const { api } = openTask('MEMBER', page([mine, theirs]), {
      [DELETE]: { status: 200, body: { data: { deleted: true } } },
    });
    await ready();
    const user = userEvent.setup();

    await user.click(
      within(item('My comment')).getByRole('button', { name: 'Delete your comment' }),
    );
    const confirm = section().getByRole('group', { name: 'Confirm deleting this comment' });
    expect(confirm).toHaveTextContent('This cannot be undone.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(api.to(DELETE)).toHaveLength(0);

    await user.click(
      within(item('My comment')).getByRole('button', { name: 'Delete your comment' }),
    );
    await user.click(section().getByRole('button', { name: 'Delete comment' }));

    await waitFor(() => expect(contents()).toEqual(['Their comment']));
    expect(section().getByRole('status')).toHaveTextContent('Comment deleted.');
    expect(api.to(DELETE)[0]!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('lets an owner delete another member’s comment', async () => {
    const DELETE = `DELETE ${COMMENTS_PATH}/${theirs.id}`;
    const { api } = openTask('OWNER', page([theirs]), {
      [DELETE]: { status: 200, body: { data: { deleted: true } } },
    });
    await ready();
    const user = userEvent.setup();
    await user.click(
      await within(item('Their comment')).findByRole('button', { name: 'Delete this comment' }),
    );
    await user.click(section().getByRole('button', { name: 'Delete comment' }));
    expect(await section().findByText(/No comments yet\./)).toBeInTheDocument();
    expect(api.to(DELETE)).toHaveLength(1);
  });

  it('disables the controls while deleting and sends one request', async () => {
    const pending = deferred<MockReply>();
    const DELETE = `DELETE ${COMMENTS_PATH}/${mine.id}`;
    const { api } = openTask('MEMBER', page([mine]), { [DELETE]: () => pending.promise });
    await ready();
    await userEvent
      .setup()
      .click(within(item('My comment')).getByRole('button', { name: 'Delete your comment' }));
    const button = section().getByRole('button', { name: 'Delete comment' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(await section().findByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(api.to(DELETE)).toHaveLength(1);
    pending.resolve({ status: 200, body: { data: { deleted: true } } });
    expect(await section().findByText('Comment deleted.')).toBeInTheDocument();
  });

  it('keeps the comment and explains a refused delete', async () => {
    openTask('MEMBER', page([mine]), {
      [`DELETE ${COMMENTS_PATH}/${mine.id}`]: apiError(403, 'FORBIDDEN', 'internal'),
    });
    await ready();
    const user = userEvent.setup();
    await user.click(
      within(item('My comment')).getByRole('button', { name: 'Delete your comment' }),
    );
    await user.click(section().getByRole('button', { name: 'Delete comment' }));
    expect(await section().findByRole('alert')).toHaveTextContent(
      'You can only delete your own comments.',
    );
    expect(contents()).toEqual(['My comment']);
  });

  it('treats a 401 while deleting as signed out', async () => {
    const { router } = openTask('MEMBER', page([mine]), {
      [`DELETE ${COMMENTS_PATH}/${mine.id}`]: apiError(401, 'UNAUTHORIZED', 'x'),
    });
    await ready();
    const user = userEvent.setup();
    await user.click(
      within(item('My comment')).getByRole('button', { name: 'Delete your comment' }),
    );
    await user.click(section().getByRole('button', { name: 'Delete comment' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('archived projects', () => {
  it('show the discussion read-only: no form, no edit or delete controls', async () => {
    openTask('OWNER', page([comment(1, ME, { content: 'Mine' }), comment(2)]), {
      [PROJECT]: projectReply('ARCHIVED'),
    });
    await ready();
    expect(
      section().getByText('This project is archived, so the discussion is read-only.'),
    ).toBeInTheDocument();
    expect(contents()).toEqual(['Mine', 'Comment 2']);
    expect(section().queryByRole('form', { name: 'Add a comment' })).not.toBeInTheDocument();
    expect(section().queryByRole('button')).not.toBeInTheDocument();
  });
});

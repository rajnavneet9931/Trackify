import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, parsePath, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { routes } from '../app/routes';

export interface MockReply {
  status: number;
  body?: unknown;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

type Handler = MockReply | Error | ((request: RecordedRequest) => MockReply | Promise<MockReply>);

export const USER = {
  id: '01a14e56-78f6-7666-972e-c4fb2e19c643',
  email: 'ada@example.com',
  createdAt: '2026-10-18T09:27:32.342Z',
};

const DEFAULT_HANDLERS: Record<string, Handler> = {
  'GET /api/v1/health/ready': {
    status: 200,
    body: { data: { status: 'ready', checks: { database: 'up' }, timestamp: '' } },
  },
  'GET /api/v1/auth/me': {
    status: 401,
    body: { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
  },
  // The navigation's notification bell asks on every signed-in page.
  'GET /api/v1/notifications/unread-count': { status: 200, body: { data: { unreadCount: 0 } } },
  // The account page's profile section.
  'GET /api/v1/users/me': { status: 200, body: { data: { user: { ...USER, name: null } } } },
  // Loaded once per sign-in; the defaults (device time zone, browser date format).
  'GET /api/v1/users/me/settings': {
    status: 200,
    body: {
      data: {
        settings: {
          timeZone: null,
          dateFormat: 'LOCALE',
          notifications: { taskAssigned: true, taskCommented: true, taskReminder: true },
        },
      },
    },
  },
};

/**
 * Routes mocked fetch calls by "METHOD /path". A handler may be a reply, an
 * Error (simulates a network failure), a function, or an array consumed in
 * order (the last entry repeats). Every request is recorded.
 */
export function mockApi(handlers: Record<string, Handler | Handler[]> = {}) {
  const requests: RecordedRequest[] = [];
  const unmatched: string[] = [];
  const queues = new Map<string, Handler[]>();
  for (const [key, handler] of Object.entries({ ...DEFAULT_HANDLERS, ...handlers })) {
    queues.set(key, Array.isArray(handler) ? [...handler] : [handler]);
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      credentials: init?.credentials,
    };
    requests.push(request);

    const queue = queues.get(key);
    if (!queue) {
      unmatched.push(key);
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: key } }), {
        status: 404,
      });
    }
    const handler = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (handler instanceof Error) throw handler;
    const reply = typeof handler === 'function' ? await handler(request) : handler;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-test-1' },
    });
  });

  return {
    requests,
    unmatched,
    to: (key: string) => requests.filter((r) => `${r.method} ${r.path}` === key),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Renders the real route tree (with AuthProvider) at `path`, in StrictMode like main.tsx. */
export function renderApp(path: string, state?: unknown) {
  // parsePath: supports '?query' and '#fragment' in the path.
  const router = createMemoryRouter(routes, { initialEntries: [{ ...parsePath(path), state }] });
  const view = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return { ...view, router };
}

export const session = (csrfToken = 'csrf-1') => ({
  status: 200,
  body: { data: { user: USER, csrfToken, expiresAt: '2026-10-25T09:27:33.000Z' } },
});

export const apiError = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, details, requestId: 'req-test-1' } },
});

/** An empty project list (GET /workspaces/:id/projects), for page tests about other features. */
export const noProjects: MockReply = {
  status: 200,
  body: { data: { projects: [] }, meta: { limit: 20, nextCursor: null } },
};

/** An empty task list (GET …/projects/:id/tasks), for project page tests about other features. */
export const noTasks: MockReply = {
  status: 200,
  body: { data: { tasks: [] }, meta: { limit: 20, nextCursor: null } },
};

/** An empty discussion (GET …/tasks/:id/comments), for task page tests about other features. */
export const noComments: MockReply = {
  status: 200,
  body: { data: { comments: [] }, meta: { limit: 20, nextCursor: null } },
};

/** An empty activity history (GET …/tasks/:id/activities), for task page tests about other features. */
export const noActivities: MockReply = {
  status: 200,
  body: { data: { activities: [] }, meta: { limit: 20, nextCursor: null } },
};

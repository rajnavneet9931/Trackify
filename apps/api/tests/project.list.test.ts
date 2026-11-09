import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  decodeProjectCursor,
  encodeProjectCursor,
} from '../src/modules/projects/project-cursor.js';
import { ProjectStatus } from '../src/modules/projects/index.js';
import {
  buildTestApp,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableProjectRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const PROJECT_FIELDS = [
  'createdAt',
  'createdById',
  'description',
  'id',
  'name',
  'status',
  'updatedAt',
  'workspaceId',
];

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

async function setup(failing = false) {
  const users = new InMemoryUserRepository();
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository();
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: failing ? unreachableProjectRepository : projects,
  });
  const signUp = async (email: string): Promise<Account> => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      id: registered.body.data.user.id,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  return { app, workspaces, projects, signUp };
}

describe('GET /api/v1/workspaces/:workspaceId/projects', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let otherWs: string;

  const list = (requester: Account, workspaceId: string, query: Record<string, string> = {}) =>
    request(ctx.app)
      .get(`/api/v1/workspaces/${workspaceId}/projects`)
      .query(query)
      .set('Cookie', requester.cookie);

  /** Seeds projects directly: `count` rows, one second apart (newest last). */
  const seed = (workspaceId: string, count: number, start = Date.UTC(2026, 10, 1)) => {
    for (let i = 0; i < count; i++) {
      const at = new Date(start + i * 1000);
      ctx.projects.rows.push({
        id: `01a14e7b-cea3-700d-aeda-${String(ctx.projects.rows.length).padStart(12, '0')}`,
        workspaceId,
        name: `Project ${i}`,
        description: null,
        status: ProjectStatus.ACTIVE,
        createdById: owner.id,
        createdAt: at,
        updatedAt: at,
      });
    }
  };

  /** Follows nextCursor until the end and returns every page's project names. */
  const allPages = async (requester: Account, workspaceId: string, limit: number) => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const res = await list(requester, workspaceId, {
        limit: String(limit),
        ...(cursor && { cursor }),
      });
      expect(res.status).toBe(200);
      pages.push(res.body.data.projects.map((p: { id: string }) => p.id));
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    const createWorkspace = async (by: Account, name: string) =>
      (
        await request(ctx.app)
          .post('/api/v1/workspaces')
          .set('Cookie', by.cookie)
          .set('X-CSRF-Token', by.csrfToken)
          .send({ name })
      ).body.data.workspace.id as string;
    ws = await createWorkspace(owner, 'Team');
    otherWs = await createWorkspace(outsider, 'Elsewhere');
    ctx.workspaces.addMember(ws, member.id);
  });

  it.each([
    ['the owner', () => owner],
    ['a regular member', () => member],
  ])('lets %s list the projects, newest first, with safe fields only', async (_label, who) => {
    seed(ws, 3);

    const res = await list(who(), ws);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.meta).toEqual({ limit: 20, nextCursor: null });
    expect(res.body.data.projects.map((p: { name: string }) => p.name)).toEqual([
      'Project 2',
      'Project 1',
      'Project 0',
    ]);
    for (const project of res.body.data.projects) {
      expect(Object.keys(project).sort()).toEqual(PROJECT_FIELDS);
      expect(project.workspaceId).toBe(ws);
    }
  });

  it('needs no CSRF token for a GET', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/workspaces/${ws}/projects`)
      .set('Cookie', member.cookie);
    expect(res.status).toBe(200);
  });

  it('returns an empty list for a workspace without projects', async () => {
    const res = await list(owner, ws);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { projects: [] }, meta: { limit: 20, nextCursor: null } });
  });

  it('never returns projects from another workspace', async () => {
    seed(ws, 2);
    seed(otherWs, 3);

    const res = await list(owner, ws);

    expect(res.body.data.projects).toHaveLength(2);
    expect(res.body.data.projects.every((p: { workspaceId: string }) => p.workspaceId === ws)).toBe(
      true,
    );
  });

  it.each([
    ['an outsider', () => list(outsider, ws)],
    ['an unknown workspace', () => list(owner, UNKNOWN)],
  ])('answers %s with the same 404', async (_label, call) => {
    seed(ws, 1);
    const res = await call();
    const reference = await list(owner, UNKNOWN);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect({ ...res.body.error, requestId: 0 }).toEqual({ ...reference.body.error, requestId: 0 });
    expect(JSON.stringify(res.body)).not.toContain('Project');
  });

  it('defaults to 20 per page and allows at most 50', async () => {
    seed(ws, 60);

    const byDefault = await list(owner, ws);
    expect(byDefault.body.data.projects).toHaveLength(20);
    expect(byDefault.body.meta.limit).toBe(20);
    expect(byDefault.body.meta.nextCursor).toEqual(expect.any(String));

    const max = await list(owner, ws, { limit: '50' });
    expect(max.status).toBe(200);
    expect(max.body.data.projects).toHaveLength(50);
  });

  it.each([['0'], ['51'], ['-1'], ['1.5'], ['abc'], ['']])(
    'rejects limit=%j with 400',
    async (limit) => {
      const res = await list(owner, ws, { limit });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('rejects repeated or unknown query parameters', async () => {
    const path = `/api/v1/workspaces/${ws}/projects`;
    expect(
      (await request(ctx.app).get(`${path}?limit=1&limit=2`).set('Cookie', owner.cookie)).status,
    ).toBe(400);
    expect((await list(owner, ws, { offset: '10' })).status).toBe(400);
  });

  it('pages through every project exactly once, in order', async () => {
    seed(ws, 7);

    const pages = await allPages(owner, ws, 3);

    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    const ids = pages.flat();
    expect(new Set(ids).size).toBe(7);
    const expected = [...ctx.projects.rows].reverse().map((p) => p.id);
    expect(ids).toEqual(expected);
  });

  it('breaks timestamp ties by id, deterministically and without gaps', async () => {
    const same = Date.UTC(2026, 10, 2, 12);
    for (let i = 0; i < 5; i++) seed(ws, 1, same); // five projects, identical createdAt

    const first = await allPages(owner, ws, 2);
    const second = await allPages(owner, ws, 2);

    const expected = ctx.projects.rows
      .map((p) => p.id)
      .sort()
      .reverse(); // id DESC
    expect(first.flat()).toEqual(expected);
    expect(second).toEqual(first);
  });

  it('returns no nextCursor when the last page is exactly full', async () => {
    seed(ws, 4);
    const first = await list(owner, ws, { limit: '2' });
    const last = await list(owner, ws, { limit: '2', cursor: first.body.meta.nextCursor });

    expect(last.body.data.projects).toHaveLength(2);
    expect(last.body.meta.nextCursor).toBeNull();
  });

  it.each([
    ['not base64url', '!!!'],
    ['another list’s cursor', Buffer.from(`m1:${UNKNOWN}`).toString('base64url')],
    ['a missing id', Buffer.from('p1:1761955200000|').toString('base64url')],
    ['a bad id', Buffer.from('p1:1761955200000|not-a-uuid').toString('base64url')],
    ['a bad timestamp', Buffer.from(`p1:yesterday|${UNKNOWN}`).toString('base64url')],
    ['a negative timestamp', Buffer.from(`p1:-5|${UNKNOWN}`).toString('base64url')],
    [
      'an out-of-range timestamp',
      Buffer.from(`p1:99999999999999999|${UNKNOWN}`).toString('base64url'),
    ],
    ['extra segments', Buffer.from(`p1:1761955200000|${UNKNOWN}|x`).toString('base64url')],
    ['an over-long cursor', 'a'.repeat(201)],
  ])('rejects a cursor with %s (400, safe message)', async (_label, cursor) => {
    seed(ws, 3);
    const res = await list(owner, ws, { cursor });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|stack/i);
  });

  it('rejects a tampered cursor (edited bytes)', async () => {
    seed(ws, 3);
    const valid = (await list(owner, ws, { limit: '1' })).body.meta.nextCursor as string;
    const tampered = `${valid.slice(0, -2)}~~`;

    const res = await list(owner, ws, { limit: '1', cursor: tampered });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid pagination cursor');
  });

  it('a cursor from another workspace only positions within the requested one', async () => {
    seed(ws, 3);
    seed(otherWs, 3, Date.UTC(2026, 10, 5));
    const foreign = encodeProjectCursor({
      createdAt: new Date(Date.UTC(2026, 10, 5) + 2000),
      id: ctx.projects.rows.at(-1)!.id,
    });

    const res = await list(owner, ws, { cursor: foreign });

    expect(res.status).toBe(200);
    expect(res.body.data.projects).toHaveLength(3);
    expect(res.body.data.projects.every((p: { workspaceId: string }) => p.workspaceId === ws)).toBe(
      true,
    );
  });

  it('checks membership before the cursor: outsiders get 404 even with a bad cursor', async () => {
    expect((await list(outsider, ws, { cursor: '!!!' })).status).toBe(404);
  });

  it('shows newly created projects first on the next request', async () => {
    seed(ws, 2);
    const created = await request(ctx.app)
      .post(`/api/v1/workspaces/${ws}/projects`)
      .set('Cookie', owner.cookie)
      .set('X-CSRF-Token', owner.csrfToken)
      .send({ name: 'Brand new' });

    const res = await list(member, ws);
    expect(res.body.data.projects[0]).toMatchObject({
      id: created.body.data.project.id,
      name: 'Brand new',
    });
    expect(res.body.data.projects).toHaveLength(3);
  });

  it('requires a session and validates the workspace id', async () => {
    const path = `/api/v1/workspaces/${ws}/projects`;
    expect((await request(ctx.app).get(path)).status).toBe(401);
    expect((await list(owner, 'not-a-uuid')).status).toBe(400);
  });

  it('grants no CORS access to a foreign Origin', async () => {
    const res = await list(owner, ws).set('Origin', 'https://evil.example');
    // Read-only, like the other lists: the browser cannot read it cross-origin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup(true);
    const account = await failing.signUp('carol@example.com');
    const res = await request(failing.app)
      .get(`/api/v1/workspaces/${UNKNOWN}/projects`)
      .set('Cookie', account.cookie);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
  });
});

describe('project cursor codec', () => {
  it('round-trips the exact millisecond and id', () => {
    const position = { createdAt: new Date('2026-11-03T10:00:00.123Z'), id: UNKNOWN };
    expect(decodeProjectCursor(encodeProjectCursor(position))).toEqual(position);
  });

  it('is opaque (base64url, no raw id or timestamp)', () => {
    const cursor = encodeProjectCursor({ createdAt: new Date(0), id: UNKNOWN });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(UNKNOWN);
  });
});

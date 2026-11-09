/**
 * Project listing against the real, isolated test database: keyset pagination
 * (created_at DESC, id DESC), deterministic tie-breaking on equal timestamps,
 * workspace isolation and authorization. Rows are tagged with a per-run email
 * domain / workspace-name prefix and removed afterwards (workspaces first,
 * cascading to their projects, then users).
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { encodeProjectCursor } from '../../src/modules/projects/project-cursor.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} project list ${++counter}`;

interface Account {
  id: string;
  cookie: string;
}

interface ListedProject {
  id: string;
  workspaceId: string;
  name: string;
}

describe.skipIf(!TEST_DATABASE_URL)('project listing with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let owner: Account;
  let member: Account;
  let outsider: Account;

  const signUp = async (local: string): Promise<Account> => {
    const email = `${local}@${RUN_DOMAIN}`;
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      id: registered.body.data.user.id,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
    };
  };
  const workspaceWith = async (members: [Account, WorkspaceRole][]) => {
    const ws = await db.workspace.create({ data: { name: workspaceName() } });
    for (const [account, role] of members) {
      await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: account.id, role } });
    }
    return ws.id;
  };
  /** Inserts projects with explicit timestamps (one statement). */
  const seed = async (workspaceId: string, createdAts: Date[], prefix = 'P') => {
    await db.project.createMany({
      data: createdAts.map((createdAt, i) => ({
        workspaceId,
        createdById: owner.id,
        name: `${prefix}${i}`,
        createdAt,
      })),
    });
  };
  const list = (requester: Account, workspaceId: string, query: Record<string, string> = {}) =>
    request(app)
      .get(`/api/v1/workspaces/${workspaceId}/projects`)
      .query(query)
      .set('Cookie', requester.cookie);
  const allPages = async (requester: Account, workspaceId: string, limit: number) => {
    const pages: ListedProject[][] = [];
    let cursor: string | undefined;
    do {
      const res = await list(requester, workspaceId, {
        limit: String(limit),
        ...(cursor && { cursor }),
      });
      expect(res.status).toBe(200);
      pages.push(res.body.data.projects);
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };
  /** The documented order, computed by PostgreSQL itself. */
  const expectedOrder = async (workspaceId: string) =>
    (
      await db.project.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).map((p) => p.id);

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '5',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    owner = await signUp('owner');
    member = await signUp('member');
    outsider = await signUp('outsider');
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('owner and member page through every project exactly once, in the documented order', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const base = Date.UTC(2026, 10, 1);
    await seed(
      ws,
      Array.from({ length: 23 }, (_, i) => new Date(base + i * 60_000)),
    );
    const expected = await expectedOrder(ws);

    for (const who of [owner, member]) {
      const pages = await allPages(who, ws, 10);
      expect(pages.map((p) => p.length)).toEqual([10, 10, 3]);
      const ids = pages.flat().map((p) => p.id);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(23);
    }
    // Newest first.
    expect((await list(owner, ws, { limit: '1' })).body.data.projects[0].name).toBe('P22');
  }, 60_000);

  it('defaults to 20 per page and caps at 50', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const base = Date.UTC(2026, 10, 2);
    await seed(
      ws,
      Array.from({ length: 55 }, (_, i) => new Date(base + i * 1000)),
    );

    const byDefault = await list(owner, ws);
    expect(byDefault.body.data.projects).toHaveLength(20);
    expect(byDefault.body.meta).toEqual({ limit: 20, nextCursor: expect.any(String) });

    const max = await list(owner, ws, { limit: '50' });
    expect(max.body.data.projects).toHaveLength(50);
    expect(max.body.meta.nextCursor).toEqual(expect.any(String));

    expect((await list(owner, ws, { limit: '51' })).status).toBe(400);
  }, 60_000);

  it('orders equal timestamps by id DESC with no gaps or repeats across pages', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const same = new Date(Date.UTC(2026, 10, 3, 9, 30, 0, 123));
    await seed(
      ws,
      Array.from({ length: 7 }, () => same),
      'Tie',
    );
    await seed(ws, [new Date(same.getTime() + 1), new Date(same.getTime() - 1)], 'Edge');
    const expected = await expectedOrder(ws);

    const first = await allPages(owner, ws, 2);
    const second = await allPages(owner, ws, 3);

    expect(first.flat().map((p) => p.id)).toEqual(expected);
    expect(second.flat().map((p) => p.id)).toEqual(expected);
    const tied = first
      .flat()
      .filter((p) => p.name.startsWith('Tie'))
      .map((p) => p.id);
    expect(tied).toEqual([...tied].sort().reverse());
  }, 60_000);

  it('keeps workspaces isolated, even when given another workspace’s cursor', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const other = await workspaceWith([[outsider, 'OWNER']]);
    const base = Date.UTC(2026, 10, 4);
    await seed(ws, [new Date(base), new Date(base + 1000)], 'Mine');
    await seed(
      other,
      Array.from({ length: 5 }, (_, i) => new Date(base + 500 + i * 1000)),
      'Theirs',
    );

    const mine = await allPages(owner, ws, 1);
    expect(mine.flat().map((p) => p.name)).toEqual(['Mine1', 'Mine0']);
    expect(mine.flat().every((p) => p.workspaceId === ws)).toBe(true);

    // A real cursor from the other workspace, replayed against this one.
    const foreignCursor = (await list(outsider, other, { limit: '1' })).body.meta.nextCursor;
    const replay = await list(owner, ws, { cursor: foreignCursor });
    expect(replay.status).toBe(200);
    expect(replay.body.data.projects.every((p: ListedProject) => p.workspaceId === ws)).toBe(true);

    // And a forged position far in the future still only yields this workspace.
    const forged = encodeProjectCursor({ createdAt: new Date(base + 10 ** 9), id: randomUUID() });
    const forgedRes = await list(owner, ws, { cursor: forged });
    expect(forgedRes.body.data.projects.map((p: ListedProject) => p.name)).toEqual([
      'Mine1',
      'Mine0',
    ]);
  }, 60_000);

  it('refuses outsiders and unknown workspaces with the same 404', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    await seed(ws, [new Date()], 'Secret');

    const byOutsider = await list(outsider, ws);
    const unknown = await list(owner, randomUUID());

    expect([byOutsider.status, unknown.status]).toEqual([404, 404]);
    expect({ ...byOutsider.body.error, requestId: 0 }).toEqual({
      ...unknown.body.error,
      requestId: 0,
    });
    expect(JSON.stringify(byOutsider.body)).not.toContain('Secret');
  }, 60_000);

  it('returns an empty list for a workspace without projects', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const res = await list(owner, ws);
    expect(res.body).toEqual({ data: { projects: [] }, meta: { limit: 20, nextCursor: null } });
  }, 60_000);

  it('rejects malformed cursors without touching the data', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    for (const cursor of ['!!!', Buffer.from('p1:abc|def').toString('base64url')]) {
      const res = await list(owner, ws, { cursor });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|P20/i);
    }
  }, 60_000);

  it('shows a newly created project first on the next request; exposes only safe fields', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    await seed(ws, [new Date(Date.UTC(2026, 0, 1))], 'Old');
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `owner@${RUN_DOMAIN}`, password: PASSWORD });
    const created = await request(app)
      .post(`/api/v1/workspaces/${ws}/projects`)
      .set('Cookie', ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!)
      .set('X-CSRF-Token', login.body.data.csrfToken)
      .send({ name: 'Fresh', description: 'Just made' });
    expect(created.status).toBe(201);

    const res = await list(member, ws);
    expect(res.body.data.projects.map((p: ListedProject) => p.name)).toEqual(['Fresh', 'Old0']);
    expect(Object.keys(res.body.data.projects[0]).sort()).toEqual([
      'createdAt',
      'createdById',
      'description',
      'id',
      'name',
      'status',
      'updatedAt',
      'workspaceId',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/password|token|email|session/i);
  }, 60_000);
});

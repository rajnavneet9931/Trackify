/**
 * Task search, filtering and sorting against the real, isolated test database:
 * PostgreSQL's own semantics (ILIKE, enum order, collation, NULLS LAST) must
 * agree with the keyset conditions so pages never overlap or skip, filters
 * combine correctly, wildcards in a search are literal, and everything stays
 * scoped to the requested project. Rows are tagged with a per-run email domain
 * / workspace-name prefix and removed afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} search ${++counter}`;
const HOUR = 3_600_000;

interface Account {
  id: string;
  cookie: string;
}

type Row = {
  title: string;
  description?: string | null;
  status?: 'TODO' | 'IN_PROGRESS' | 'DONE';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  assigneeId?: string | null;
  dueDate?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

describe.skipIf(!TEST_DATABASE_URL)('task search with real PostgreSQL', () => {
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
  const newProject = async (workspaceId: string) =>
    (await db.project.create({ data: { workspaceId, name: 'P', createdById: owner.id } })).id;
  const seed = (projectId: string, rows: Row[]) =>
    db.task.createMany({
      data: rows.map((r, i) => ({
        projectId,
        createdById: owner.id,
        createdAt: r.createdAt ?? new Date(Date.UTC(2026, 10, 1) + i * 60_000),
        updatedAt: r.updatedAt ?? new Date(Date.UTC(2026, 10, 1) + i * 60_000),
        ...r,
      })),
    });
  const list = (who: Account, ws: string, p: string, query: Record<string, string> = {}) =>
    request(app)
      .get(`/api/v1/workspaces/${ws}/projects/${p}/tasks`)
      .query(query)
      .set('Cookie', who.cookie);
  const titles = async (ws: string, p: string, query: Record<string, string>) => {
    const res = await list(member, ws, p, { limit: '50', ...query });
    expect(res.status).toBe(200);
    return res.body.data.tasks.map((t: { title: string }) => t.title) as string[];
  };
  const allPages = async (ws: string, p: string, query: Record<string, string>, limit: number) => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await list(member, ws, p, {
        ...query,
        limit: String(limit),
        ...(cursor && { cursor }),
      });
      expect(res.status).toBe(200);
      ids.push(...res.body.data.tasks.map((t: { id: string }) => t.id));
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  };

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

  it('searches title and description case-insensitively, with literal % and _', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    await seed(project, [
      { title: 'Login API' },
      { title: 'Docs', description: 'Explain the LOGIN flow' },
      { title: 'Reach 50% coverage' },
      { title: 'Rename user_name column' },
      { title: 'Username field' },
      { title: String.raw`Fix C:\temp path` }, // a literal backslash
    ]);

    expect((await titles(ws, project, { search: 'login' })).sort()).toEqual(['Docs', 'Login API']);
    expect(await titles(ws, project, { search: '50%' })).toEqual(['Reach 50% coverage']);
    expect(await titles(ws, project, { search: '%' })).toEqual(['Reach 50% coverage']);
    expect(await titles(ws, project, { search: 'user_' })).toEqual(['Rename user_name column']);
    expect(await titles(ws, project, { search: String.raw`C:\temp` })).toEqual([
      String.raw`Fix C:\temp path`,
    ]);
    expect(await titles(ws, project, { search: '\\' })).toEqual([String.raw`Fix C:\temp path`]);
    expect(await titles(ws, project, { search: 'zzz' })).toEqual([]);
  }, 60_000);

  it('combines filters (status, priority, assignee, unassigned, overdue, due range)', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const now = Date.now();
    await seed(project, [
      { title: 'Late', dueDate: new Date(now - HOUR), priority: 'HIGH', assigneeId: member.id },
      { title: 'Late done', dueDate: new Date(now - HOUR), status: 'DONE', priority: 'HIGH' },
      { title: 'Soon', dueDate: new Date(now + 3 * HOUR), status: 'IN_PROGRESS' },
      { title: 'Undated', priority: 'LOW' },
    ]);

    expect(await titles(ws, project, { overdue: 'true' })).toEqual(['Late']);
    expect((await titles(ws, project, { priority: 'HIGH' })).sort()).toEqual(['Late', 'Late done']);
    expect(await titles(ws, project, { priority: 'HIGH', status: 'DONE' })).toEqual(['Late done']);
    expect(await titles(ws, project, { assigneeId: member.id })).toEqual(['Late']);
    expect((await titles(ws, project, { unassigned: 'true' })).sort()).toEqual([
      'Late done',
      'Soon',
      'Undated',
    ]);
    expect(await titles(ws, project, { dueDate: 'none' })).toEqual(['Undated']);
    expect(
      await titles(ws, project, {
        dueAfter: new Date(now).toISOString(),
        dueBefore: new Date(now + 24 * HOUR).toISOString(),
      }),
    ).toEqual(['Soon']);
    const total = await list(member, ws, project, { unassigned: 'true', priority: 'LOW' });
    expect(total.body.meta.total).toBe(1);
  }, 60_000);

  it('PostgreSQL order agrees with the keyset for every sort field and direction', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
    const titlesPool = [
      'alpha',
      'Beta',
      'beta',
      'Gamma',
      'delta',
      'Échec',
      'zeta',
      '10 items',
      '9 items',
    ];
    const rows: Row[] = Array.from({ length: 27 }, (_, i) => ({
      title: titlesPool[i % titlesPool.length]!,
      priority: priorities[i % 4]!,
      dueDate: i % 3 === 0 ? null : new Date(Date.UTC(2026, 11, 1 + (i % 4))),
      updatedAt: new Date(Date.UTC(2026, 11, 1, i % 5)), // plenty of ties
    }));
    await seed(project, rows);

    for (const sortBy of ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title']) {
      for (const sortOrder of ['asc', 'desc']) {
        const query = { sortBy, sortOrder };
        const full = (await list(member, ws, project, { ...query, limit: '50' })).body.data.tasks;
        const paged = await allPages(ws, project, query, 4);
        expect(paged, `${sortBy} ${sortOrder}`).toEqual(full.map((t: { id: string }) => t.id));
        expect(new Set(paged).size).toBe(27);

        if (sortBy === 'dueDate') {
          // Undated tasks last in both directions.
          const firstUndated = full.findIndex(
            (t: { dueDate: string | null }) => t.dueDate === null,
          );
          expect(
            full.slice(firstUndated).every((t: { dueDate: string | null }) => t.dueDate === null),
          ).toBe(true);
        }
        if (sortBy === 'priority') {
          const ranks = full.map((t: { priority: string }) =>
            priorities.indexOf(t.priority as never),
          );
          const sorted = [...ranks].sort((a, b) => (sortOrder === 'asc' ? a - b : b - a));
          expect(ranks).toEqual(sorted);
        }
      }
    }
  }, 240_000);

  it('pages correctly with search + filters + sort combined', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    await seed(
      project,
      Array.from({ length: 20 }, (_, i) => ({
        title: i % 2 ? `Bug ${i}` : `Chore ${i}`,
        priority: (['LOW', 'HIGH'] as const)[i % 4 < 2 ? 0 : 1],
        dueDate: i % 5 === 0 ? null : new Date(Date.UTC(2026, 11, 1 + (i % 3))),
      })),
    );
    const query = { search: 'BUG', priority: 'HIGH', sortBy: 'dueDate', sortOrder: 'asc' };
    const full = await titles(ws, project, query);
    expect(full.length).toBeGreaterThan(0);
    expect(full.every((t) => t.startsWith('Bug'))).toBe(true);
    const paged = await allPages(ws, project, query, 2);
    expect(paged).toHaveLength(full.length);
    expect(new Set(paged).size).toBe(full.length);
  }, 120_000);

  it('stays scoped to the project and workspace; archived projects stay searchable', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const sibling = await newProject(ws);
    const foreign = await newProject(otherWs);
    await seed(project, [{ title: 'Mine' }]);
    await seed(sibling, [{ title: 'Sibling secret' }]);
    await seed(foreign, [{ title: 'Foreign secret' }]);

    expect(await titles(ws, project, { search: 'secret' })).toEqual([]);
    expect((await list(outsider, ws, project, { search: 'mine' })).status).toBe(404);
    expect((await list(member, ws, foreign, { search: 'secret' })).status).toBe(404);

    await db.project.update({ where: { id: project }, data: { status: 'ARCHIVED' } });
    expect(await titles(ws, project, { search: 'MINE' })).toEqual(['Mine']);
  }, 60_000);
});
